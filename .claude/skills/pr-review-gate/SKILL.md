---
name: pr-review-gate
description: "Use when a PR has review findings (Codex, CodeRabbit, a human), before resolving a review thread, before calling a PR green, and before merging. Runs the merge gate that the required `review-gate` status runs, and says how to answer each finding (RED-VERIFIED / NOT-A-DEFECT / DISAGREE) and how to get the head reviewed."
allowed-tools: Bash, Read, Grep, Glob
user-invocable: true
---

# PR review gate

A PR merges into `main` only when the commit status `review-gate` on its head is
`success`. `.github/workflows/review-gate.yml` posts that status from
`check-review-threads.sh` in this directory. Run the same check locally:

```bash
make merge-pr PR=<n>           # gate the exact head, then squash-merge that head only
make review-gate PR=<n>        # what CI runs, with the required reviewers
make test-review-gate          # the gate's own harness
```

Merge with `make merge-pr`: it is the final authority (it merges only the commit it
gated, `--match-head-commit`); the status is defense in depth for UI merges.

Exit codes: `0` CLEAR, `1` BLOCKED, `2` the gate could not evaluate (missing `jq`/`gh`,
unreadable payload, the PR moved while it was read). Treat `2` as blocked.

## What it blocks on

- **UNRESOLVED**: an open review thread. `isOutdated` does not count as answered.
- **UNDISPOSED**: a resolved thread with no reply that opens with a disposition.
- **REOPENED**: a resolved thread whose finding was edited after its last disposition.
  It needs a new disposition; the old one answered the old text.
- **UNANSWERED**: a PR-level finding (a review body from anyone but the PR author, or a
  top-level PR comment) with no disposition posted after it. Not claims: APPROVED reviews,
  `@codex review` / `@coderabbitai review` and the other documented bot commands, a listed
  bot's no-findings verdict (Codex's may end with a sign-off from the list of ones it has
  posted), a listed bot's notice that it did not run,
  Codex's review that only holds its inline comments, CodeRabbit's command
  acknowledgements, and a clean CodeRabbit summary comment: only regions the gate has seen
  CodeRabbit emit (`cr_summary_regions`, checked against the fixtures), nothing outside
  them, no actionable comments, no failed or warning pre-merge check, merge risk Minimal
  or Low (each only from the bot's own account).
- **UNREVIEWED HEAD**: nobody but the author reviewed the head commit. An empty review
  object is a reply container, not a review.
- **MISSING HEAD REVIEW**: a login in `REQUIRE_HEAD_REVIEW_FROM` (here
  `chatgpt-codex-connector,coderabbitai`) has not reviewed the head: no covering review
  object from it on the head, and no no-findings result from it that names the head and is
  dated after the head arrived.

## Answering a finding

A disposition opens a reply of its own (thread reply, review, or PR comment) and is newer
than the claim it answers. A claim is dated by when its current text was written: the
later of its creation and its last edit. An answer is dated by its creation only: editing
an old disposition does not make it answer a claim written after it, so reply again
instead. A thread comment or review body that cannot be dated (an unparsable creation
time, or a `lastEditedAt` that is absent or does not parse) blocks with exit 2.

| Disposition | Use for |
|---|---|
| `RED-VERIFIED: <test>` | a defect claim, closed by a test watched failing without the fix |
| `NOT-A-DEFECT: <reason>` | naming, docs, style, bot summaries; say what you did |
| `DISAGREE: <reason>` | a defect claim you reject, with the reasoning |

A defect claim is closed by a test that fails without the fix, not by the fix: write the
test, watch it fail on the unfixed tree, apply the fix, watch it pass, revert once more to
confirm it goes red. Then reply `RED-VERIFIED: <test>` and resolve the thread.

Answer PR-level findings with a review from the author (`gh pr review <n> --comment -b
"NOT-A-DEFECT: ..."`). A review body from the author is never itself a claim; the author's
top-level comment is.

## Getting the head reviewed

Both bots must review the head, after every push:

```bash
gh pr comment <n> --body "@codex review"
gh pr comment <n> --body "@coderabbitai review"
```

CodeRabbit does not review this repository automatically (its notice says the repository
has fewer than 10 stars); it reviews when triggered. Its findings arrive as a review
object and inline threads; its summary comment is not a claim here while it reports a
clean result (upstream treats it as one), and is one when its pre-merge checks fail or
warn, so answer it then. Codex covers the head with a review object (findings), its "Didn't find any major
issues" comment naming the head, or its review-summary comment whose row says Completed
and names the head.

## Status updates

The status is re-evaluated on PR open/push/reopen/ready/edit (`pull_request_target`), any
PR comment (`issue_comment`), any review or inline comment (relayed through
`review-gate-events.yml`), and every 10 minutes for every open PR. Resolving or
unresolving a thread triggers no workflow; the sweep picks it up, or run
`gh workflow run review-gate -f pr=<n>`.

## Files

- `check-review-threads.sh`: the gate. A port of ejc3/fcvm's
  `scripts/check-review-threads.sh`; fixes go upstream first. This copy adds three knobs
  (the repository from `GITHUB_REPOSITORY`, default `ejc3/node-monorepo-perf`;
  `EXPECT_HEAD`; `REQUIRE_HEAD_REVIEW_FROM`) and three classifier rules for this
  repository's bot traffic, each marked "node-monorepo-perf addition".
- `test-check-review-threads.sh`: one case per hole the gate has had, plus the fixture
  cases and the cases for this copy's knobs.
- `gate-discard-sites.sh`: pins every place the classifier discards body text.
- `post-status.sh`: the only way review-gate.yml posts the status. A `success` only
  against an unchanged snapshot (statuses, newer runs, PR head and activity read right
  before the POST); a failed read posts `error`, a newer signal `pending`. Otherwise a
  change only; `pending` only over a `success`; `error` instead of `success` near GitHub's
  1000-status cap; a success this workflow did not post replaced by the real verdict.
- `merge-pr.sh`: `make merge-pr PR=<n>`, the merge path.
- `capture-review-threads-fixture.sh` + `fixtures/`: payloads the gate consumes, six of
  them captured from this repository's PRs #46 and #63 to #67.
