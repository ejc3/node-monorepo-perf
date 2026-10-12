---
name: pr-review-gate
description: "Use when a PR has review findings (Codex, CodeRabbit, a human), before resolving a review thread, before calling a PR green, and before merging. Runs the merge gate that the required `review-gate` status runs, and says how to answer each finding (RED-VERIFIED / NOT-A-DEFECT / DISAGREE) and how to get the head reviewed."
allowed-tools: Bash, Read, Grep, Glob
user-invocable: true
---

# PR review gate

The ruleset on `main` requires it: a PR merges into `main` only when the commit status
`review-gate` on its head is `success`. `.github/workflows/review-gate.yml` posts that status from
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
  It needs a new disposition; the old one answered the old text. The exception is
  CodeRabbit acknowledging the answer on its own finding (the closing marker turned into
  its reply marker, then "✅ Confirmed as addressed by @<login>"): when the edit history
  proves every later edit was that and only that, by the CodeRabbit Bot, the answer stands.
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
  `chatgpt-codex-connector`) has not reviewed the head: no covering review
  object from it on the head, no no-findings result from it that names the head and is
  dated after the head arrived, and no accepted `HEAD-REVIEW-OVERRIDE` for it (below).

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

Codex must review the head after every push. CodeRabbit reviews on request; its findings
are answered like any other, but its review is not required on each head (it is rate
limited to about one review an hour):

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

### When a required reviewer cannot review

If a login in `REQUIRE_HEAD_REVIEW_FROM` cannot review the head (Codex out of quota: its
"You have reached your Codex usage limits" notice is on the PR), do the review another way
and record it, rather than merging outside the gate. Post a top-level comment (or a review
body) whose first line is:

```
HEAD-REVIEW-OVERRIDE: <reviewer-login> <sha>: <what was done instead>
```

for example

```bash
gh pr comment <n> --body "HEAD-REVIEW-OVERRIDE: chatgpt-codex-connector 1a2b3c4: local \`codex exec -s read-only\` review of main..1a2b3c4, no findings"
```

Anyone may post it, the PR author included. It covers that one login on that one head, and
only when `<sha>` names the current head (the full sha, or a prefix of 7 or more characters
no other commit on the PR shares), the comment was written after the head arrived (dated
like a claim: the later of its creation and its last edit), and the text says concretely
what was done: at least 20 letters or digits, not only placeholders such as `n/a`, `none`,
`skip` or `-`, and no unfinished placeholder (`TODO`, `TBD`, `FIXME`, `XXX`, or a `<words>` placeholder; a sha or URL in angle brackets is fine).
A review whose body is only the override line is not its author's review of the head. It
answers no thread or review-body finding, it counts only for a login
`REQUIRE_HEAD_REVIEW_FROM` lists, and a push needs a new one. The gate prints
`HEAD OVERRIDDEN  <login> on <sha>: <text> (by <commenter>, <date>)` and the verdict
`CLEAR (with N head-review override(s))`; an override it does not accept is printed as
`OVERRIDE REJECTED` with the reason. The `review-gate` status description names the
override too. A comment that is only the override line is not a claim; text below the line
is an ordinary comment and needs a disposition.

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
  `EXPECT_HEAD`; `REQUIRE_HEAD_REVIEW_FROM`), three classifier rules for this
  repository's bot traffic, and the `HEAD-REVIEW-OVERRIDE` line, each marked
  "node-monorepo-perf addition".
- `test-check-review-threads.sh`: one case per hole the gate has had, plus the fixture
  cases and the cases for this copy's knobs.
- `gate-discard-sites.sh`: pins every place the classifier discards body text.
- `post-status.sh`: the only way review-gate.yml posts the status. A `success` only
  against an unchanged snapshot (statuses, newer runs for this head, PR head and activity read right
  before the POST); a failed read posts `error`, a newer signal `pending`. Otherwise a
  change only; `pending` only over a `success`; `error` instead of `success` near GitHub's
  1000-status cap; a success this workflow did not post replaced by the real verdict.
- `merge-pr.sh`: `make merge-pr PR=<n>`, the merge path.
- `_required-reviewers.sh`: sourced by the gate and `merge-pr.sh`; a
  `REQUIRE_HEAD_REVIEW_FROM` (or `REVIEW_GATE_REQUIRED`) that is set but names no login is
  refused with exit 2, never read as "nobody required".
- `capture-review-threads-fixture.sh` + `fixtures/`: payloads the gate consumes, eight of
  them captured from this repository's PRs #46 and #63 to #67.
