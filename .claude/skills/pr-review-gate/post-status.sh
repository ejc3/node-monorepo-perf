#!/bin/bash
# Post the review-gate commit status on one head commit, only when it changes.
#
# Usage: post-status.sh <sha> <success|failure|error|pending> <description>
# Environment: GITHUB_REPOSITORY (owner/name), STATUS_CONTEXT (default review-gate),
# RUN_URL (target_url of the status), GITHUB_SERVER_URL (default https://github.com),
# STATUS_QUOTA_GUARD (default 900), GITHUB_RUN_ID (this run), and for a success:
# EVAL_STARTED (when the evaluation began reading the PRs, ISO 8601 UTC) and PRS (the
# space-separated numbers of the open PRs whose head is <sha>).
#
# Every status review-gate.yml posts goes through this script. The rule it enforces:
#
#   A success is posted only when, read right before the POST, nothing has changed since
#   the evaluation's snapshot. Anything else posts a blocking state; it never skips.
#
# For a success that means: the statuses on the commit can be read; no review-gate status
# other than a success was posted after EVAL_STARTED (another run's error or pending); no
# review-gate run other than this one and the sweep was created after EVAL_STARTED; and for
# each PR in PRS the PR can be read, its head is still <sha>, and no activity on it (the PR's
# own updatedAt, any comment, review, or review-thread comment created, updated or edited)
# is newer than EVAL_STARTED. A read that fails posts `error`; a newer signal posts
# `pending`, and the run that answers that signal (or the next sweep) posts the verdict.
#
# Quota: GitHub accepts at most 1000 statuses per commit and context and refuses the rest,
# leaving the last one standing, and anyone can fire the events that re-run the gate. So a
# state is posted only when it or its description differs from the current one, `pending`
# only over a current `success` (a blocking status needs no invalidation), and once the
# context holds STATUS_QUOTA_GUARD statuses a `success` is posted as `error`. A refused
# POST fails the caller loudly.
#
# A `success` this workflow did not post (another account, another integration, or another
# workflow run) is not the gate's verdict; when the current status is one, the gate's
# verdict is posted over it even if it is the same state. This does not stop someone who
# holds push access or the owner's token (AGENTS.md, "Merge Gate").
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
        | [.state, (.description // \"\"), (.creator.login // \"\"), (.target_url // \"\"), (.created_at // \"\")]
        | map(gsub(\"[\\u001f\\n]\"; \" \")) | join(\"\\u001f\")") || list_ok=0
if [ "$list_ok" = 0 ]; then
  # Nothing about the current status is known, so nothing is skipped: a success becomes an
  # error, and any blocking state is posted as asked.
  if [ "$state" = success ]; then
    state=error
    desc="Could not read the statuses to verify a success; see the run"
  fi
  echo "::warning::could not read the $ctx statuses on ${sha:0:9}; posting $state without comparing"
  if ! gh api -X POST "repos/$repo/statuses/$sha" \
    -f state="$state" -f context="$ctx" -f target_url="${RUN_URL:-}" -f description="${desc:0:140}" >/dev/null; then
    echo "::error::GitHub refused the $ctx=$state status on ${sha:0:9}; the status on that commit is stale"
    exit 1
  fi
  echo "posted $ctx=$state on ${sha:0:9}: ${desc:0:140}"
  exit 0
fi
current=$(sed -n 1p <<<"$all")
count=$(grep -c . <<<"$all" || true)
# A non-whitespace separator: with a tab, read would merge empty fields.
cur_state="" cur_desc="" cur_creator="" cur_url=""
[ -z "$current" ] || IFS=$'\x1f' read -r cur_state cur_desc cur_creator cur_url _ <<<"$current"

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

# The success rule. Each check either passes or turns the success into a blocking state.
block() { state=$1; desc=$2; echo "$ctx on ${sha:0:9}: not posting success: $desc"; }
if [ "$state" = success ]; then
  if [[ ! ${EVAL_STARTED:-} =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
     || [ -z "${PRS:-}" ] || [ -z "${PRS// /}" ]; then
    block error "No evaluation snapshot (EVAL_STARTED, PRS) to verify a success against"
  fi
fi
if [ "$state" = success ]; then
  # Another run's blocking status posted after this evaluation began. EVAL_STARTED is whole
  # seconds and so are GitHub's timestamps, so the same second counts as after.
  newer_block=$(awk -F "$(printf '\037')" -v t="$EVAL_STARTED" '$5 >= t && $1 != "success"' <<<"$all" | grep -c . || true)
  if [ "$newer_block" -gt 0 ]; then
    block pending "A blocking status was posted after this evaluation began"
  fi
fi
if [ "$state" = success ]; then
  # Runs of this workflow created after the evaluation began, other than this run and the
  # sweep. A list that cannot be read is a failed read.
  if ! newer=$(gh api "repos/$repo/actions/workflows/review-gate.yml/runs?per_page=100&created=%3E%3D$EVAL_STARTED" \
      --jq "[.workflow_runs[] | select((.id | tostring) != \"${GITHUB_RUN_ID:-}\" and .event != \"schedule\"
                                       and .created_at >= \"$EVAL_STARTED\")] | length"); then
    block error "Could not read the review-gate runs to verify a success; see the run"
  elif [ "$newer" != 0 ]; then
    block pending "Re-evaluating after a newer event"
  fi
fi
if [ "$state" = success ]; then
  # The PRs themselves: head unchanged, nothing newer than the snapshot.
  for pr in ${PRS:-}; do
    [[ $pr =~ ^[0-9]+$ ]] || { block error "Not a PR number: ${pr:0:20}"; break; }
    if ! act=$(gh api graphql -F n="$pr" -f o="${repo%%/*}" -f r="${repo#*/}" -f query='
        query($o: String!, $r: String!, $n: Int!) { repository(owner: $o, name: $r) {
          pullRequest(number: $n) { headRefOid updatedAt
            comments(last: 100) { nodes { createdAt updatedAt lastEditedAt } }
            reviews(last: 100) { nodes { submittedAt updatedAt lastEditedAt } }
            reviewThreads(last: 100) { nodes { comments(last: 1) { nodes { createdAt updatedAt lastEditedAt } } } } } } }' \
        --jq '.data.repository.pullRequest
              | if . == null then "unreadable"
                else .headRefOid + " "
                     + ([.updatedAt, (.comments.nodes[] | .createdAt, .updatedAt, .lastEditedAt),
                         (.reviews.nodes[] | .submittedAt, .updatedAt, .lastEditedAt),
                         (.reviewThreads.nodes[].comments.nodes[] | .createdAt, .updatedAt, .lastEditedAt)]
                        | map(select(. != null)) | max // "none") end') || [ "$act" = unreadable ]; then
      block error "Could not read PR #$pr to verify a success; see the run"
      break
    fi
    read -r act_head act_last <<<"$act"
    if [ "$act_head" != "$sha" ]; then
      block pending "PR #$pr moved off this commit"
      break
    fi
    if [[ $act_last > $EVAL_STARTED || $act_last == "$EVAL_STARTED" ]]; then
      block pending "Re-evaluating: PR #$pr has activity after the snapshot"
      break
    fi
  done
fi
desc=${desc:0:140}

if [ "$forged" = 0 ] && [ "${cur_state:-}" = "$state" ] && [ "${cur_desc:-}" = "$desc" ]; then
  echo "$ctx on ${sha:0:9} is already $state: $desc"
  exit 0
fi

if [ "$state" = success ] && [ "$count" -ge "$guard" ]; then
  state=error
  desc="This commit has $count $ctx statuses, near GitHub's cap of 1000; push a new commit"
  desc=${desc:0:140}
  if [ "$forged" = 0 ] && [ "${cur_state:-}" = "$state" ] && [ "${cur_desc:-}" = "$desc" ]; then
    echo "$ctx on ${sha:0:9} is already $state: $desc"
    exit 0
  fi
fi

if ! gh api -X POST "repos/$repo/statuses/$sha" \
  -f state="$state" -f context="$ctx" -f target_url="${RUN_URL:-}" -f description="$desc" >/dev/null; then
  echo "::error::GitHub refused the $ctx=$state status on ${sha:0:9}; the status on that commit is stale"
  exit 1
fi
echo "posted $ctx=$state on ${sha:0:9}: $desc"
