#!/bin/bash
# Post the review-gate commit status on one head commit, only when it changes.
#
# Usage: post-status.sh <sha> <success|failure|error|pending> <description>
# Environment: GITHUB_REPOSITORY (owner/name), STATUS_CONTEXT (default review-gate),
# RUN_URL (target_url of the status), GITHUB_SERVER_URL (default https://github.com),
# STATUS_QUOTA_GUARD (default 900), EVAL_STARTED (when the evaluation behind a verdict
# began, ISO 8601 UTC), GITHUB_RUN_ID (this run).
#
# Every status review-gate.yml posts goes through this script, for three reasons.
#
# GitHub accepts at most 1000 statuses per commit and context and refuses the rest, leaving
# the last one standing. Anyone can fire the events that re-run the gate (a PR comment is
# enough), so a gate that posted on every run could be driven to the cap with a `success`
# on top, after which no finding could turn it red. So a status is posted only when its
# state or description differs from the current one, and once the context holds
# STATUS_QUOTA_GUARD statuses on the commit a `success` is posted as `error` instead: near
# the cap the last word must be one that blocks. A refused POST fails the caller loudly.
#
# `pending` invalidates a success when an event arrives: it is posted only over a current
# `success` (a blocking status needs no invalidation), so it costs a status only when the
# head was mergeable. A `success` is not posted when any review-gate run other than this one
# and other than the sweep was created after EVAL_STARTED: that run belongs to an event this
# evaluation did not see (a new finding, or a resolve that failed), and its own evaluation,
# or the next sweep, posts the verdict. If the current status is a success, `pending` is
# posted in its place. A run for another PR also defers this success; the next sweep, which
# defers to no other sweep, posts it.
#
# A blocking status (failure, error, pending) is always safe to post, so it is posted even
# when the status list cannot be read. A success that cannot be checked is not posted.
#
# A `success` this workflow did not post (another account, another integration, or another
# workflow run's URL) is not the gate's verdict. When the current status is such a success,
# the real verdict is posted even if it is the same state, so the latest status on the
# commit is the gate's own. This does not stop someone holding push access or the owner's
# token: they can post again, or edit the ruleset (AGENTS.md, "Merge Gate").
set -euo pipefail

sha=${1:?usage: post-status.sh <sha> <state> <description>}
state=${2:?usage: post-status.sh <sha> <state> <description>}
desc=${3:-}
desc=${desc:0:140}
ctx=${STATUS_CONTEXT:-review-gate}
guard=${STATUS_QUOTA_GUARD:-900}
server=${GITHUB_SERVER_URL:-https://github.com}
repo=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must name owner/name}

[[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo "post-status: '$sha' is not a commit sha" >&2; exit 2; }
case "$state" in success | failure | error | pending) ;; *)
  echo "post-status: '$state' is not success, failure, error or pending" >&2; exit 2 ;;
esac

# Every status of this context on the commit, newest first (the list endpoint carries the
# creator, the combined one does not). The first is the current one; the count is what the
# quota guard reads.
list_ok=1
all=$(gh api --paginate "repos/$repo/commits/$sha/statuses?per_page=100" \
  --jq ".[] | select(.context == \"$ctx\")
        | [.state, (.description // \"\"), (.creator.login // \"\"), (.target_url // \"\")]
        | map(gsub(\"[\\u001f\\n]\"; \" \")) | join(\"\\u001f\")") || list_ok=0
if [ "$list_ok" = 0 ]; then
  if [ "$state" = success ]; then
    echo "::error::could not read the $ctx statuses on ${sha:0:9}; a success that cannot be checked is not posted"
    exit 1
  fi
  echo "::warning::could not read the $ctx statuses on ${sha:0:9}; posting the blocking $state anyway"
  all=""
fi
current=$(sed -n 1p <<<"$all")
count=$(grep -c . <<<"$all" || true)
# A non-whitespace separator: with a tab, read would merge empty fields.
cur_state="" cur_desc="" cur_creator="" cur_url=""
[ -z "$current" ] || IFS=$'\x1f' read -r cur_state cur_desc cur_creator cur_url <<<"$current"

forged=0
if [ "${cur_state:-}" = success ]; then
  run_id=$(sed -n "s#^$server/$repo/actions/runs/\([0-9][0-9]*\).*#\1#p" <<<"${cur_url:-}")
  origin=""
  if [ -n "$run_id" ]; then
    # The run that posted it: this workflow file, on an event that runs it from the default
    # branch. A branch that edits review-gate.yml to run on push, or dispatches it from
    # another ref, does not qualify.
    origin=$(gh api "repos/$repo/actions/runs/$run_id" \
      --jq '"\(.path // "")|\(.event // "")|\(.head_branch // "")"' 2>/dev/null || true)
  fi
  ours=0
  case "$origin" in
    .github/workflows/review-gate.yml*"|pull_request_target|"* | \
    .github/workflows/review-gate.yml*"|issue_comment|"* | \
    .github/workflows/review-gate.yml*"|workflow_run|"* | \
    .github/workflows/review-gate.yml*"|schedule|"* | \
    .github/workflows/review-gate.yml*"|workflow_dispatch|main") ours=1 ;;
  esac
  if [ "${cur_creator:-}" != "github-actions[bot]" ] || [ "$ours" = 0 ]; then
    forged=1
    echo "::warning::$ctx on ${sha:0:9} is a success this workflow did not post (creator ${cur_creator:-none}); posting the gate's verdict over it"
  fi
fi

if [ "$state" = pending ] && [ "${cur_state:-}" != success ]; then
  echo "$ctx on ${sha:0:9} is ${cur_state:-unset}, which already blocks; no pending posted"
  exit 0
fi
if [ "$state" = success ] && [ -n "${EVAL_STARTED:-}" ]; then
  # Runs of this workflow created after the evaluation began, other than this run and the
  # sweep. A list that cannot be read counts as a newer run: the success waits.
  newer=$(gh api "repos/$repo/actions/workflows/review-gate.yml/runs?per_page=100&created=%3E%3D$EVAL_STARTED" \
    --jq "[.workflow_runs[] | select((.id | tostring) != \"${GITHUB_RUN_ID:-}\" and .event != \"schedule\"
                                     and .created_at >= \"$EVAL_STARTED\")] | length" || echo unreadable)
  if [ "$newer" != 0 ]; then
    echo "$ctx on ${sha:0:9}: $newer newer review-gate run(s) since $EVAL_STARTED; not posting this success"
    if [ "${cur_state:-}" != success ]; then exit 0; fi
    state=pending
    desc="Re-evaluating after a newer event"
  fi
fi
if [ "$forged" = 0 ] && [ "${cur_state:-}" = "$state" ] && [ "${cur_desc:-}" = "$desc" ]; then
  echo "$ctx on ${sha:0:9} is already $state: $desc"
  exit 0
fi

if [ "$state" = success ]; then
  if [ "$count" -ge "$guard" ]; then
    state=error
    desc="This commit has $count $ctx statuses, near GitHub's cap of 1000; push a new commit"
    desc=${desc:0:140}
    if [ "$forged" = 0 ] && [ "${cur_state:-}" = "$state" ] && [ "${cur_desc:-}" = "$desc" ]; then
      echo "$ctx on ${sha:0:9} is already $state: $desc"
      exit 0
    fi
  fi
fi

if ! gh api -X POST "repos/$repo/statuses/$sha" \
  -f state="$state" -f context="$ctx" -f target_url="${RUN_URL:-}" -f description="$desc" >/dev/null; then
  echo "::error::GitHub refused the $ctx=$state status on ${sha:0:9}; the status on that commit is stale"
  exit 1
fi
echo "posted $ctx=$state on ${sha:0:9}: $desc"
