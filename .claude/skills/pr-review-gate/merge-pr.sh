#!/bin/bash
# Merge a PR only if the review gate is CLEAR for the exact commit being merged.
#
# Usage: merge-pr.sh <pr-number>      (make merge-pr PR=<n>)
#
# This is the merge path, and the final authority: it reads the PR head, runs
# check-review-threads.sh for that head (EXPECT_HEAD) with the required reviewers, and only
# on CLEAR asks GitHub to squash-merge that same commit (--match-head-commit), which GitHub
# refuses if the branch moved. The review-gate commit status is defense in depth for a
# merge from the web UI.
#
# What remains open: activity that lands after the gate read the PR and before the merge
# call (a new comment or review in those seconds) is not seen. GitHub's native conversation
# resolution rule still blocks an unresolved thread; for anything else, run this command
# again immediately before merging rather than reusing an earlier verdict.
#
# Environment: REQUIRE_HEAD_REVIEW_FROM (unset: chatgpt-codex-connector; set
# but naming nobody: refused),
# GITHUB_REPOSITORY or REPO_OWNER/REPO_NAME as for the gate, MERGE_GATE_SCRIPT (tests only:
# the gate to run).
set -euo pipefail

[ $# -eq 1 ] || { echo "usage: merge-pr.sh <pr-number> (exactly one; got $#)" >&2; exit 2; }
pr=$1
[[ $pr =~ ^[0-9]+$ ]] || { echo "merge-pr: '$pr' is not a PR number" >&2; exit 2; }
for tool in gh jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "merge-pr: '$tool' is not installed; not merging" >&2; exit 2; }
done
here=$(cd "$(dirname "$0")" && pwd)
# Unset means the default list below; set but naming nobody is refused, not defaulted.
# shellcheck source=_required-reviewers.sh
source "$here/_required-reviewers.sh" || { echo "merge-pr: cannot load _required-reviewers.sh; not merging" >&2; exit 2; }
required_reviewers_ok merge-pr || { echo "merge-pr: not merging" >&2; exit 2; }
gate=${MERGE_GATE_SCRIPT:-$here/check-review-threads.sh}
# The same precedence as the gate (REPO_OWNER/REPO_NAME, then GITHUB_REPOSITORY, then this
# repository), resolved once here and handed to the gate, so both read one repository.
if [ -n "${GITHUB_REPOSITORY:-}" ]; then
  REPO_OWNER=${REPO_OWNER:-${GITHUB_REPOSITORY%%/*}}
  REPO_NAME=${REPO_NAME:-${GITHUB_REPOSITORY#*/}}
fi
export REPO_OWNER=${REPO_OWNER:-ejc3} REPO_NAME=${REPO_NAME:-node-monorepo-perf}
repo=$REPO_OWNER/$REPO_NAME

info=$(gh pr view "$pr" --repo "$repo" --json state,headRefOid,baseRefName) || {
  echo "merge-pr: could not read PR #$pr; not merging" >&2; exit 2; }
state=$(jq -r '.state' <<<"$info")
sha=$(jq -r '.headRefOid' <<<"$info")
base=$(jq -r '.baseRefName' <<<"$info")
[ "$state" = OPEN ] || { echo "merge-pr: PR #$pr is $state; not merging" >&2; exit 2; }
[[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo "merge-pr: PR #$pr has no readable head; not merging" >&2; exit 2; }
echo "PR #$pr: head ${sha:0:9}, base $base"

set +e
EXPECT_HEAD=$sha REQUIRE_HEAD_REVIEW_FROM=${REQUIRE_HEAD_REVIEW_FROM-chatgpt-codex-connector} \
  bash "$gate" "$pr"
rc=$?
set -e
if [ "$rc" != 0 ]; then
  echo "merge-pr: the gate did not report CLEAR for ${sha:0:9} (exit $rc); not merging" >&2
  exit 1
fi

gh pr merge "$pr" --repo "$repo" --squash --match-head-commit "$sha"
echo "merged PR #$pr at ${sha:0:9}"
