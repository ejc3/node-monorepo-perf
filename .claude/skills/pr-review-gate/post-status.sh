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
# review-gate run other than this one that can evaluate this head (its title names the sha,
# a PR on it or its branch, or names nothing parsable, as a scheduled sweep's does) was
# created after EVAL_STARTED; and for
# each PR in PRS the PR can be read, its head is still <sha>, and no activity on it (the PR's
# own updatedAt, any comment, review, or review-thread comment created, updated or edited)
# is newer than EVAL_STARTED. Every list is read to its last page and checked against its
# total count. A read that fails posts `error`; a newer signal, or a list that holds fewer
# items than its total, posts `pending`, and the run that answers that signal (or the next
# sweep) posts the verdict.
#
# Quota: GitHub accepts at most 1000 statuses per commit and context and refuses the rest,
# leaving the last one standing, and anyone can fire the events that re-run the gate. So a
# state is posted only when it or its description differs from the current one, `pending`
# only over a current `success` (a blocking status needs no invalidation), and once the
# context holds STATUS_QUOTA_GUARD statuses a `success` is posted as `error`. A refused
# POST fails the caller loudly.
#
# The success POST cannot be conditional on the reads before it, so after it the same checks
# run again on fresh reads. If any of them now fails (a blocking status, a newer run, PR
# activity, a moved head, or a read that fails), the blocking state is posted over the
# success at once, with the description prefixed "Raced a success:". The newest status is
# then blocking again; the run or sweep that owns the newer signal posts the verdict.
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
read_statuses() {
  gh api --paginate "repos/$repo/commits/$sha/statuses?per_page=100" \
    --jq ".[] | select(.context == \"$ctx\")
          | [.state, (.description // \"\"), (.creator.login // \"\"), (.target_url // \"\"), (.created_at // \"\")]
          | map(gsub(\"[\\u001f\\n]\"; \" \")) | join(\"\\u001f\")"
}
list_ok=1
all=$(read_statuses) || list_ok=0
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

# Every list below is read to the end, and a list that holds fewer items than its total
# count is incomplete. One page of 100 used to be read and trusted: a newer run, a comment
# edited, or a reply added past the first page was never seen, and a stale evaluation posted
# success. A page that fails is a failed read (error); an incomplete list is a signal this
# script cannot see past (pending).
#
# list_sum: input lines "T <total>", "N <items on a page>", "D <date>", "X" (unreadable) or
# "I" (an inner list was cut short), from every page of one list. Prints the newest date or
# "none"; returns 1 for an unreadable list and 3 for an incomplete one.
list_sum() {
  awk '$1 == "X" { bad = 1 } $1 == "I" { cut = 1 } $1 == "T" { t = $2; seen = 1 } $1 == "N" { n += $2 }
       $1 == "D" && $2 > max { max = $2 }
       END { if (bad || !seen) exit 1; if (cut || n < t) exit 3; print (max == "" ? "none" : max) }'
}
# pr_activity <pr>: "<head> <branch> <newest activity>" for one PR, reading its head, then
# every top-level comment, every review, and every comment of every review thread (a thread's
# last comment alone missed an edit to the finding above it). The threads query carries the
# first 100 comments of each thread; a thread holding more ("P <id>") is read again by its
# node id from its first page to its last, the way check-review-threads.sh pages an oversized
# thread, and summed as its own list; one without a usable id stays incomplete ("I"). Returns 1
# when a read fails and 3 when a list is incomplete.
pr_activity() {
  local pr=$1 head out newest rc d kind i=0 tids=""
  local -a q=(-F n="$pr" -f o="${repo%%/*}" -f r="${repo#*/}") todo=(comments reviews threads)
  head=$(gh api graphql "${q[@]}" -f query='
    # q:head
    query($o: String!, $r: String!, $n: Int!) { repository(owner: $o, name: $r) {
      pullRequest(number: $n) { headRefOid headRefName updatedAt } } }' \
    --jq '.data.repository.pullRequest
          | if . == null or (.headRefOid | type) != "string" then "X"
            else .headRefOid + " " + (.headRefName // "?" | if test("^[^[:space:]]+$") then . else "?" end)
                 + " " + (.updatedAt // "none") end') || return 1
  [ "$head" != X ] || return 1
  newest=${head##* }
  while [ "$i" -lt "${#todo[@]}" ]; do
    kind=${todo[$i]}; i=$((i + 1))
    case $kind in
      comments) out=$(gh api graphql --paginate "${q[@]}" -f query='
          # q:comments
          query($o: String!, $r: String!, $n: Int!, $endCursor: String) { repository(owner: $o, name: $r) {
            pullRequest(number: $n) { comments(first: 100, after: $endCursor) { totalCount
              pageInfo { hasNextPage endCursor } nodes { createdAt updatedAt lastEditedAt } } } } }' \
          --jq '.data.repository.pullRequest.comments
                | if . == null or (.totalCount | type) != "number" or (.nodes | type) != "array" then "X" else "T \(.totalCount)", "N \(.nodes | length)",
                  (.nodes[] | .createdAt, .updatedAt, .lastEditedAt | select(. != null) | "D \(.)") end') || return 1 ;;
      reviews) out=$(gh api graphql --paginate "${q[@]}" -f query='
          # q:reviews
          query($o: String!, $r: String!, $n: Int!, $endCursor: String) { repository(owner: $o, name: $r) {
            pullRequest(number: $n) { reviews(first: 100, after: $endCursor) { totalCount
              pageInfo { hasNextPage endCursor } nodes { submittedAt updatedAt lastEditedAt } } } } }' \
          --jq '.data.repository.pullRequest.reviews
                | if . == null or (.totalCount | type) != "number" or (.nodes | type) != "array" then "X" else "T \(.totalCount)", "N \(.nodes | length)",
                  (.nodes[] | .submittedAt, .updatedAt, .lastEditedAt | select(. != null) | "D \(.)") end') || return 1 ;;
      threads) out=$(gh api graphql --paginate "${q[@]}" -f query='
          # q:threads
          query($o: String!, $r: String!, $n: Int!, $endCursor: String) { repository(owner: $o, name: $r) {
            pullRequest(number: $n) { reviewThreads(first: 50, after: $endCursor) { totalCount
              pageInfo { hasNextPage endCursor }
              nodes { id comments(first: 100) { totalCount nodes { createdAt updatedAt lastEditedAt } } } } } } }' \
          --jq '.data.repository.pullRequest.reviewThreads
                | if . == null or (.totalCount | type) != "number" or (.nodes | type) != "array" then "X" else "T \(.totalCount)", "N \(.nodes | length)",
                  (.nodes[] | (.comments.totalCount // -1) as $t | (.comments.nodes | length) as $k
                   | if $t == $k then empty
                     elif ($t | type) == "number" and $t > $k and (.id | type) == "string" and (.id | test("^[A-Za-z0-9_=-]+$")) then "P \(.id)"
                     else "I" end),
                  (.nodes[].comments.nodes[] | .createdAt, .updatedAt, .lastEditedAt | select(. != null) | "D \(.)") end') || return 1
        tids=$(sed -n 's/^P //p' <<<"$out") ;;
      thread:*) out=$(gh api graphql --paginate -f id="${kind#thread:}" -f query='
          # q:thread
          query($id: ID!, $endCursor: String) { node(id: $id) { ... on PullRequestReviewThread {
            comments(first: 100, after: $endCursor) { totalCount
              pageInfo { hasNextPage endCursor } nodes { createdAt updatedAt lastEditedAt } } } } }' \
          --jq '.data.node.comments
                | if . == null or (.totalCount | type) != "number" or (.nodes | type) != "array" then "X" else "T \(.totalCount)", "N \(.nodes | length)",
                  (.nodes[] | .createdAt, .updatedAt, .lastEditedAt | select(. != null) | "D \(.)") end') || return 1 ;;
    esac
    rc=0; d=$(list_sum <<<"$out") || rc=$?
    [ "$rc" = 0 ] || return "$rc"
    [ "$d" = none ] || [[ $newest != none && ! $d > $newest ]] || newest=$d
    for d in $tids; do todo+=("thread:$d"); done
    tids=""
  done
  printf '%s %s\n' "${head% *}" "$newest"
}

# The success rule. Each check either passes or turns the success into a blocking state.
phase="not posting success"
block() { state=$1; desc=$2; echo "$ctx on ${sha:0:9}: $phase: $desc"; }
# The checks run once before the POST and once after a success is posted. Each either passes
# or turns `state` into a blocking one; they act only while `state` is success.
verify_snapshot() {
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
  # The head branch of each PR in PRS, read below and matched against newer runs' titles;
  # "?" where it could not be read.
  branches=""
  if [ "$state" = success ]; then
    # The PRs themselves: head unchanged, nothing newer than the snapshot.
    for pr in ${PRS:-}; do
      [[ $pr =~ ^[0-9]+$ ]] || { block error "Not a PR number: ${pr:0:20}"; break; }
      act_rc=0
      act=$(pr_activity "$pr") || act_rc=$?
      if [ "$act_rc" = 3 ]; then
        block pending "Re-evaluating: could not see all of PR #$pr's activity"
        break
      elif [ "$act_rc" != 0 ]; then
        block error "Could not read PR #$pr to verify a success; see the run"
        break
      fi
      read -r act_head act_branch act_last <<<"$act"
      branches+="$act_branch "
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
  if [ "$state" = success ]; then
    # Runs of this workflow created after the evaluation began, other than this run, that can
    # evaluate this head. A scheduled sweep counts: it evaluates every open head, its job for
    # this head queues behind this one (one concurrency group per sha), and it may be the only
    # run to see a change that fires no event (a thread resolved or unresolved). A run's title (review-gate.yml `run-name`) names
    # its target: "review-gate <event> sha=<head|-> prs=<n,n|-> branch=<name|->". It counts
    # when it names this sha, a PR in PRS, or the head branch of one of them. A run for
    # another head does not: it never re-posts this one, so steady activity on other PRs
    # would keep a valid success pending. Fail closed: a title that does not parse, that
    # names no target (the sweep's "sha=- prs=- branch=-"), or that names a branch while a
    # PR's branch is unknown ("?"), counts.
    # A list that cannot be read is a failed read.
    # Every page is filtered on its own and the pages summed (list_sum): a page that fails is
    # a failed read, and a list holding fewer runs than its total_count is incomplete.
    runs_rc=0
    runs_out=$(gh api --paginate "repos/$repo/actions/workflows/review-gate.yml/runs?per_page=100&created=%3E%3D$EVAL_STARTED" \
        --jq "($(jq -cn --arg s "$PRS" '$s | [splits(" +") | select(. != "")]') ) as \$prs
              | ($(jq -cn --arg s "$branches" '$s | [splits(" +") | select(. != "")]') ) as \$branches
              | . as \$page
              | [\$page.workflow_runs[] | select((.id | tostring) != \"${GITHUB_RUN_ID:-}\"
                                           and .created_at >= \"$EVAL_STARTED\")
                 | ((.display_title // \"\") | capture(\"^review-gate [a-z_]+ sha=(?<sha>-|[0-9a-f]{40}) prs=(?<prs>-|[0-9]+(,[0-9]+)*) branch=(?<branch>[^[:space:]]+)\$\") // null) as \$t
                 | select(\$t == null
                          or (\$t.sha == \"-\" and \$t.prs == \"-\" and \$t.branch == \"-\")
                          or \$t.sha == \"$sha\"
                          or (\$t.prs != \"-\" and any(\$t.prs | split(\",\")[]; IN(\$prs[])))
                          or (\$t.branch != \"-\" and (IN(\$branches[]; \"?\") or (\$t.branch | IN(\$branches[])))))] as \$hits
              | if (\$page.workflow_runs | type) != \"array\" or (\$page.total_count | type) != \"number\" then \"X\"
                else \"T \\(\$page.total_count)\", \"N \\(\$page.workflow_runs | length)\", (\$hits[] | \"D 1\") end") \
      || runs_rc=1
    [ "$runs_rc" != 0 ] || { newer=$(list_sum <<<"$runs_out") || runs_rc=$?; }
    if [ "$runs_rc" = 3 ]; then
      block pending "Re-evaluating: the review-gate run list is incomplete"
    elif [ "$runs_rc" != 0 ]; then
      block error "Could not read the review-gate runs to verify a success; see the run"
    elif [ "$newer" != none ]; then
      block pending "Re-evaluating after a newer event"
    fi
  fi
}
verify_snapshot
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

# The POST above is unconditional once the checks passed, so a blocking status another run
# posted between the last read and the write is now older than this success and the PR reads
# mergeable. Read everything again: if any of it moved since the snapshot, post the blocking
# state over the success right away, through this script (so a blocking status that is
# already the newest posts nothing, and a refused POST still fails loudly).
if [ "$state" = success ]; then
  phase="success posted; re-verifying"
  if all=$(read_statuses); then
    verify_snapshot
  else
    block error "Could not re-read the statuses after posting a success"
  fi
  if [ "$state" != success ]; then
    echo "::warning::$ctx on ${sha:0:9}: the snapshot moved while the success was posted; posting $state over it"
    exec bash "$0" "$sha" "$state" "Raced a success: $desc"
  fi
fi
