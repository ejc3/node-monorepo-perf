#!/bin/bash
# Tests for check-review-threads.sh — one case per fail-open hole the gate has had.
#
# Every case here was written against the UNFIXED script and observed FAILING first.
# A test that has never been red proves nothing (AGENTS.md, "Reviewing Each Commit").
#
# Ported from ejc3/fcvm's scripts/test-check-review-threads.sh. The "finding N" cases are
# upstream's, and a PR number in a comment is an ejc3/fcvm PR. The seven original holes
# were found by Codex review on dolphin-labs#5, which runs a port of this same gate.
# The sections at the end are this repository's: the cases upstream keeps in its Rust
# harness (tests/test_log_scan.rs) over the payloads in fixtures/, and the cases for the
# three node-monorepo-perf additions (GITHUB_REPOSITORY, EXPECT_HEAD,
# REQUIRE_HEAD_REVIEW_FROM), each observed red against the unmodified upstream script,
# and for the three classifier additions for the bot traffic on this repository (Codex's
# changing sign-off, its inline-comment container review, CodeRabbit's summary comment and
# acknowledgements), each observed red against the script before them.
#
# One deliberate divergence from upstream: this repository does not treat the CodeRabbit
# summary comment as a claim (see is_cr_summary_comment). Eight upstream cases asserted that
# a finding placed INSIDE one of that comment's regions is claimable; they are kept, renamed
# "node-monorepo-perf: text inside a CodeRabbit summary region is not a claim (upstream:
# ...)", and now expect CLEAR. Text outside the regions is still a claim, and those
# upstream cases are unchanged.
#
# A second divergence: an answer is dated by its creation, never by its own edits (addition
# 6d), so upstream's "a disposition edited after the claim answers it" is kept renamed
# "node-monorepo-perf: a disposition edited after the claim does not answer it" and now
# expects BLOCKED.
#
# Usage: test-check-review-threads.sh [path-to-check-review-threads.sh]
set -uo pipefail
GATE=${1:-"$(dirname "$0")/check-review-threads.sh"}
# The payload fixtures live next to this harness, whichever gate it is pointed at.
FIXTURES=${FIXTURES:-"$(dirname "$0")/fixtures"}
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

# $1 name, $2 fixture json, $3 expected exit code, $4 and $5 substrings expected in output
run_case() {
  local name=$1 json=$2 want_rc=$3 want_txt=${4:-} want_txt2=${5:-}
  printf '%s' "$json" > "$TMP/f.json"
  local out rc
  out=$(bash "$GATE" --from-file "$TMP/f.json" 2>&1); rc=$?
  if [ "$rc" = "$want_rc" ] && { [ -z "$want_txt" ] || grep -qF "$want_txt" <<<"$out"; } \
     && { [ -z "$want_txt2" ] || grep -qF "$want_txt2" <<<"$out"; }; then
    echo "  PASS  $name"; pass=$((pass+1))
  else
    echo "  FAIL  $name (rc=$rc want=$want_rc)"
    sed 's/^/          /' <<<"$out" | head -4
    fail=$((fail+1))
  fi
}

# Every case runs under the full ruleset, head coverage included (finding 29 closed the
# skip for a PR with no review objects). The builders for cases about dispositions put
# the head on a covered commit: a stranger's APPROVED review of deadbeef, spliced in front
# of the reviews the case supplies. A non-array passes through untouched so the
# validation cases still reach the parser with it. Cases about coverage use wrap5-8.
COVER='{"author":{"login":"reviewer"},"state":"APPROVED","submittedAt":"2025-12-31T00:00:00Z","lastEditedAt":null,"body":"","commit":{"oid":"deadbeef"}}'
covered() { if jq -e 'type == "array"' >/dev/null 2>&1 <<<"${1:-[]}"; then jq -c --argjson c "$COVER" '[$c] + .' <<<"${1:-[]}"; else printf '%s' "$1"; fi; }
wrap() { printf '{"data":{"repository":{"pullRequest":{"author":{"login":"me"},"headRefOid":"deadbeef","reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":%s},"reviews":{"nodes":%s}}}}}' "$1" "$(covered "${2:-[]}")"; }

echo "== finding 1: a missing/nonexistent PR must not read as 'no threads' =="
run_case "null pullRequest blocks" \
  '{"data":{"repository":{"pullRequest":null}}}' 2 "BLOCKED"

echo "== finding 3: isResolved must be a real boolean =="
run_case "isResolved null blocks" \
  "$(wrap '[{"isResolved":null,"comments":{"nodes":[{"author":{"login":"x"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:01:00Z","lastEditedAt":null,"body":"this crashes"}]}}]')" \
  2 "BLOCKED"
run_case "isResolved string blocks" \
  "$(wrap '[{"isResolved":"true","comments":{"nodes":[{"author":{"login":"x"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:02:00Z","lastEditedAt":null,"body":"this crashes"}]}}]')" \
  2 "BLOCKED"

echo "== finding 2: RED-VERIFIED needs an actual test name =="
run_case "bare RED-VERIFIED: blocks" \
  "$(wrap '[{"isResolved":true,"comments":{"nodes":[{"author":{"login":"x"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:03:00Z","lastEditedAt":null,"body":"this crashes on empty input"},{"author":{"login":"y"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:04:00Z","lastEditedAt":null,"body":"RED-VERIFIED:"}]}}]')" \
  1 "BLOCKED"
run_case "RED-VERIFIED with test name clears" \
  "$(wrap '[{"isResolved":true,"comments":{"nodes":[{"author":{"login":"x"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:05:00Z","lastEditedAt":null,"body":"this crashes on empty input"},{"author":{"login":"y"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:06:00Z","lastEditedAt":null,"body":"RED-VERIFIED: recommendation.test.ts"}]}}]')" \
  0 "CLEAR"

echo "== findings 0 + 5: every resolved thread needs an explicit disposition =="
run_case "defect wording the old regex missed still blocks" \
  "$(wrap '[{"isResolved":true,"comments":{"nodes":[{"author":{"login":"x"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:07:00Z","lastEditedAt":null,"body":"this drops the final game from the schedule"}]}}]')" \
  1 "BLOCKED"
run_case "resolved with no reply at all blocks" \
  "$(wrap '[{"isResolved":true,"comments":{"nodes":[{"author":{"login":"x"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:08:00Z","lastEditedAt":null,"body":"rename this variable"}]}}]')" \
  1 "BLOCKED"
run_case "documented disagreement is a valid disposition" \
  "$(wrap '[{"isResolved":true,"comments":{"nodes":[{"author":{"login":"x"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:09:00Z","lastEditedAt":null,"body":"this is broken and crashes"},{"author":{"login":"y"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:10:00Z","lastEditedAt":null,"body":"DISAGREE: the guard above already rejects that input"}]}}]')" \
  0 "CLEAR"
run_case "non-defect disposition clears" \
  "$(wrap '[{"isResolved":true,"comments":{"nodes":[{"author":{"login":"x"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:11:00Z","lastEditedAt":null,"body":"rename this variable"},{"author":{"login":"y"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:12:00Z","lastEditedAt":null,"body":"NOT-A-DEFECT: renamed in 1a2b3c4"}]}}]')" \
  0 "CLEAR"

echo "== finding 4: PR-level review bodies must be adjudicated =="
run_case "undisposed review body blocks" \
  "$(wrap '[]' '[{"author":{"login":"chatgpt-codex-connector"},"state":"COMMENTED","submittedAt":"2026-01-01T00:00:00Z","lastEditedAt":null,"body":"P1: this silently drops events"}]')" \
  1 "BLOCKED"
run_case "disposed review body clears" \
  "$(wrap '[]' '[{"author":{"login":"chatgpt-codex-connector"},"state":"COMMENTED","submittedAt":"2026-01-01T00:00:00Z","lastEditedAt":null,"body":"P1: this silently drops events"},{"author":{"login":"me"},"state":"COMMENTED","submittedAt":"2026-01-02T00:00:00Z","lastEditedAt":null,"body":"DISAGREE: the guard above already rejects that input"}]')" \
  0 "CLEAR"
run_case "empty review body needs no disposition" \
  "$(wrap '[]' '[{"author":{"login":"someone"},"state":"APPROVED","body":""}]')" \
  0 "CLEAR"

echo "== finding 8: a reply ASKING for proof is not a disposition =="
# "Please add RED-VERIFIED: <test>" contains the marker followed by non-whitespace, so an
# unanchored substring test counted the person DEMANDING evidence as the one supplying it.
run_case "reply requesting proof blocks" \
  "$(wrap '[{"isResolved":true,"comments":{"nodes":[{"author":{"login":"x"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:13:00Z","lastEditedAt":null,"body":"this corrupts the output"},{"author":{"login":"y"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:14:00Z","lastEditedAt":null,"body":"Please add RED-VERIFIED: test-name before resolving this."}]}}]')" \
  1 "BLOCKED"
run_case "disposition buried after prose blocks" \
  "$(wrap '[{"isResolved":true,"comments":{"nodes":[{"author":{"login":"x"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:15:00Z","lastEditedAt":null,"body":"this corrupts the output"},{"author":{"login":"y"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:16:00Z","lastEditedAt":null,"body":"we talked about this and\nNOT-A-DEFECT: it is fine"}]}}]')" \
  1 "BLOCKED"
run_case "disposition opening the reply clears" \
  "$(wrap '[{"isResolved":true,"comments":{"nodes":[{"author":{"login":"x"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:17:00Z","lastEditedAt":null,"body":"this corrupts the output"},{"author":{"login":"y"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:18:00Z","lastEditedAt":null,"body":"NOT-A-DEFECT: renamed only, no behaviour change"}]}}]')" \
  0 "CLEAR"

echo "== finding 9: an answer must be NEWER than the claim it answers =="
# One disposition used to zero the whole count, so a review body posted AFTER it was
# silently treated as answered.
run_case "claim posted after the disposition blocks" \
  "$(wrap '[]' '[{"author":{"login":"me"},"state":"COMMENTED","submittedAt":"2026-01-01T00:00:00Z","lastEditedAt":null,"body":"DISAGREE: answered the first round"},{"author":{"login":"codex"},"state":"COMMENTED","submittedAt":"2026-01-05T00:00:00Z","lastEditedAt":null,"body":"P1: new finding nobody has answered"}]')" \
  1 "BLOCKED"
run_case "two claims, one late disposition clears both" \
  "$(wrap '[]' '[{"author":{"login":"codex"},"state":"COMMENTED","submittedAt":"2026-01-01T00:00:00Z","lastEditedAt":null,"body":"P1: first finding"},{"author":{"login":"codex"},"state":"COMMENTED","submittedAt":"2026-01-02T00:00:00Z","lastEditedAt":null,"body":"P2: second finding"},{"author":{"login":"me"},"state":"COMMENTED","submittedAt":"2026-01-03T00:00:00Z","lastEditedAt":null,"body":"RED-VERIFIED: covers both, tests/foo.rs"}]')" \
  0 "CLEAR"

echo "== finding 10: review data must be validated like thread data =="
run_case "reviews.nodes as an object exits 2" \
  "$(wrap '[]' '{"malformed":true}')" 2 "BLOCKED"
run_case "reviews.nodes as a string exits 2" \
  "$(wrap '[]' '"nonsense"')" 2 "BLOCKED"
run_case "review body of the wrong type exits 2" \
  "$(wrap '[]' '[{"author":{"login":"x"},"state":"COMMENTED","submittedAt":"2026-01-01T00:00:00Z","lastEditedAt":null,"body":42}]')" \
  2 "BLOCKED"
run_case "non-empty review body with no timestamp exits 2" \
  "$(wrap '[]' '[{"author":{"login":"x"},"state":"COMMENTED","body":"P1: this drops events"}]')" \
  2 "BLOCKED"

echo "== finding 11: PR-level claims answer to the same vocabulary as inline ones =="
# A bare "REVIEW-ACK: read" used to clear a PR-level defect claim that, posted inline,
# would have demanded a real disposition. Same finding, two standards.
run_case "PR-level claim + bare ack blocks" \
  "$(wrap '[]' '[{"author":{"login":"codex"},"state":"COMMENTED","submittedAt":"2026-01-01T00:00:00Z","lastEditedAt":null,"body":"P1: this silently drops the last record"},{"author":{"login":"me"},"state":"COMMENTED","submittedAt":"2026-01-02T00:00:00Z","lastEditedAt":null,"body":"REVIEW-ACK: read"}]')" \
  1 "BLOCKED"

echo "== finding 6: a disposition past the first comment page must be seen =="
long=$(python3 -c '
import json
n=[{"author":{"login":"bot"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:19:00Z","lastEditedAt":None,"body":"this leaks memory"}]
n+=[{"author":{"login":"x"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:20:00Z","lastEditedAt":None,"body":"chatter %d"%i} for i in range(120)]
n+=[{"author":{"login":"y"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:21:00Z","lastEditedAt":None,"body":"RED-VERIFIED: leak.test.ts"}]
print(json.dumps([{"isResolved":True,"comments":{"nodes":n,"totalCount":len(n)}}]))')
run_case "RED-VERIFIED after 100+ comments is found" "$(wrap "$long")" 0 "CLEAR"

echo "== finding 14: ordinary chatter after a disposition must NOT re-block =="
# A positional "the disposition must be last" rule was tried and withdrawn: it could not
# tell a new defect claim from "Thanks, confirmed", so it blocked adjudicated threads.
run_case "reviewer confirmation after a disposition clears" \
  "$(wrap '[{"isResolved":true,"comments":{"nodes":[{"author":{"login":"x"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:22:00Z","lastEditedAt":null,"body":"this drops a record"},{"author":{"login":"y"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:23:00Z","lastEditedAt":null,"body":"RED-VERIFIED: a.test.ts"},{"author":{"login":"x"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:24:00Z","lastEditedAt":null,"body":"Thanks, confirmed."}]}}]')" \
  0 "CLEAR"

echo "== finding 13: findings in top-level PR comments count too =="
wrap3() { printf '{"data":{"repository":{"pullRequest":{"author":{"login":"me"},"headRefOid":"deadbeef","reviewThreads":{"nodes":%s},"reviews":{"nodes":%s},"comments":{"nodes":%s}}}}}' "$1" "$(covered "${2:-[]}")" "${3:-[]}"; }
run_case "undisposed top-level PR comment blocks" \
  "$(wrap3 '[]' '[]' '[{"author":{"login":"codex"},"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z","body":"P1: this silently drops the last row"}]')" \
  1 "BLOCKED"
run_case "disposed top-level PR comment clears" \
  "$(wrap3 '[]' '[]' '[{"author":{"login":"codex"},"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z","body":"P1: this silently drops the last row"},{"author":{"login":"me"},"createdAt":"2026-01-02T00:00:00Z","updatedAt":"2026-01-02T00:00:00Z","body":"DISAGREE: the guard above rejects that input"}]')" \
  0 "CLEAR"
run_case "a PR comment can answer a review body" \
  "$(wrap3 '[]' '[{"author":{"login":"codex"},"state":"COMMENTED","submittedAt":"2026-01-01T00:00:00Z","lastEditedAt":null,"body":"P1: drops a row"}]' '[{"author":{"login":"me"},"createdAt":"2026-01-02T00:00:00Z","updatedAt":"2026-01-02T00:00:00Z","body":"RED-VERIFIED: row.test.ts"}]')" \
  0 "CLEAR"
run_case "malformed PR comment data exits 2" \
  "$(wrap3 '[]' '[]' '"nonsense"')" 2 "BLOCKED"

echo "== finding 15: only real claimants raise PR-level claims =="
wrap4() { printf '{"data":{"repository":{"pullRequest":{"author":{"login":"%s"},"headRefOid":"deadbeef","reviewThreads":{"nodes":%s},"reviews":{"nodes":%s},"comments":{"nodes":%s}}}}}' "$1" "$2" "$(covered "${3:-[]}")" "${4:-[]}"; }
# The command this skill documents — posted by the PR author — is not a finding.
run_case "author's own @codex review comment does not block" \
  "$(wrap4 me '[]' '[]' '[{"author":{"login":"me","__typename":"User"},"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z","body":"@codex review"}]')" \
  0 "CLEAR"
run_case "deploy bot notification does not block" \
  "$(wrap4 me '[]' '[]' '[{"author":{"login":"vercel","__typename":"Bot"},"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z","body":"Deployment ready at https://preview.example"}]')" \
  0 "CLEAR"
run_case "a human finding in a top-level comment still blocks" \
  "$(wrap4 me '[]' '[]' '[{"author":{"login":"reviewer","__typename":"User"},"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z","body":"P1: this drops the last row"}]')" \
  1 "BLOCKED"
run_case "a reviewing bot's top-level comment still blocks" \
  "$(wrap4 me '[]' '[{"author":{"login":"codex"},"state":"COMMENTED","submittedAt":"2026-01-01T00:00:00Z","lastEditedAt":null,"body":""}]' '[{"author":{"login":"codex","__typename":"Bot"},"createdAt":"2026-01-02T00:00:00Z","updatedAt":"2026-01-02T00:00:00Z","body":"P1: this drops the last row"}]')" \
  1 "BLOCKED"
run_case "a bot REVIEW body still blocks" \
  "$(wrap4 me '[]' '[{"author":{"login":"codex"},"state":"COMMENTED","submittedAt":"2026-01-01T00:00:00Z","lastEditedAt":null,"body":"P1: this drops the last row"}]' '[]')" \
  1 "BLOCKED"

echo "== finding 16: the head commit must actually have been reviewed =="
wrap5() { printf '{"data":{"repository":{"pullRequest":{"author":{"login":"me"},"headRefOid":"%s","reviewThreads":{"nodes":[]},"reviews":{"nodes":%s},"comments":{"nodes":[]}}}}}' "$1" "$2"; }
run_case "reviews exist but none cover the head blocks" \
  "$(wrap5 deadbeef '[{"author":{"login":"codex"},"state":"COMMENTED","submittedAt":"2026-01-01T00:00:00Z","lastEditedAt":null,"body":"","commit":{"oid":"0ldc0mm1t"}}]')" \
  1 "UNREVIEWED HEAD"
run_case "a review covering the head clears" \
  "$(wrap5 deadbeef '[{"author":{"login":"codex"},"state":"COMMENTED","submittedAt":"2026-01-01T00:00:00Z","lastEditedAt":null,"body":"","commit":{"oid":"deadbeef"},"comments":{"totalCount":1,"nodes":[{"replyTo":null}]}}]')" \
  0 "CLEAR"
# Flipped by finding 29: this case expected CLEAR, which was the fail-open itself.
run_case "no reviews at all is an unreviewed head, not a clear one (was CLEAR)" \
  "$(wrap5 deadbeef '[]')" 1 "UNREVIEWED HEAD"

echo "== finding 17: authorship does not decide what is a finding =="
run_case "author's own defect report is claimable" \
  "$(wrap4 me '[]' '[]' '[{"author":{"login":"me","__typename":"User"},"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z","body":"P1: this drops records"}]')" \
  1 "BLOCKED"
run_case "a standalone bot finding with no review history is claimable" \
  "$(wrap4 me '[]' '[]' '[{"author":{"login":"codex","__typename":"Bot"},"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z","body":"P1: this drops the last row"}]')" \
  1 "BLOCKED"
run_case "an APPROVED review body is not a finding" \
  "$(wrap4 me '[]' '[{"author":{"login":"reviewer"},"state":"APPROVED","submittedAt":"2026-01-01T00:00:00Z","lastEditedAt":null,"body":"LGTM, nice work"}]' '[]')" \
  0 "CLEAR"
run_case "a COMMENTED review body still is" \
  "$(wrap4 me '[]' '[{"author":{"login":"reviewer"},"state":"COMMENTED","submittedAt":"2026-01-01T00:00:00Z","lastEditedAt":null,"body":"LGTM, nice work"}]' '[]')" \
  1 "BLOCKED"
run_case "a bare @codex trigger is not a finding" \
  "$(wrap4 me '[]' '[]' '[{"author":{"login":"anyone","__typename":"User"},"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z","body":"@codex review"}]')" \
  0 "CLEAR"
run_case "a finding that merely mentions @codex still blocks" \
  "$(wrap4 me '[]' '[]' '[{"author":{"login":"anyone","__typename":"User"},"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z","body":"@codex review this: P1 it drops rows"}]')" \
  1 "BLOCKED"

echo "== finding 18: the author reviewing their own push is not coverage =="
run_case "only the author reviewed the head" \
  "$(wrap5 deadbeef '[{"author":{"login":"codex"},"state":"COMMENTED","submittedAt":"2026-01-01T00:00:00Z","lastEditedAt":null,"body":"","commit":{"oid":"0ldc0mm1t"}},{"author":{"login":"me"},"state":"COMMENTED","submittedAt":"2026-01-02T00:00:00Z","lastEditedAt":null,"body":"NOT-A-DEFECT: fixed","commit":{"oid":"deadbeef"}}]')" \
  1 "UNREVIEWED HEAD"
run_case "someone else reviewed the head" \
  "$(wrap5 deadbeef '[{"author":{"login":"codex"},"state":"COMMENTED","submittedAt":"2026-01-02T00:00:00Z","lastEditedAt":null,"body":"","commit":{"oid":"deadbeef"},"comments":{"totalCount":1,"nodes":[{"replyTo":null}]}}]')" \
  0 "CLEAR"

echo "== finding 19: a reviewer with nothing to say posts no review object =="
# Codex answers "Didn't find any major issues" as a plain comment; CodeRabbit's full
# review with no comments replies "Full review finished." and creates no review. A head
# that no bot has anything to say about must not sit BLOCKED forever: a bot's no-findings
# result that names the head, dated AFTER the head ARRIVED at GitHub, covers it (finding
# 26 below has the CodeRabbit side). Arrival is the creation of the head's first check
# suite, not the commit's own date: a commit made locally before an older head's verdict
# and pushed afterwards carries a committedDate that predates that verdict (codex on
# #873). The verdict must be the whole comment, in the shape the bot actually posts (the
# builders below copy live comments): a body carrying the phrase plus finding text is a
# finding, claimable and not coverage.
wrap6() { printf '{"data":{"repository":{"pullRequest":{"author":{"login":"me"},"headRefOid":"deadbeef","commits":{"nodes":[{"commit":{"committedDate":"2026-01-02T00:00:00Z","checkSuites":{"nodes":[{"createdAt":"2026-01-02T00:30:00Z"},{"createdAt":"2026-01-02T00:31:00Z"}]}}}]},"reviewThreads":{"nodes":[]},"reviews":{"nodes":[{"author":{"login":"codex"},"state":"COMMENTED","submittedAt":"2026-01-01T00:00:00Z","lastEditedAt":null,"body":"","commit":{"oid":"0ldc0mm1t"}}]},"comments":{"nodes":%s},"recheck":{"comments":{"nodes":%s}}}}}}' "$1" "${2:-$1}"; }
# One top-level PR comment as GraphQL returns it: login, __typename, createdAt, a body
# that is already a JSON string literal, and updatedAt ($5, defaulting to createdAt as
# GitHub does for a comment nobody has edited).
cmt() { printf '{"author":{"login":"%s","__typename":"%s"},"createdAt":"%s","updatedAt":"%s","body":%s}' "$1" "$2" "$3" "${5:-$3}" "$4"; }
# Every payload carries the gate's SECOND read of the comments under `recheck` — what
# fetch_payload fetches after all paging, and compares against the first read (finding 31).
# The builders default it to the first read: a fixture models a run in which nothing changed,
# unless the case is about something that did.
#
# wrap9 is the wrap6 head with a review object already on it, for cases about whether a
# comment needs a disposition rather than about what covers the head.
wrap9() { printf '{"data":{"repository":{"pullRequest":{"author":{"login":"me"},"headRefOid":"deadbeef","commits":{"nodes":[{"commit":{"committedDate":"2026-01-02T00:00:00Z","checkSuites":{"nodes":[{"createdAt":"2026-01-02T00:30:00Z"}]}}}]},"reviewThreads":{"nodes":[]},"reviews":{"nodes":[{"author":{"login":"codex"},"state":"COMMENTED","submittedAt":"2026-01-03T00:00:00Z","lastEditedAt":null,"body":"","commit":{"oid":"deadbeef"},"comments":{"totalCount":1,"nodes":[{"replyTo":null}]}}]},"comments":{"nodes":[%s]},"recheck":{"comments":{"nodes":[%s]}}}}}}' "$1" "${2:-$1}"; }
# Codex's no-findings comment as posted: the phrase with sign-off $1, the reviewed commit
# $2, and the folded About Codex block. Emits a JSON string literal.
codex_body() { jq -n --arg s "$1" --arg sha "$2" '"Codex Review: Didn\u0027t find any major issues.\($s)\n\n**Reviewed commit:** `\($sha)`\n\n<details> <summary>ℹ️ About Codex in GitHub</summary>\n<br/>\n\n[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you\n- Open a pull request for review\n- Mark a draft as ready\n- Comment \"@codex review\".\n\nIf Codex has suggestions, it will comment; otherwise it will react with 👍.\n\n\n\n\nCodex can also answer questions or update the PR. Try commenting \"@codex address that feedback\".\n            \n</details>"'; }
# CodeRabbit's command acknowledgement as posted, folding $1 under "Action performed".
cr_body() { jq -n --arg t "$1" '"<!-- This is an auto-generated reply by CodeRabbit -->\n<!-- CodeRabbit review command invocation: 8fd6df2f-253d-45d8-a76b-9078ed862337 -->\n<details>\n<summary>✅ Action performed</summary>\n\n\($t)\n\n</details>"'; }
CODEX=chatgpt-codex-connector
CR_NOTE=$'Review finished.\n\n> Note: CodeRabbit is an incremental review system and does not re-review already reviewed commits. This command is applicable only when automatic reviews are paused.'
run_case "a codex no-findings comment after the head arrived covers it" \
  "$(wrap6 "[$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Bravo.' deadbeef)")]")" \
  0 "HEAD COVERED"
# The two CodeRabbit replies are notices: exempt from dispositions, never coverage. They
# used to cover the head when they answered a request posted after arrival; finding 26
# withdraws that rule, so both expect UNREVIEWED HEAD.
run_case "a coderabbit full-review-finished reply is not coverage, even after a request" \
  "$(wrap6 "[$(cmt me User 2026-01-02T00:40:00Z '"@coderabbitai full review"'),$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(cr_body 'Full review finished.')")]")" \
  1 "UNREVIEWED HEAD" "the head commit has not been reviewed"
run_case "a coderabbit review-finished reply with its note is not coverage either" \
  "$(wrap6 "[$(cmt me User 2026-01-02T00:40:00Z '"@coderabbitai review"'),$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(cr_body "$CR_NOTE")")]")" \
  1 "UNREVIEWED HEAD" "the head commit has not been reviewed"
run_case "a coderabbit reply with its note needs no disposition" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(cr_body "$CR_NOTE")")")" \
  0 "CLEAR"
run_case "a verdict dated after the commit but before the head arrived is not coverage" \
  "$(wrap6 "[$(cmt "$CODEX" Bot 2026-01-02T00:10:00Z "$(codex_body '' deadbeef)")]")" \
  1 "UNREVIEWED HEAD"
run_case "the author saying no findings is not coverage" \
  "$(wrap6 "[$(cmt me User 2026-01-02T01:00:00Z "$(codex_body '' deadbeef)")]")" \
  1 "UNREVIEWED HEAD"
run_case "a verdict cannot cover a head that has no check suite (arrival unknown)" \
  "$(printf '{"data":{"repository":{"pullRequest":{"author":{"login":"me"},"headRefOid":"deadbeef","commits":{"nodes":[{"commit":{"committedDate":"2026-01-02T00:00:00Z","checkSuites":{"nodes":[]}}}]},"reviewThreads":{"nodes":[]},"reviews":{"nodes":[{"author":{"login":"codex"},"state":"COMMENTED","submittedAt":"2026-01-01T00:00:00Z","lastEditedAt":null,"body":"","commit":{"oid":"0ldc0mm1t"}}]},"comments":{"nodes":[%s]},"recheck":{"comments":{"nodes":[%s]}}}}}}' "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body '' deadbeef)")" "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body '' deadbeef)")")" \
  1 "UNREVIEWED HEAD"
run_case "a no-findings verdict is not a finding that needs a disposition" \
  "$(wrap9 "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body '' deadbeef)")")" \
  0 "CLEAR"
run_case "the verdict phrase beside finding text is a finding, not coverage" \
  "$(wrap6 "[$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body $'\n\nOne thing though: the lease is dropped before the rename, which races the pruner.' deadbeef)")]")" \
  1 "carry no disposition"
run_case "a coderabbit ack with extra review text is a finding, not coverage" \
  "$(wrap6 "[$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(cr_body $'Full review finished.\n\nActionable comments posted: 1\n\nThe stall gate is never armed.')")]")" \
  1 "carry no disposition"

echo "== finding 21: a verdict is a fixed shape, not a phrase with an open tail =="
# "[^\n]{0,40}" after the Codex phrase accepted a P1 on the same line as a verdict, and a
# one-line phrase with no reviewed-commit line, which Codex never posts. The sign-off is
# now one of an enumerated list; the reviewed-commit line is required; and only the About
# Codex details block is stripped, since any other details block is where findings fold.
for signoff in ' :rocket:' ' Keep it up!' " You're on a roll."; do
  run_case "the codex sign-off '$signoff' is a verdict" \
    "$(wrap6 "[$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body "$signoff" deadbeef)")]")" \
    0 "HEAD COVERED"
done
run_case "the codex phrase with a P1 on the same line is not a verdict" \
  "$(wrap6 "[$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z '"Codex Review: Didn'"'"'t find any major issues. P1: drops data"')]")" \
  1 "carry no disposition" "UNREVIEWED HEAD"
run_case "the codex phrase alone, without the reviewed-commit line, is not a verdict" \
  "$(wrap6 "[$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z '"Codex Review: Didn'"'"'t find any major issues."')]")" \
  1 "carry no disposition" "UNREVIEWED HEAD"
run_case "a P1 on the codex phrase line, in the posted shape, is claimable, not coverage" \
  "$(wrap6 "[$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' P1: drops data' deadbeef)")]")" \
  1 "carry no disposition" "UNREVIEWED HEAD"
run_case "a details block other than About Codex is not stripped" \
  "$(wrap6 "[$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body $'\n\n<details><summary>Findings</summary>\nP1: drops data\n</details>' deadbeef)")]")" \
  1 "carry no disposition" "UNREVIEWED HEAD"

echo "== finding 22: only a listed review bot can issue a verdict =="
# The verdict words from anyone but the Bot account of a listed reviewer are an ordinary
# comment: claimable like any other, and never coverage. Both fixtures name the head in
# the reviewed-commit line, so only the author decides the outcome.
run_case "a human posting the codex verdict is claimable, not coverage" \
  "$(wrap6 "[$(cmt helpful-human User 2026-01-02T01:00:00Z "$(codex_body ' Bravo.' deadbeef)")]")" \
  1 "carry no disposition" "UNREVIEWED HEAD"
run_case "an unlisted bot posting the codex verdict is claimable, not coverage" \
  "$(wrap6 "[$(cmt some-other-bot Bot 2026-01-02T01:00:00Z "$(codex_body ' Bravo.' deadbeef)")]")" \
  1 "carry no disposition" "UNREVIEWED HEAD"

echo "== finding 23: a codex verdict is bound to the commit it names, not merely dated =="
# A review of the OLD head that finishes after the new one arrives is dated after arrival
# too. Codex names the commit it reviewed, so that sha must be a prefix of the head.
run_case "a codex verdict naming an older commit is not coverage" \
  "$(wrap6 "[$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Bravo.' abc123def4)")]")" \
  1 "UNREVIEWED HEAD"
# Guard, green before and after: a verdict for an older commit is still a verdict, and a
# head covered by a review object does not go BLOCKED over an undisposed stale verdict.
run_case "a codex verdict naming an older commit needs no disposition" \
  "$(wrap9 "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Bravo.' abc123def4)")")" \
  0 "CLEAR"

echo "== finding 24: a trigger is a documented bot command, nothing else =="
# TRIGGER_RE accepted any mention plus up to two words, so "@me drops records" was exempt
# from claimable and the gate reported CLEAR with nothing answered.
run_case "a mention plus two words is a claim, not a trigger" \
  "$(wrap4 me '[]' '[]' "[$(cmt anyone User 2026-01-01T00:00:00Z '"@me drops records"')]")" \
  1 "BLOCKED" "carry no disposition"
run_case "a listed bot's mention with a non-command is a claim" \
  "$(wrap4 me '[]' '[]' "[$(cmt anyone User 2026-01-01T00:00:00Z '"@codex drops records"')]")" \
  1 "BLOCKED" "carry no disposition"
# Guards, green before and after: the documented commands stay exempt, in any case,
# because GitHub logins are case-insensitive.
run_case "@coderabbitai full review is a trigger, not a finding" \
  "$(wrap4 me '[]' '[]' "[$(cmt anyone User 2026-01-01T00:00:00Z '"@coderabbitai full review"')]")" \
  0 "CLEAR"
run_case "@coderabbitai resume is a trigger, not a finding" \
  "$(wrap4 me '[]' '[]' "[$(cmt anyone User 2026-01-01T00:00:00Z '"@coderabbitai resume"')]")" \
  0 "CLEAR"
run_case "@codex security review is a trigger, not a finding" \
  "$(wrap4 me '[]' '[]' "[$(cmt anyone User 2026-01-01T00:00:00Z '"@codex security review"')]")" \
  0 "CLEAR"
run_case "a trigger in another case is still a trigger" \
  "$(wrap4 me '[]' '[]' "[$(cmt anyone User 2026-01-01T00:00:00Z '"@CodeRabbitAI review"')]")" \
  0 "CLEAR"

echo "== finding 25: only CodeRabbit's known note is stripped before the shape check =="
# Every line starting with ">" was dropped before the whole-comment check, so a bot that
# quoted its finding, "> P1: this drops records", had posted a verdict and covered the head.
run_case "a codex verdict quoting a finding is claimable, not coverage" \
  "$(wrap6 "[$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body $'\n\n> P1: this drops records' deadbeef)")]")" \
  1 "carry no disposition" "UNREVIEWED HEAD"
run_case "a coderabbit reply quoting a finding is claimable" \
  "$(wrap6 "[$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(cr_body $'Full review finished.\n\n> P1: this drops records')")]")" \
  1 "carry no disposition"
# The live note shape stays exempt: "a coderabbit reply with its note needs no disposition".

echo "== finding 26: a CodeRabbit result is bound to the head by the commit it names =="
# CodeRabbit's reply names nothing. Binding it to the latest review request posted after
# arrival was timestamp ordering: a review of the OLD head that finished after a new
# request counted as that request's answer. The walkthrough comment CodeRabbit edits in
# place names the range it reviewed after a review with no comments, so that is the
# signal (bodies copied from #815 and #872), and the reply is a notice.
run_case "an old review finishing after a new request is not coverage" \
  "$(wrap6 "[$(cmt me User 2026-01-02T00:20:00Z '"@coderabbitai review"'),$(cmt me User 2026-01-02T00:40:00Z '"@coderabbitai review"'),$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(cr_body 'Full review finished.')")]")" \
  1 "UNREVIEWED HEAD"
HEAD40=5f8a63e13cd9fdc777d23165ecd5f149fb93f848
BASE40=1aa0e96276e5500e60fc93f56d3c74298b4a2ba3
OLD40=eb7fa388b1685edcb70514be82f072d7d6525819
# wrap6 with a full-length head, which the walkthrough range names in full.
wrap7() { printf '{"data":{"repository":{"pullRequest":{"author":{"login":"me"},"headRefOid":"%s","commits":{"nodes":[{"commit":{"committedDate":"2026-01-02T00:00:00Z","checkSuites":{"nodes":[{"createdAt":"2026-01-02T00:30:00Z"}]}}}]},"reviewThreads":{"nodes":[]},"reviews":{"nodes":[{"author":{"login":"codex"},"state":"COMMENTED","submittedAt":"2026-01-01T00:00:00Z","lastEditedAt":null,"body":"","commit":{"oid":"0ldc0mm1t"}}]},"comments":{"nodes":%s},"recheck":{"comments":{"nodes":%s}}}}}}' "$HEAD40" "$1" "${2:-$1}"; }
# CodeRabbit's walkthrough after a review that produced no comments (#815): the block
# between the recent_review markers names the range reviewed, from $1 to $2.
cr_walkthrough() { jq -n --arg from "$1" --arg to "$2" '"<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n<!-- recent_review_start -->\n\nNo actionable comments were generated in the recent review. 🎉\n\n<details>\n<summary>ℹ️ Recent review info</summary>\n\n<details>\n<summary>⚙️ Run configuration</summary>\n\n**Configuration used**: defaults\n\n**Review profile**: CHILL\n\n**Plan**: Pro Plus\n\n**Run ID**: `80692642-637e-46d1-bd3e-dea6682a1c78`\n\n</details>\n\n<details>\n<summary>📥 Commits</summary>\n\nReviewing files that changed from the base of the PR and between \($from) and \($to).\n\n</details>\n\n<details>\n<summary>📒 Files selected for processing (1)</summary>\n\n* `scripts/check-review-threads.sh`\n\n</details>\n\n</details>\n\n---\n\n\n\n<!-- recent_review_end -->\n<!-- walkthrough_start -->\n\n<details>\n<summary>📝 Walkthrough</summary>\n\n## Walkthrough\n\nThe review gate binds a CodeRabbit result to the head it names.\n\n</details>\n\n<!-- walkthrough_end -->"'; }
# The same comment while CodeRabbit is rate limited (#872): the notice quotes the range a
# review WOULD cover, and no review ran.
cr_walkthrough_limited() { jq -n --arg from "$1" --arg to "$2" '"<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n\n> [!WARNING]\n> ## Review limit reached\n> \n> **Next included review available in 51 minutes.**\n> \n> <details>\n> <summary>View limit details</summary>\n> \n> **Limit details:** You have used the included review currently available.\n> \n> **Review configuration:**\n> \n> <details>\n> <summary>📥 Commits</summary>\n> \n> Reviewing files that changed from the base of the PR and between \($from) and \($to).\n> \n> </details>\n> \n> </details>\n\n<!-- end of auto-generated comment: rate limited by coderabbit.ai -->\n<!-- walkthrough_start -->\n\n## Walkthrough\n\nThe review gate binds a CodeRabbit result to the head it names.\n\n<!-- walkthrough_end -->"'; }
# The walkthrough is a bot comment and claimable like any other, so each case answers it.
ANSWER=$(cmt me User 2026-01-02T02:00:00Z '"NOT-A-DEFECT: the walkthrough is a summary, not a finding"')
run_case "a walkthrough whose recent review ends at the head covers it" \
  "$(wrap7 "[$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_walkthrough "$BASE40" "$HEAD40")" 2026-01-02T01:00:00Z),$ANSWER]")" \
  0 "HEAD COVERED"
# Guards, green before and after.
run_case "a walkthrough whose recent review ends at an older commit is not coverage" \
  "$(wrap7 "[$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_walkthrough "$BASE40" "$OLD40")" 2026-01-02T01:00:00Z),$ANSWER]")" \
  1 "UNREVIEWED HEAD"
run_case "a range quoted in the rate-limit notice is not coverage" \
  "$(wrap7 "[$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_walkthrough_limited "$BASE40" "$HEAD40")" 2026-01-02T01:00:00Z),$ANSWER]")" \
  1 "UNREVIEWED HEAD"
run_case "a walkthrough edited before the head arrived is not coverage" \
  "$(wrap7 "[$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_walkthrough "$BASE40" "$HEAD40")" 2026-01-02T00:10:00Z),$ANSWER]")" \
  1 "UNREVIEWED HEAD"
run_case "a walkthrough from an unlisted bot is not coverage" \
  "$(wrap7 "[$(cmt some-other-bot Bot 2026-01-01T00:00:00Z "$(cr_walkthrough "$BASE40" "$HEAD40")" 2026-01-02T01:00:00Z),$ANSWER]")" \
  1 "UNREVIEWED HEAD"

echo "== finding 27: a verdict covers a head that has no review object at all =="
# HEAD COVERED required anyreview > 0, but a no-findings verdict has no review object, so
# a head whose only review result was a valid Codex verdict could not be reported covered.
VERDICT_CMT=$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Bravo.' deadbeef)")
run_case "a codex verdict is coverage when no review objects exist" \
  "$(printf '{"data":{"repository":{"pullRequest":{"author":{"login":"me"},"headRefOid":"deadbeef","commits":{"nodes":[{"commit":{"committedDate":"2026-01-02T00:00:00Z","checkSuites":{"nodes":[{"createdAt":"2026-01-02T00:30:00Z"}]}}}]},"reviewThreads":{"nodes":[]},"reviews":{"nodes":[]},"comments":{"nodes":[%s]},"recheck":{"comments":{"nodes":[%s]}}}}}}' "$VERDICT_CMT" "$VERDICT_CMT")" \
  0 "HEAD COVERED"

echo "== finding 28: a walkthrough after a review that did not run clean is not coverage =="
# The recent-review block names its range after a FAILED review too. On #853 and #792 it
# ended at the head, carried no "No actionable comments were generated" line, sat under a
# "Review failed" caution, and no review object existed on the head; the gate printed
# HEAD COVERED. The range alone proves nothing. A walkthrough now covers only when its
# recent-review block says no actionable comments were generated, the summarize marker is
# its only auto-generated-comment marker, and it carries no blockquoted heading (every
# CodeRabbit notice title is one: Review failed / skipped / limit reached, Reviews paused;
# the in-progress notice has a marker and no heading). Notice bodies copied from #853,
# #869, #874, #837 and #872; the rest of the comment is the #853 body.
NOTICE_FAILED=$'<!-- This is an auto-generated comment: failure by coderabbit.ai -->\n\n> [!CAUTION]\n> ## Review failed\n> \n> The pull request is closed.\n\n<!-- end of auto-generated comment: failure by coderabbit.ai -->\n\n'
NOTICE_LIMITED=$'<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n\n> [!WARNING]\n> ## Review limit reached\n> \n> **Next included review available in 27 minutes.**\n> \n> <details>\n> <summary>View limit details</summary>\n> \n> **Limit details:** You’ve used the included review currently available.\n> \n> </details>\n\n<!-- end of auto-generated comment: rate limited by coderabbit.ai -->\n'
NOTICE_SKIPPED=$'<!-- This is an auto-generated comment: skip review by coderabbit.ai -->\n\n> [!IMPORTANT]\n> ## Review skipped\n> \n> Auto reviews are disabled on base/target branches other than the default branch.\n> \n> Please check the settings in the CodeRabbit UI or the `.coderabbit.yaml` file in this repository. To trigger a single review, invoke the `@coderabbitai review` command.\n\n<!-- end of auto-generated comment: skip review by coderabbit.ai -->\n\n'
NOTICE_PAUSED=$'<!-- This is an auto-generated comment: review paused by coderabbit.ai -->\n\n> [!NOTE]\n> ## Reviews paused\n> \n> It looks like this branch is under active development. To avoid overwhelming you with review comments due to an influx of new commits, CodeRabbit has automatically paused this review.\n\n<!-- end of auto-generated comment: review paused by coderabbit.ai -->\n'
NOTICE_PROGRESS=$'<!-- This is an auto-generated comment: review in progress by coderabbit.ai -->\n\n> [!NOTE]\n> Currently processing new changes in this PR. This may take a few minutes, please wait...\n\n<!-- end of auto-generated comment: review in progress by coderabbit.ai -->\n'
# A heading with no marker: not observed live, pinned so the two rules are independent.
NOTICE_HEADING_ONLY=$'\n> [!CAUTION]\n> ## Review failed\n> \n> The pull request is closed.\n\n'
# The #853 walkthrough with notice $1 above a recent-review block from $3 to $4; $2 is
# "clean" for the no-actionable line CodeRabbit adds after a review with no comments, or
# "failed" for the block as a failed review leaves it. "none" for $1 or $4 omits that part.
cr_walk() { jq -n --arg notice "$1" --arg clean "$2" --arg from "$3" --arg to "$4" '
  "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n<!-- review_stack_entry_start -->\n\n[![Review Change Stack](https://storage.googleapis.com/coderabbit_public_assets/review-stack-in-coderabbit-ui.svg)](https://app.coderabbit.ai/change-stack/ejc3/fcvm/pull/853)\n\n<!-- review_stack_entry_end -->\n"
  + (if $notice == "none" then "" else $notice end)
  + (if $to == "none" then "" else
      "<!-- recent_review_start -->\n\n"
      + (if $clean == "clean" then "No actionable comments were generated in the recent review. 🎉\n\n" else "" end)
      + "<details>\n<summary>ℹ️ Recent review info</summary>\n\n<details>\n<summary>⚙️ Run configuration</summary>\n\n**Configuration used**: defaults\n\n**Review profile**: CHILL\n\n**Plan**: Pro Plus\n\n**Run ID**: `e2d05d3e-3f22-4137-a868-25f7f24b39df`\n\n</details>\n\n<details>\n<summary>📥 Commits</summary>\n\nReviewing files that changed from the base of the PR and between \($from) and \($to).\n\n</details>\n\n<details>\n<summary>📒 Files selected for processing (1)</summary>\n\n* `tests/test_ci_workflow_coverage.rs`\n\n</details>\n\n</details>\n\n---\n\n\n\n<!-- recent_review_end -->\n" end)
  + "<!-- walkthrough_start -->\n\n<details>\n<summary>📝 Walkthrough</summary>\n\n## Walkthrough\n\nThe CI workflow updates path classification, renamed-file handling, and fail-open gate outputs.\n\n</details>\n\n<!-- walkthrough_end -->"'; }
run_case "the #853 shape: a failed review whose range ends at the head is not coverage" \
  "$(wrap7 "[$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_walk "$NOTICE_FAILED" failed "$BASE40" "$HEAD40")" 2026-01-02T01:00:00Z),$ANSWER]")" \
  1 "UNREVIEWED HEAD"
run_case "a range line without the no-actionable line is not coverage, even with no notice" \
  "$(wrap7 "[$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_walk none failed "$BASE40" "$HEAD40")" 2026-01-02T01:00:00Z),$ANSWER]")" \
  1 "UNREVIEWED HEAD"
run_case "a rate-limit notice beside a clean recent review at the head is not coverage (#869)" \
  "$(wrap7 "[$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_walk "$NOTICE_LIMITED" clean "$BASE40" "$HEAD40")" 2026-01-02T01:00:00Z),$ANSWER]")" \
  1 "UNREVIEWED HEAD"
run_case "a skipped-review notice beside a clean recent review at the head is not coverage" \
  "$(wrap7 "[$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_walk "$NOTICE_SKIPPED" clean "$BASE40" "$HEAD40")" 2026-01-02T01:00:00Z),$ANSWER]")" \
  1 "UNREVIEWED HEAD"
run_case "a paused-reviews notice beside a clean recent review at the head is not coverage" \
  "$(wrap7 "[$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_walk "$NOTICE_PAUSED" clean "$BASE40" "$HEAD40")" 2026-01-02T01:00:00Z),$ANSWER]")" \
  1 "UNREVIEWED HEAD"
run_case "an in-progress notice (marker, no heading) beside a clean recent review is not coverage" \
  "$(wrap7 "[$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_walk "$NOTICE_PROGRESS" clean "$BASE40" "$HEAD40")" 2026-01-02T01:00:00Z),$ANSWER]")" \
  1 "UNREVIEWED HEAD"
run_case "a Review failed heading with no marker is still a notice, not coverage" \
  "$(wrap7 "[$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_walk "$NOTICE_HEADING_ONLY" clean "$BASE40" "$HEAD40")" 2026-01-02T01:00:00Z),$ANSWER]")" \
  1 "UNREVIEWED HEAD"
# Guards, green before and after: the live skipped and in-progress shapes carry no
# recent-review block at all, and the clean shape built here still covers.
run_case "the live skipped shape (#874), with no recent review block, is not coverage" \
  "$(wrap7 "[$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_walk "$NOTICE_SKIPPED" clean "$BASE40" none)" 2026-01-02T01:00:00Z),$ANSWER]")" \
  1 "UNREVIEWED HEAD"
run_case "the live in-progress shape (#872), with no recent review block, is not coverage" \
  "$(wrap7 "[$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_walk "$NOTICE_PROGRESS" clean "$BASE40" none)" 2026-01-02T01:00:00Z),$ANSWER]")" \
  1 "UNREVIEWED HEAD"
run_case "the #853 body with a clean recent review at the head and no notice covers" \
  "$(wrap7 "[$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_walk none clean "$BASE40" "$HEAD40")" 2026-01-02T01:00:00Z),$ANSWER]")" \
  0 "HEAD COVERED"

echo "== finding 29: a head with no review result of any kind is unreviewed, not clear =="
# Finding 27 let a bound verdict cover a head with no review objects, but the blocking
# branch still required a review object to exist ("reviews exist, none on this commit").
# So reviews [] plus a verdict that does NOT bind (an older sha; the head's sha but dated
# before arrival; no check suite to date it against) printed neither HEAD COVERED nor
# UNREVIEWED HEAD and exited CLEAR: a PR whose only review ever was a clean pass on an
# older commit went CLEAR after a push, the race the coverage rule exists for. The head
# must be covered whether or not any review object exists, a PR with no review at all is
# an unreviewed head, and a payload that names no head cannot be judged (regression case
# below).
# The PR's own commits, which is the universe an abbreviated sha is resolved against
# (finding 37). $4 overrides it, as the whole connection: the nodes plus the totalCount
# that says how many there are (finding 39). By default the head is the only commit.
PRCOMMITS_HEAD='{"totalCount":1,"nodes":[{"commit":{"oid":"deadbeef"}}]}'
wrap8() { printf '{"data":{"repository":{"pullRequest":{"author":{"login":"me"},"headRefOid":"deadbeef","commits":{"nodes":[{"commit":{"committedDate":"2026-01-02T00:00:00Z","checkSuites":{"nodes":%s}}}]},"prcommits":%s,"reviewThreads":{"nodes":[]},"reviews":{"nodes":[]},"comments":{"nodes":[%s]},"recheck":{"comments":{"nodes":[%s]}}}}}}' "$1" "${4:-$PRCOMMITS_HEAD}" "$2" "${3:-$2}"; }
SUITE='[{"createdAt":"2026-01-02T00:30:00Z"}]'
run_case "reviews [] and a codex verdict naming an older sha is an unreviewed head" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Bravo.' abc123def4)")")" \
  1 "UNREVIEWED HEAD" "the head commit has not been reviewed"
run_case "reviews [] and a head-sha verdict dated before arrival is an unreviewed head" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T00:10:00Z "$(codex_body ' Bravo.' deadbeef)")")" \
  1 "UNREVIEWED HEAD" "the head commit has not been reviewed"
run_case "reviews [] and a head-sha verdict with no check suite (arrival unknown) is an unreviewed head" \
  "$(wrap8 '[]' "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Bravo.' deadbeef)")")" \
  1 "UNREVIEWED HEAD" "the head commit has not been reviewed"
# Guard, green before and after: the bound verdict from finding 27 still covers.
run_case "reviews [] and a head-sha verdict dated after arrival still covers" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Bravo.' deadbeef)")")" \
  0 "HEAD COVERED"

echo "== finding 30: Codex's review-summary comment is a notice, and a sha-bound verdict =="
# Since 2026-08-28 ~21:25Z Codex no longer posts "Didn't find any major issues" per review.
# It opens ONE comment per PR carrying <!-- codex-pull-request-review-summary --> when a
# review starts and EDITS that comment in place as reviews finish, so its createdAt predates
# every result in it and only a row's own datetime dates that row. Bodies copied from
# #867/#872/#873/#874, whose rows all read: Completed, a 7-char commit, "Manual request".
# The comment is a notice — never a finding — and it covers the head when a row is Completed,
# names a prefix of the head and is dated after the head arrived. Anything else in the table
# (a review still running, a status this gate has never seen, a row it cannot parse) makes
# the whole comment cover nothing, because a table with a review still in it is a review
# that has not finished.
#
# $1 status, $2 datetime, $3 commit, $4 review name. The live status cell reads
# "✅ **Completed**" and an unfinished one is not observed here, so the icon is fixed and
# the rule keys on the bolded word.
sum_row() { printf '| 📝 **%s** | ✅ **%s** <relative-time datetime="%s">%s</relative-time> | `%s` | Manual request |' "${4:-Code Review}" "$1" "$2" "$2" "$3"; }
codex_summary() { jq -n --arg rows "$1" '"<!-- codex-pull-request-review-summary -->\n\n## Codex Review Summary\n\nThis comment shows the latest Codex review activity on this pull request.\n\n| Review | Status | Commit | Review trigger |\n| --- | --- | --- | --- |\n\($rows)\n\n\n\n<details> <summary>ℹ️ About Codex in GitHub</summary>\n<br/>\n\n[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you\n- Open a pull request for review\n- Mark a draft as ready\n- Comment \"@codex review\" or \"@codex security review\".\n\nCodex reacts with 👀 while any review is running, comments if it has suggestions, and reacts with 👍 once all reviews finish with no findings.\n\n</details>"'; }
# The #867 shape: the comment was created at 00:20, BEFORE the head arrived at 00:30, and
# edited at 01:00 when the review finished. createdAt cannot date this result; the row can.
run_case "the live #867 shape: a summary row Completed at the head covers it" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T00:20:00Z "$(codex_summary "$(sum_row Completed 2026-01-02T01:00:00.123456Z deadbee)")" 2026-01-02T01:00:05Z)")" \
  0 "HEAD COVERED"
run_case "a summary comment needs no disposition" \
  "$(wrap9 "$(cmt "$CODEX" Bot 2026-01-02T00:20:00Z "$(codex_summary "$(sum_row Completed 2026-01-02T01:00:00.123456Z deadbee)")" 2026-01-02T01:00:05Z)")" \
  0 "CLEAR"
# The rest answer the summary with $ANSWER, so coverage is the only thing left to decide.
run_case "a summary row naming an older commit is not coverage" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T00:20:00Z "$(codex_summary "$(sum_row Completed 2026-01-02T01:00:00.123456Z abc123def4)")" 2026-01-02T01:00:05Z),$ANSWER")" \
  1 "UNREVIEWED HEAD"
run_case "a summary row dated before the head arrived is not coverage" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T00:20:00Z "$(codex_summary "$(sum_row Completed 2026-01-02T00:10:00.123456Z deadbee)")" 2026-01-02T01:00:05Z),$ANSWER")" \
  1 "UNREVIEWED HEAD"
run_case "a summary row still in progress is not coverage" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T00:20:00Z "$(codex_summary "$(sum_row 'In progress' 2026-01-02T01:00:00.123456Z deadbee)")" 2026-01-02T01:00:05Z),$ANSWER")" \
  1 "UNREVIEWED HEAD"
run_case "one Completed row at the head beside one still in progress is not coverage" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T00:20:00Z "$(codex_summary "$(sum_row Completed 2026-01-02T01:00:00.123456Z deadbee)
$(sum_row 'In progress' 2026-01-02T01:02:00.123456Z deadbee 'Security Review')")" 2026-01-02T01:02:05Z),$ANSWER")" \
  1 "UNREVIEWED HEAD"
run_case "a Completed row with an unparsable datetime is not coverage" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T00:20:00Z "$(codex_summary "$(sum_row Completed 'a while ago' deadbee)")" 2026-01-02T01:00:05Z),$ANSWER")" \
  1 "UNREVIEWED HEAD"
run_case "a summary table row this gate cannot parse is not coverage" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T00:20:00Z "$(codex_summary '| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="2026-01-02T01:00:00.123456Z">t</relative-time> |')" 2026-01-02T01:00:05Z),$ANSWER")" \
  1 "UNREVIEWED HEAD"
run_case "a human posting the summary body is claimable, not coverage" \
  "$(wrap8 "$SUITE" "$(cmt helpful-human User 2026-01-02T00:20:00Z "$(codex_summary "$(sum_row Completed 2026-01-02T01:00:00.123456Z deadbee)")" 2026-01-02T01:00:05Z)")" \
  1 "carry no disposition" "UNREVIEWED HEAD"
run_case "an unlisted bot posting the summary body is claimable, not coverage" \
  "$(wrap8 "$SUITE" "$(cmt some-other-bot Bot 2026-01-02T00:20:00Z "$(codex_summary "$(sum_row Completed 2026-01-02T01:00:00.123456Z deadbee)")" 2026-01-02T01:00:05Z)")" \
  1 "carry no disposition" "UNREVIEWED HEAD"
# The legacy comment may still appear, and both shapes are Codex verdicts: a summary that
# binds nothing does not take away what the legacy verdict covers.
run_case "the legacy verdict still covers beside a summary that binds nothing" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Bravo.' deadbeef)"),$(cmt "$CODEX" Bot 2026-01-02T00:20:00Z "$(codex_summary "$(sum_row 'In progress' 2026-01-02T01:00:00.123456Z deadbee)")" 2026-01-02T01:00:05Z),$ANSWER")" \
  0 "HEAD COVERED"

echo "== finding 31: a coverage-bearing comment must still say what it said =="
# The gate reads the PR comments FIRST and pages threads afterwards, which on a real PR is
# long enough for a bot to edit what it just read. Two of the three coverage signals are one
# comment their bot edits in place: CodeRabbit's walkthrough and Codex's review summary. The
# final consistency check re-read only headRefOid, so a walkthrough that went from a clean
# review to a failed one, with the head standing still, still granted coverage from a body
# captured minutes earlier — the gate certifying a head from a comment it could no longer
# quote. fetch_payload now re-reads the comments after all paging and the gate compares the
# two reads; the payload carries the second one under `recheck`, so these fixtures exercise
# the same comparison a live run does.
CLEAN_WALK=$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_walk none clean "$BASE40" "$HEAD40")" 2026-01-02T01:00:00Z)
FAILED_WALK=$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_walk "$NOTICE_FAILED" failed "$BASE40" "$HEAD40")" 2026-01-02T01:20:00Z)
run_case "a walkthrough that goes clean -> failed between the two reads blocks" \
  "$(wrap7 "[$CLEAN_WALK,$ANSWER]" "[$FAILED_WALK,$ANSWER]")" \
  2 "changed under us"
SUM_DONE=$(cmt "$CODEX" Bot 2026-01-02T00:20:00Z "$(codex_summary "$(sum_row Completed 2026-01-02T01:00:00.123456Z deadbee)")" 2026-01-02T01:00:05Z)
SUM_RUNNING=$(cmt "$CODEX" Bot 2026-01-02T00:20:00Z "$(codex_summary "$(sum_row 'In progress' 2026-01-02T01:10:00.123456Z deadbee)")" 2026-01-02T01:10:05Z)
run_case "a summary that goes Completed -> in progress between the two reads blocks" \
  "$(wrap8 "$SUITE" "$SUM_DONE,$ANSWER" "$SUM_RUNNING,$ANSWER")" \
  2 "changed under us"
# A payload that grants coverage from an editable comment and carries no second read of it
# cannot be judged: one read cannot show what a comment said when the run ended.
run_case "a coverage-bearing comment with no second read at all blocks" \
  "$(printf '{"data":{"repository":{"pullRequest":{"author":{"login":"me"},"headRefOid":"deadbeef","commits":{"nodes":[{"commit":{"committedDate":"2026-01-02T00:00:00Z","checkSuites":{"nodes":%s}}}]},"reviewThreads":{"nodes":[]},"reviews":{"nodes":[]},"comments":{"nodes":[%s]}}}}}' "$SUITE" "$SUM_DONE,$ANSWER")" \
  2 "no second read"
# Guards, green before and after: an unchanged second read changes nothing, and a comment
# that cannot grant coverage is not compared, so ordinary traffic arriving mid-run does not
# block. (Every other case in this file is also a guard for the unchanged path, since the
# builders default the second read to the first.)
run_case "an unchanged second read still covers" \
  "$(wrap8 "$SUITE" "$SUM_DONE,$ANSWER" "$SUM_DONE,$ANSWER")" \
  0 "HEAD COVERED"
run_case "a comment that cannot grant coverage may differ between the reads" \
  "$(wrap7 "[$CLEAN_WALK,$(cmt onlooker User 2026-01-02T00:50:00Z '"first wording"'),$ANSWER]" \
           "[$CLEAN_WALK,$(cmt onlooker User 2026-01-02T00:50:00Z '"edited wording"' 2026-01-02T01:30:00Z),$ANSWER]")" \
  0 "HEAD COVERED"

# Every gh shim below answers the PR's commit list from this file: the two heads the live
# cases use, and the totalCount that says the list is whole (finding 39). A case about
# resolving an abbreviation overwrites it.
PRCOMMITS_LIVE=$(printf '{"data":{"repository":{"pullRequest":{"commits":{"totalCount":2,"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"commit":{"oid":"deadbeef"}},{"commit":{"oid":"%s"}}]}}}}}' "$HEAD40")

echo "== finding 31: the LIVE path takes the second read =="
# --from-file can only prove the comparison. That the gate actually re-fetches is a property
# of fetch_payload, so it is tested through the gh shim: the second `comments(first:` query
# is answered with an edited walkthrough, and the run must block. If the gate never issued
# that query, comments2.json would go unread and this case would pass with CLEAR.
mkdir -p "$TMP/bin"
printf '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}}' > "$TMP/threads.json"
printf '{"data":{"repository":{"pullRequest":{"author":{"login":"me"},"headRefOid":"%s","commits":{"nodes":[{"commit":{"committedDate":"2026-01-02T00:00:00Z","checkSuites":{"nodes":[{"createdAt":"2026-01-02T00:30:00Z"}]}}}]},"reviews":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}}' "$HEAD40" > "$TMP/reviews.json"
printf '{"data":{"repository":{"pullRequest":{"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[%s,%s]}}}}}' "$CLEAN_WALK" "$ANSWER" > "$TMP/comments.json"
printf '{"data":{"repository":{"pullRequest":{"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[%s,%s]}}}}}' "$FAILED_WALK" "$ANSWER" > "$TMP/comments2.json"
cat > "$TMP/bin/gh" <<'SHIM'
#!/bin/bash
case "$*" in
  *"commits(first"*)   cat "$GATE_TEST_DIR/prcommits.json" ;;
  *reviewThreads*)     cat "$GATE_TEST_DIR/threads.json" ;;
  *"reviews(first"*)   cat "$GATE_TEST_DIR/reviews.json" ;;
  *"comments(first"*)
    n=$(cat "$GATE_TEST_DIR/ccount" 2>/dev/null || echo 0); n=$((n+1))
    printf '%s' "$n" > "$GATE_TEST_DIR/ccount"
    if [ "$n" -le 1 ]; then cat "$GATE_TEST_DIR/comments.json"; else cat "$GATE_TEST_DIR/comments2.json"; fi ;;
  *headRefOid*)        printf '%s\n' "$GATE_TEST_HEAD" ;;  # the recheck passes --jq
esac
SHIM
printf '%s' "$PRCOMMITS_LIVE" > "$TMP/prcommits.json"
chmod +x "$TMP/bin/gh"
rm -f "$TMP/ccount"
out=$(GATE_TEST_DIR="$TMP" GATE_TEST_HEAD="$HEAD40" PATH="$TMP/bin:$PATH" bash "$GATE" 1 2>&1); rc=$?
if [ "$rc" = 2 ] && grep -qF "changed under us" <<<"$out" && [ "$(cat "$TMP/ccount")" -ge 2 ]; then
  echo "  PASS  the live path re-reads the comments and blocks when one changed"; pass=$((pass+1))
else
  echo "  FAIL  the live path re-reads the comments and blocks when one changed (rc=$rc, comment fetches=$(cat "$TMP/ccount" 2>/dev/null))"
  sed 's/^/          /' <<<"$out" | head -4
  fail=$((fail+1))
fi

echo "== finding 32: timestamps are ordered as instants, not as strings =="
# Every ordering decision here compares two GitHub timestamps, and they do not all arrive
# in one shape. Check-suite and comment timestamps come back whole-second
# ("2026-01-02T00:30:00Z"); the datetime Codex writes into a review-summary row carries a
# fraction ("2026-01-02T00:30:00.123456Z"). Compared as strings, "." sorts before "Z", so a
# row completed in the same second as the head's check suite reads as EARLIER than it and
# the head stays uncovered for as long as that row is the only coverage. String order also
# accepts anything that is not a timestamp at all: "a while ago" sorts after every digit, so
# a walkthrough or an answer with an unparsable date used to postdate everything.
run_case "a summary row completed in the same second as the head arrival covers it" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T00:20:00Z "$(codex_summary "$(sum_row Completed 2026-01-02T00:30:00.100Z deadbee)")" 2026-01-02T00:30:05Z)")" \
  0 "HEAD COVERED"
run_case "a disposition posted in the same second as the claim answers it" \
  "$(wrap4 me '[]' '[]' "[$(cmt codex Bot 2026-01-02T00:30:00Z '"P1: this drops the last row"'),$(cmt me User 2026-01-02T00:30:00.100Z '"RED-VERIFIED: tests/row.rs"')]")" \
  0 "CLEAR"
run_case "a disposition 0.1s BEFORE the claim does not answer it" \
  "$(wrap4 me '[]' '[]' "[$(cmt codex Bot 2026-01-02T00:30:00.100Z '"P1: this drops the last row"'),$(cmt me User 2026-01-02T00:30:00Z '"RED-VERIFIED: tests/row.rs"')]")" \
  1 "carry no disposition"
run_case "a verdict timestamped in a non-UTC offset is ordered as the instant it names" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T01:00:00+01:00 "$(codex_body ' Bravo.' deadbeef)")")" \
  1 "UNREVIEWED HEAD"
run_case "arrival is the earliest check suite by instant, not by string" \
  "$(wrap8 '[{"createdAt":"2026-01-02T00:30:00.900Z"},{"createdAt":"2026-01-02T00:30:00Z"}]' "$(cmt "$CODEX" Bot 2026-01-02T00:30:00.500Z "$(codex_body ' Bravo.' deadbeef)")")" \
  0 "HEAD COVERED"
# An unparsable timestamp orders against nothing, so it grants no coverage and answers no
# claim. Every field the gate orders by is validated, so it says so and exits 2 rather than
# carrying an unordered value into a comparison. updatedAt joined that list with finding 36.
run_case "a check-suite timestamp that will not parse blocks" \
  "$(wrap8 '[{"createdAt":"2026-01-02T00:30"}]' "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Bravo.' deadbeef)")")" \
  2 "check-suite timestamp"
run_case "a review body whose timestamp will not parse blocks" \
  "$(wrap '[]' '[{"author":{"login":"codex"},"state":"COMMENTED","submittedAt":"a while ago","lastEditedAt":null,"body":"P1: this drops the last row"}]')" \
  2 "no parsable submittedAt"
run_case "an answer whose timestamp will not parse answers nothing" \
  "$(wrap4 me '[]' '[]' "[$(cmt codex Bot 2026-01-02T00:30:00Z '"P1: this drops the last row"'),$(cmt me User yesterday '"RED-VERIFIED: tests/row.rs"')]")" \
  2 "no parsable createdAt"
run_case "a walkthrough whose updatedAt will not parse blocks" \
  "$(wrap7 "[$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_walk none clean "$BASE40" "$HEAD40")" 'a while ago'),$ANSWER]")" \
  2 "no parsable updatedAt"
# Guard: the parse is UTC (jq mktime is timegm), so a verdict must not depend on where the
# runner sits. The same fixture under a non-UTC zone reaches the same verdict.
export TZ=America/New_York
run_case "the same-second verdict holds under a non-UTC host timezone" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T00:20:00Z "$(codex_summary "$(sum_row Completed 2026-01-02T00:30:00.100Z deadbee)")" 2026-01-02T00:30:05Z)")" \
  0 "HEAD COVERED"
unset TZ

echo "== finding 33: a zone offset's minutes are minutes, not seconds =="
# `ts` built the offset as $zh * 3600 + $zm, adding the MINUTES field as seconds. Z, +00:00
# and every whole-hour offset are exact, which is why the +01:00 case above passes; a
# half- or quarter-hour zone is off by $zm * 59 seconds, up to 44 minutes. The direction is
# fail-open for positive offsets on both ordering sites: the instant reads LATER than it is,
# so a verdict recorded before the head arrived covers it, and a claim edited after its
# answer reads as though it came first.
# Head arrival is 2026-01-02T00:30:00Z in every wrap8 case below.
run_case "a +05:30 verdict 5 minutes before arrival is not coverage" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T05:55:00+05:30 "$(codex_body ' Bravo.' deadbeef)")")" \
  1 "UNREVIEWED HEAD"
run_case "a +09:30 verdict a minute before arrival is not coverage" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T09:59:00+09:30 "$(codex_body ' Bravo.' deadbeef)")")" \
  1 "UNREVIEWED HEAD"
run_case "a +12:45 verdict a minute before arrival is not coverage" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T13:14:00+12:45 "$(codex_body ' Bravo.' deadbeef)")")" \
  1 "UNREVIEWED HEAD"
# A negative half-hour offset reads EARLIER than it is, which fails open on the claim side:
# the claim's true instant 04:05:00Z is after the answer's 04:00:00Z, so it is unanswered.
run_case "a -03:30 claim posted after its answer is not answered by it" \
  "$(wrap4 me '[]' '[]' "[$(cmt codex Bot 2026-01-02T00:35:00-03:30 '"P1: this drops the last row"'),$(cmt me User 2026-01-02T04:00:00Z '"RED-VERIFIED: tests/row.rs"')]")" \
  1 "carry no disposition"
# Guards, green before and after: a half-hour verdict that really is after arrival covers,
# and whole-hour offsets were never affected.
run_case "a +09:30 verdict 5 minutes after arrival covers the head" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T10:05:00+09:30 "$(codex_body ' Bravo.' deadbeef)")")" \
  0 "HEAD COVERED"

echo "== finding 34: only Codex, in the whole shape it posts, writes a review summary =="
# is_codex_summary was `contains("<!-- codex-pull-request-review-summary -->")` applied to
# any listed bot, so two things followed. CodeRabbit carrying that marker became a Codex
# summary: exempt from dispositions, and its table read as coverage. And a real finding from
# Codex that merely QUOTED the marker stopped being claimable, which is a P1 exiting CLEAR
# with nothing answered. The marker must open the comment, the comment must be the whole
# posted shape (heading, the one-line explanation, the four-column table header, its
# separator, and table rows to the end), and the account must be Codex.
codex_summary_plus() { jq -n --argjson b "$(codex_summary "$1")" --arg x "$2" '$b + "\n\n" + $x'; }
run_case "a coderabbit comment in the codex summary shape is a finding, not coverage" \
  "$(wrap8 "$SUITE" "$(cmt coderabbitai Bot 2026-01-02T00:20:00Z "$(codex_summary "$(sum_row Completed 2026-01-02T01:00:00.123456Z deadbee)")" 2026-01-02T01:00:05Z)")" \
  1 "carry no disposition" "UNREVIEWED HEAD"
run_case "a codex finding that quotes the summary marker is claimable" \
  "$(wrap9 "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(jq -n '"P1: this drops the last row.\n\nThe run is in the summary comment (<!-- codex-pull-request-review-summary -->)."')")")" \
  1 "carry no disposition"
run_case "a codex summary with a finding appended after the table is claimable, not coverage" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T00:20:00Z "$(codex_summary_plus "$(sum_row Completed 2026-01-02T01:00:00.123456Z deadbee)" 'P1: this drops the last row')" 2026-01-02T01:00:05Z)")" \
  1 "carry no disposition" "UNREVIEWED HEAD"
run_case "a codex summary missing the table header is claimable, not coverage" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T00:20:00Z "$(jq -n --arg r "$(sum_row Completed 2026-01-02T01:00:00.123456Z deadbee)" '"<!-- codex-pull-request-review-summary -->\n\n\($r)"')" 2026-01-02T01:00:05Z)")" \
  1 "carry no disposition" "UNREVIEWED HEAD"
# Guards, green before and after: the shape Codex actually posts still covers and still needs
# no disposition, and CodeRabbit's own walkthrough is judged by its own rule.
run_case "the posted codex summary shape still covers the head" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T00:20:00Z "$(codex_summary "$(sum_row Completed 2026-01-02T01:00:00.123456Z deadbee)")" 2026-01-02T01:00:05Z)")" \
  0 "HEAD COVERED"
run_case "a coderabbit walkthrough is still judged as a walkthrough" \
  "$(wrap7 "[$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_walk none clean "$BASE40" "$HEAD40")" 2026-01-02T01:00:00Z),$ANSWER]")" \
  0 "HEAD COVERED"

echo "== finding 35: the gate judges the FINAL snapshot, not the one it opened with =="
# The second read existed only to fingerprint the comments that can grant coverage, and the
# verdict was still computed from the FIRST read. Everything else that arrived or vanished
# while the gate paged threads was invisible: a P1 posted mid-run went unjudged, and a
# disposition deleted mid-run still answered its claim. The PR-level bodies are now taken
# from the final read of the comments.
COV_C=$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Bravo.' deadbeef)")
LATE_CLAIM=$(cmt reviewer User 2026-01-02T01:10:00Z '"P1: this drops the last row"')
LATE_DISP=$(cmt me User 2026-01-02T01:20:00Z '"NOT-A-DEFECT: the guard above rejects that input"')
NEW_CLAIM=$(cmt reviewer User 2026-01-02T01:30:00Z '"P1: this one landed while the gate was paging"')
run_case "a disposition deleted between the two reads leaves its claim unanswered" \
  "$(wrap8 "$SUITE" "$COV_C,$LATE_CLAIM,$LATE_DISP" "$COV_C,$LATE_CLAIM")" \
  1 "carry no disposition"
run_case "a claim that lands between the two reads is judged, not missed" \
  "$(wrap8 "$SUITE" "$COV_C" "$COV_C,$NEW_CLAIM")" \
  1 "carry no disposition"
# Guards, green before and after: an unchanged second read reaches the same verdict, and a
# disposition present in both still answers.
run_case "an unchanged second read reaches the same verdict" \
  "$(wrap8 "$SUITE" "$COV_C,$LATE_CLAIM,$LATE_DISP" "$COV_C,$LATE_CLAIM,$LATE_DISP")" \
  0 "HEAD COVERED"

echo "== finding 35: reviews and threads are consistency-checked too =="
# Comments are re-read and re-judged; reviews and threads are re-read and COMPARED, because
# re-paging every thread body would double the cost of the slowest part of the run. Either
# one moving means the reading was taken from data that has since changed, so it blocks.
# Both are live-path properties, so both go through the gh shim: with only one read of each,
# the second file is never fetched and the run reports CLEAR.
mkdir -p "$TMP/bin"
printf '{"data":{"repository":{"pullRequest":{"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}}' > "$TMP/comments.json"
printf '{"data":{"repository":{"pullRequest":{"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}}' > "$TMP/comments2.json"
printf '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}}' > "$TMP/threads.json"
printf '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"id":"T1","isResolved":false,"comments":{"totalCount":1,"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"author":{"login":"reviewer"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:25:00Z","lastEditedAt":null,"body":"P1: this landed while the gate was paging"}]}}]}}}}}' > "$TMP/threads2.json"
review_payload() { printf '{"data":{"repository":{"pullRequest":{"author":{"login":"me"},"headRefOid":"deadbeef","commits":{"nodes":[{"commit":{"committedDate":"2026-01-02T00:00:00Z","checkSuites":{"nodes":[{"createdAt":"2026-01-02T00:30:00Z"}]}}}]},"prcommits":{"totalCount":1,"nodes":[{"commit":{"oid":"deadbeef"}}]},"reviews":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"author":{"login":"reviewer"},"state":"COMMENTED","submittedAt":"2026-01-02T01:00:00Z","lastEditedAt":null,"body":%s,"commit":{"oid":"deadbeef"},"comments":{"totalCount":1,"nodes":[{"replyTo":null}]}}]}}}}}' "$1"; }
review_payload '""' > "$TMP/reviews.json"
review_payload '"P1: this landed while the gate was paging"' > "$TMP/reviews2.json"
cat > "$TMP/bin/gh" <<'SHIM'
#!/bin/bash
nth() { local f=$GATE_TEST_DIR/$1.count n; n=$(cat "$f" 2>/dev/null || echo 0); n=$((n+1)); printf '%s' "$n" > "$f"; printf '%s' "$n"; }
case "$*" in
  *"commits(first"*)   cat "$GATE_TEST_DIR/prcommits.json" ;;
  *reviewThreads*)
    if [ "$(nth threads)" -le 1 ]; then cat "$GATE_TEST_DIR/threads.json"; else cat "$GATE_TEST_DIR/${GATE_TEST_THREADS2:-threads}.json"; fi ;;
  *"reviews(first"*)
    if [ "$(nth reviews)" -le 1 ]; then cat "$GATE_TEST_DIR/reviews.json"; else cat "$GATE_TEST_DIR/${GATE_TEST_REVIEWS2:-reviews}.json"; fi ;;
  *"comments(first"*)  cat "$GATE_TEST_DIR/comments.json" ;;
  *headRefOid*)        printf 'deadbeef\n' ;;  # the recheck passes --jq
esac
SHIM
printf '%s' "$PRCOMMITS_LIVE" > "$TMP/prcommits.json"
chmod +x "$TMP/bin/gh"
live_case() {
  local name=$1 want_rc=$2 want_txt=$3 out rc
  rm -f "$TMP/threads.count" "$TMP/reviews.count"
  out=$(GATE_TEST_DIR="$TMP" PATH="$TMP/bin:$PATH" bash "$GATE" 1 2>&1); rc=$?
  if [ "$rc" = "$want_rc" ] && grep -qF "$want_txt" <<<"$out"; then
    echo "  PASS  $name"; pass=$((pass+1))
  else
    echo "  FAIL  $name (rc=$rc want=$want_rc)"; sed 's/^/          /' <<<"$out" | head -4; fail=$((fail+1))
  fi
}
GATE_TEST_REVIEWS2=reviews2 live_case "a review body edited between the two reads blocks" 2 "reviews on this PR changed"
GATE_TEST_THREADS2=threads2 live_case "a thread opened between the two reads blocks" 2 "review threads on this PR changed"
# Guard, green before and after: unchanged reviews and threads reach a verdict.
live_case "unchanged reviews and threads still reach a verdict" 0 "CLEAR"

echo "== finding 36: a comment is dated by its last edit, not by its creation =="
# Comments are mutable and GitHub keeps createdAt fixed across edits. Ordering claims and
# answers by createdAt therefore reads the CURRENT body against the ORIGINAL time: a comment
# opened Jan 1, edited Jan 3 to add a defect, counted as answered by a Jan 2 disposition.
# updatedAt dates the body the gate is actually reading, and is validated like createdAt.
# That dates a CLAIM. An answer is dated by its creation here (addition 6d), so the upstream
# case below, where an answer created before the claim and edited after it answered it, is
# kept renamed and now expects BLOCKED.
run_case "a comment edited after its answer is not answered by it" \
  "$(wrap4 me '[]' '[]' "[$(cmt reviewer User 2026-01-01T00:00:00Z '"P1: this drops the last row"' 2026-01-03T00:00:00Z),$(cmt me User 2026-01-02T00:00:00Z '"RED-VERIFIED: tests/row.rs"')]")" \
  1 "carry no disposition"
run_case "node-monorepo-perf: a disposition edited after the claim does not answer it (upstream: a disposition edited after the claim answers it)" \
  "$(wrap4 me '[]' '[]' "[$(cmt reviewer User 2026-01-02T00:00:00Z '"P1: this drops the last row"'),$(cmt me User 2026-01-01T00:00:00Z '"RED-VERIFIED: tests/row.rs"' 2026-01-03T00:00:00Z)]")" \
  1 "carry no disposition"
run_case "a PR comment whose updatedAt will not parse blocks" \
  "$(wrap4 me '[]' '[]' "[$(cmt reviewer User 2026-01-02T00:30:00Z '"P1: this drops the last row"' 'a while ago')]")" \
  2 "no parsable updatedAt"
# Guards, green before and after: an unedited comment orders the same either way, and an
# edit that lands before the answer is still answered.
run_case "a comment edited before its answer is still answered" \
  "$(wrap4 me '[]' '[]' "[$(cmt reviewer User 2026-01-01T00:00:00Z '"P1: this drops the last row"' 2026-01-02T00:00:00Z),$(cmt me User 2026-01-03T00:00:00Z '"RED-VERIFIED: tests/row.rs"')]")" \
  0 "CLEAR"

echo "== finding 37: a seven-character prefix is not a commit identity =="
# Coverage matched the sha a bot named against the head with `startswith`, so any commit
# whose abbreviation prefixes the head could cover it: a result for the OLD head, named as
# `deadbee`, certified the NEW head `deadbeef`. An abbreviation now has to resolve to
# exactly one of the PR's commits and that commit has to be the head; a full sha still
# matches by identity.
# deadbee abbreviates both of these, so on this PR it names neither.
PRCOMMITS_AMBIG='{"totalCount":2,"nodes":[{"commit":{"oid":"deadbee0"}},{"commit":{"oid":"deadbeef"}}]}'
# The head is not in this list, so deadbee resolves to a commit that is not the head.
PRCOMMITS_OTHER='{"totalCount":1,"nodes":[{"commit":{"oid":"deadbee0"}}]}'
run_case "a summary row naming a prefix two PR commits share is not coverage" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T00:20:00Z "$(codex_summary "$(sum_row Completed 2026-01-02T01:00:00.123456Z deadbee)")" 2026-01-02T01:00:05Z),$ANSWER" "" "$PRCOMMITS_AMBIG")" \
  1 "UNREVIEWED HEAD"
run_case "a codex verdict naming a prefix two PR commits share is not coverage" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Bravo.' deadbee)")" "" "$PRCOMMITS_AMBIG")" \
  1 "UNREVIEWED HEAD"
run_case "an abbreviation that resolves to a commit other than the head is not coverage" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Bravo.' deadbee)")" "" "$PRCOMMITS_OTHER")" \
  1 "UNREVIEWED HEAD"
# Guards, green before and after: an abbreviation unique among the PR's commits still
# resolves to the head, and a full sha matches by identity without resolving anything.
run_case "an abbreviation unique among the PR's commits still covers" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Bravo.' deadbee)")")" \
  0 "HEAD COVERED"
run_case "the full head sha still covers" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Bravo.' deadbeef)")")" \
  0 "HEAD COVERED"
run_case "an abbreviation of a sibling commit is not coverage" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Bravo.' deadbee0)")" "" "$PRCOMMITS_AMBIG")" \
  1 "UNREVIEWED HEAD"

echo "== finding 38: a date that does not exist is not a date =="
# mktime NORMALISES out-of-range components, so "2026-02-31T01:00:00Z" converts to
# 2026-03-03T01:00:00Z and orders as a real instant three days later. Every ordering site
# then treats it as a timestamp, and a summary row or a check suite carrying one can grant
# coverage. The day is now checked against the month's real length, leap years included.
SUITE_MAR='[{"createdAt":"2026-03-02T00:30:00Z"}]'
run_case "a summary row dated 2026-02-31 is not coverage" \
  "$(wrap8 "$SUITE_MAR" "$(cmt "$CODEX" Bot 2026-03-02T00:20:00Z "$(codex_summary "$(sum_row Completed 2026-02-31T01:00:00.123456Z deadbee)")" 2026-03-02T01:00:05Z),$ANSWER")" \
  1 "UNREVIEWED HEAD"
run_case "a check-suite timestamp of 2026-02-31 blocks" \
  "$(wrap8 '[{"createdAt":"2026-02-31T00:30:00Z"}]' "$(cmt "$CODEX" Bot 2026-03-04T01:00:00Z "$(codex_body ' Bravo.' deadbeef)")")" \
  2 "check-suite timestamp"
run_case "a check-suite timestamp of 2026-02-29 blocks (2026 is not a leap year)" \
  "$(wrap8 '[{"createdAt":"2026-02-29T00:30:00Z"}]' "$(cmt "$CODEX" Bot 2026-03-04T01:00:00Z "$(codex_body ' Bravo.' deadbeef)")")" \
  2 "check-suite timestamp"
run_case "a check-suite timestamp of 2026-04-31 blocks (April has 30 days)" \
  "$(wrap8 '[{"createdAt":"2026-04-31T00:30:00Z"}]' "$(cmt "$CODEX" Bot 2026-05-04T01:00:00Z "$(codex_body ' Bravo.' deadbeef)")")" \
  2 "check-suite timestamp"
run_case "a review submittedAt of 2026-02-31 blocks" \
  "$(wrap '[]' '[{"author":{"login":"x"},"state":"COMMENTED","submittedAt":"2026-02-31T00:00:00Z","lastEditedAt":null,"body":"P1: this drops the last row"}]')" \
  2 "no parsable submittedAt"
# Guards, green before and after: real dates still parse, including a leap day.
run_case "2028-02-29 is a real date and still orders" \
  "$(wrap8 '[{"createdAt":"2028-02-29T00:30:00Z"}]' "$(cmt "$CODEX" Bot 2028-02-29T01:00:00Z "$(codex_body ' Bravo.' deadbeef)")")" \
  0 "HEAD COVERED"
run_case "2026-02-28 is a real date and still orders" \
  "$(wrap8 '[{"createdAt":"2026-02-28T00:30:00Z"}]' "$(cmt "$CODEX" Bot 2026-02-28T01:00:00Z "$(codex_body ' Bravo.' deadbeef)")")" \
  0 "HEAD COVERED"

echo "== regression: the original behaviours still hold =="
run_case "unresolved thread blocks" \
  "$(wrap '[{"isResolved":false,"comments":{"nodes":[{"author":{"login":"x"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:26:00Z","lastEditedAt":null,"body":"something"}]}}]')" \
  1 "UNRESOLVED"
# This case expected CLEAR until finding 29: a payload with no threads, no reviews and no
# head names nothing this gate can certify as reviewed, so it is BLOCKED, not CLEAR. The
# literal is what wrap used to build before it put the head on a covered commit.
run_case "no threads, no reviews and no head is BLOCKED, not CLEAR (was the fail-open)" \
  '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]},"reviews":{"nodes":[]}}}}}' \
  2 "BLOCKED"

echo "== finding 19: a 128 KiB thread body must not kill the live-path merge =="
# fetch_payload's final jq used --argjson, putting each array in ONE argv string;
# Linux caps a single argv string at MAX_ARG_STRLEN (128 KiB), so any real PR whose
# accumulated bodies pass that died with "Argument list too long", payload came back
# empty, and the gate fail-closed FOREVER on exactly the big PRs it exists for.
# Reached through the live path with a gh shim, since --from-file skips the merge.
mkdir -p "$TMP/bin"
big_body=$(printf 'x%.0s' $(seq 1 200000))
printf '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"id":"T1","isResolved":true,"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"databaseId":1,"author":{"login":"reviewer"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:00:00Z","lastEditedAt":null,"body":"%s"},{"databaseId":2,"author":{"login":"me"},"path":"a.ts","line":1,"createdAt":"2026-01-02T00:00:00Z","lastEditedAt":null,"body":"NOT-A-DEFECT: fixture padding, not a finding"}]}}]}}}}}' "$big_body" > "$TMP/threads.json"
printf '{"data":{"repository":{"pullRequest":{"author":{"login":"me"},"headRefOid":"deadbeef","reviews":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"author":{"login":"reviewer"},"state":"COMMENTED","submittedAt":"2026-01-02T00:00:00Z","lastEditedAt":null,"body":"","commit":{"oid":"deadbeef"},"comments":{"totalCount":1,"nodes":[{"replyTo":null}]}}]}}}}}' > "$TMP/reviews.json"
printf '{"data":{"repository":{"pullRequest":{"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}}' > "$TMP/comments.json"
# Quoted delimiter: nothing in the shim expands at write time; GATE_TEST_DIR
# arrives via the environment when the gate execs gh.
cat > "$TMP/bin/gh" <<'SHIM'
#!/bin/bash
case "$*" in
  *"commits(first"*)   cat "$GATE_TEST_DIR/prcommits.json" ;;
  *reviewThreads*)     cat "$GATE_TEST_DIR/threads.json" ;;
  *"reviews(first"*)   cat "$GATE_TEST_DIR/reviews.json" ;;
  *"comments(first"*)  cat "$GATE_TEST_DIR/comments.json" ;;
  *headRefOid*)        printf 'deadbeef\n' ;;  # the recheck passes --jq; apply it here
esac
SHIM
printf '%s' "$PRCOMMITS_LIVE" > "$TMP/prcommits.json"
chmod +x "$TMP/bin/gh"
out=$(GATE_TEST_DIR="$TMP" PATH="$TMP/bin:$PATH" bash "$GATE" 1 2>&1); rc=$?
if [ "$rc" = 0 ] && grep -qF "CLEAR" <<<"$out" && ! grep -qi "argument list too long" <<<"$out"; then
  echo "  PASS  oversized thread body evaluates instead of dying on argv"; pass=$((pass+1))
else
  echo "  FAIL  oversized thread body evaluates instead of dying on argv (rc=$rc)"
  sed 's/^/          /' <<<"$out" | head -4
  fail=$((fail+1))
fi

echo "== finding 20: an OVERSIZED thread's paged comments ride an fd too =="
# The pagination path rebuilt the thread with --argjson c "$all_comments" — the
# same MAX_ARG_STRLEN hazard as finding 19, reachable only when one thread's
# totalCount exceeds COMMENTS_PAGE_SIZE. Shrunk to 2 here so three comments,
# one of them ~200 KiB, walk the paging loop.
printf '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"id":"T1","isResolved":true,"comments":{"totalCount":3,"pageInfo":{"hasNextPage":true,"endCursor":"CUR1"},"nodes":[{"databaseId":1,"author":{"login":"reviewer"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:00:00Z","lastEditedAt":null,"body":"%s"},{"databaseId":2,"author":{"login":"someone"},"path":"a.ts","line":1,"createdAt":"2026-01-01T01:00:00Z","lastEditedAt":null,"body":"discussion"}]}}]}}}}}' "$big_body" > "$TMP/threads.json"
printf '{"data":{"node":{"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"author":{"login":"me"},"path":"a.ts","line":1,"createdAt":"2026-01-01T00:27:00Z","lastEditedAt":null,"body":"NOT-A-DEFECT: fixture padding, not a finding"}]}}}}' > "$TMP/threadpage.json"
cat > "$TMP/bin/gh" <<'SHIM'
#!/bin/bash
case "$*" in
  *"commits(first"*)   cat "$GATE_TEST_DIR/prcommits.json" ;;
  *"node(id"*)         cat "$GATE_TEST_DIR/threadpage.json" ;;
  *reviewThreads*)     cat "$GATE_TEST_DIR/threads.json" ;;
  *"reviews(first"*)   cat "$GATE_TEST_DIR/reviews.json" ;;
  *"comments(first"*)  cat "$GATE_TEST_DIR/comments.json" ;;
  *headRefOid*)        printf 'deadbeef\n' ;;  # the recheck passes --jq; apply it here
esac
SHIM
printf '%s' "$PRCOMMITS_LIVE" > "$TMP/prcommits.json"
chmod +x "$TMP/bin/gh"
out=$(COMMENTS_PAGE_SIZE=2 GATE_TEST_DIR="$TMP" PATH="$TMP/bin:$PATH" bash "$GATE" 1 2>&1); rc=$?
if [ "$rc" = 0 ] && grep -qF "CLEAR" <<<"$out" && ! grep -qi "argument list too long" <<<"$out"; then
  echo "  PASS  oversized paged thread evaluates instead of dying on argv"; pass=$((pass+1))
else
  echo "  FAIL  oversized paged thread evaluates instead of dying on argv (rc=$rc)"
  sed 's/^/          /' <<<"$out" | head -4
  fail=$((fail+1))
fi

echo "== finding 39: an abbreviation resolves against the WHOLE commit list, or none =="
# The PR's commits arrived as `commits(last: 100)`, and names_head resolves an abbreviated
# sha against that list. Past 100 commits an omitted OLDER commit sharing the head's
# seven-character prefix is invisible: the abbreviation resolves to the head alone, reads
# as unambiguous, and a result issued for the old commit certifies the head. The connection
# is now paged to completion and carries the count of what it should hold, so a list that
# does not account for every commit resolves nothing.
PRCOMMITS_TRUNC='{"totalCount":2,"nodes":[{"commit":{"oid":"deadbeef"}}]}'
PRCOMMITS_NOCOUNT='{"nodes":[{"commit":{"oid":"deadbeef"}}]}'
run_case "a commit list holding fewer commits than it says blocks" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Bravo.' deadbee)")" "" "$PRCOMMITS_TRUNC")" \
  2 "does not account for every commit"
run_case "a commit list that says nothing about its size blocks" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Bravo.' deadbee)")" "" "$PRCOMMITS_NOCOUNT")" \
  2 "does not account for every commit"
# Guards, green before and after: a complete list still resolves an abbreviation, and a
# payload with no commit list at all is no universe, so an abbreviation resolves to nothing
# while a full sha still matches by identity.
run_case "a complete commit list still resolves the abbreviation" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Bravo.' deadbee)")")" \
  0 "HEAD COVERED"
run_case "no commit list at all resolves no abbreviation" \
  "$(wrap6 "[$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Bravo.' deadbee)")]")" \
  1 "UNREVIEWED HEAD"
run_case "no commit list at all still matches a full sha by identity" \
  "$(wrap6 "[$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Bravo.' deadbeef)")]")" \
  0 "HEAD COVERED"

echo "== finding 39: the LIVE path pages the commit list to completion =="
# --from-file can only prove the completeness check. That the gate FETCHES every commit is
# a property of fetch_payload, so it goes through the gh shim: 150 commits whose oldest
# shares the head's seven-character prefix. One `commits(last: 100)` omits that commit, the
# verdict's `deadbee` resolves to the head alone, and the head reads as covered by a result
# bound to nothing. With both pages fetched it is ambiguous, and it covers nothing.
mkdir -p "$TMP/bin"
HEAD150=deadbeef00000000000000000000000000000000
python3 - "$TMP" "$HEAD150" <<'COMMITS'
import json, sys
tmp, head = sys.argv[1:3]
old = "deadbee0" + "0" * 32                       # shares deadbee with the head
oids = [old] + ["%040x" % (0xaaa0000 + i) for i in range(148)] + [head]
assert len(oids) == 150 and len(set(oids)) == 150
def page(nodes, has_next, cursor):
    return {"data": {"repository": {"pullRequest": {"commits": {
        "totalCount": len(oids),
        "pageInfo": {"hasNextPage": has_next, "endCursor": cursor},
        "nodes": [{"commit": {"oid": o}} for o in nodes]}}}}}
json.dump(page(oids[:100], True, "C1"), open(tmp + "/prcommits.json", "w"))
json.dump(page(oids[100:], False, None), open(tmp + "/prcommits2.json", "w"))
# What `commits(last: 100)` returned: the NEWEST 100, without the old commit that shares
# the head's prefix. An unpaged gate reads this and resolves deadbee to the head alone.
json.dump({"data": {"repository": {"pullRequest": {
    "author": {"login": "me"}, "headRefOid": head,
    "commits": {"nodes": [{"commit": {"committedDate": "2026-01-02T00:00:00Z",
        "checkSuites": {"nodes": [{"createdAt": "2026-01-02T00:30:00Z"}]}}}]},
    "prcommits": {"nodes": [{"commit": {"oid": o}} for o in oids[50:]]},
    "reviews": {"pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": []}}}}},
    open(tmp + "/reviews.json", "w"))
COMMITS
printf '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}}' > "$TMP/threads.json"
printf '{"data":{"repository":{"pullRequest":{"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[%s]}}}}}' \
  "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Bravo.' deadbee)")" > "$TMP/comments.json"
cat > "$TMP/bin/gh" <<'SHIM'
#!/bin/bash
case "$*" in
  *"commits(first"*)
    n=$(cat "$GATE_TEST_DIR/pcount" 2>/dev/null || echo 0); n=$((n+1))
    printf '%s' "$n" > "$GATE_TEST_DIR/pcount"
    if [ "$n" -le 1 ]; then cat "$GATE_TEST_DIR/prcommits.json"; else cat "$GATE_TEST_DIR/prcommits2.json"; fi ;;
  *reviewThreads*)     cat "$GATE_TEST_DIR/threads.json" ;;
  *"reviews(first"*)   cat "$GATE_TEST_DIR/reviews.json" ;;
  *"comments(first"*)  cat "$GATE_TEST_DIR/comments.json" ;;
  *headRefOid*)        printf '%s\n' "$GATE_TEST_HEAD" ;;  # the recheck passes --jq
esac
SHIM
chmod +x "$TMP/bin/gh"
rm -f "$TMP/pcount"
out=$(GATE_TEST_DIR="$TMP" GATE_TEST_HEAD="$HEAD150" PATH="$TMP/bin:$PATH" bash "$GATE" 1 2>&1); rc=$?
if [ "$rc" = 1 ] && grep -qF "UNREVIEWED HEAD" <<<"$out" && [ "$(cat "$TMP/pcount" 2>/dev/null || echo 0)" -ge 2 ]; then
  echo "  PASS  the live path pages every commit, so a shared prefix stays ambiguous"; pass=$((pass+1))
else
  echo "  FAIL  the live path pages every commit, so a shared prefix stays ambiguous (rc=$rc, commit fetches=$(cat "$TMP/pcount" 2>/dev/null || echo 0))"
  sed 's/^/          /' <<<"$out" | head -4
  fail=$((fail+1))
fi

echo "== finding 40: the thread comparison must read the comment BODIES =="
# The second read of the threads fetched only id, isResolved and comments.totalCount, and
# the verdict is computed from the first read's BODIES. GitHub lets a review comment be
# edited in place, which moves none of those three: a disposition edited mid-run into
# something that disposes of nothing leaves the fingerprint identical, and the gate certifies
# a thread from a reply that no longer exists. Both reads now fetch the comments, paging the
# oversized ones exactly as the first read does, and any difference blocks.
mkdir -p "$TMP/bin"
thread_read() {  # $1 the reply on the thread, $2 totalCount, $3.. the page-1 comments
  local reply=$1
  printf '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"id":"T1","isResolved":true,"isOutdated":false,"comments":{"totalCount":2,"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"author":{"login":"reviewer"},"path":"a.ts","line":1,"originalLine":1,"createdAt":"2026-01-01T00:28:00Z","lastEditedAt":null,"body":"this drops the last row"},{"author":{"login":"me"},"path":"a.ts","line":1,"originalLine":1,"createdAt":"2026-01-01T00:29:00Z","lastEditedAt":null,"body":%s}]}}]}}}}}' "$reply"
}
thread_read '"NOT-A-DEFECT: renamed only, no behaviour change"' > "$TMP/threads.json"
thread_read '"Actually the rename changed behaviour, this still drops the row"' > "$TMP/threads2.json"
printf '{"data":{"repository":{"pullRequest":{"author":{"login":"me"},"headRefOid":"deadbeef","commits":{"nodes":[{"commit":{"committedDate":"2026-01-02T00:00:00Z","checkSuites":{"nodes":[{"createdAt":"2026-01-02T00:30:00Z"}]}}}]},"reviews":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"author":{"login":"reviewer"},"state":"COMMENTED","submittedAt":"2026-01-02T01:00:00Z","lastEditedAt":null,"body":"","commit":{"oid":"deadbeef"},"comments":{"totalCount":1,"nodes":[{"replyTo":null}]}}]}}}}}' > "$TMP/reviews.json"
printf '{"data":{"repository":{"pullRequest":{"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}}' > "$TMP/comments.json"
# An oversized thread: page 1 holds the finding and one line of chatter, page 2 holds the
# reply, and the reply is what gets edited between the reads.
printf '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"id":"T1","isResolved":true,"isOutdated":false,"comments":{"totalCount":3,"pageInfo":{"hasNextPage":true,"endCursor":"CUR1"},"nodes":[{"author":{"login":"reviewer"},"path":"a.ts","line":1,"originalLine":1,"createdAt":"2026-01-01T00:30:00Z","lastEditedAt":null,"body":"this drops the last row"},{"author":{"login":"onlooker"},"path":"a.ts","line":1,"originalLine":1,"createdAt":"2026-01-01T00:31:00Z","lastEditedAt":null,"body":"discussion"}]}}]}}}}}' > "$TMP/paged.json"
threadpage() { printf '{"data":{"node":{"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"author":{"login":"me"},"path":"a.ts","line":1,"originalLine":1,"createdAt":"2026-01-01T00:32:00Z","lastEditedAt":null,"body":%s}]}}}}' "$1"; }
threadpage '"NOT-A-DEFECT: renamed only, no behaviour change"' > "$TMP/threadpage.json"
threadpage '"Actually the rename changed behaviour, this still drops the row"' > "$TMP/threadpage2.json"
printf '%s' "$PRCOMMITS_LIVE" > "$TMP/prcommits.json"
cat > "$TMP/bin/gh" <<'SHIM'
#!/bin/bash
nth() { local f=$GATE_TEST_DIR/$1.count n; n=$(cat "$f" 2>/dev/null || echo 0); n=$((n+1)); printf '%s' "$n" > "$f"; printf '%s' "$n"; }
case "$*" in
  *"commits(first"*)   cat "$GATE_TEST_DIR/prcommits.json" ;;
  *"node(id"*)
    if [ "$(nth page)" -le 1 ]; then cat "$GATE_TEST_DIR/threadpage.json"
    else cat "$GATE_TEST_DIR/${GATE_TEST_PAGE2:-threadpage}.json"; fi ;;
  *reviewThreads*)
    if [ "$(nth threads)" -le 1 ]; then cat "$GATE_TEST_DIR/${GATE_TEST_THREADS1:-threads}.json"
    else cat "$GATE_TEST_DIR/${GATE_TEST_THREADS2:-${GATE_TEST_THREADS1:-threads}}.json"; fi ;;
  *"reviews(first"*)   cat "$GATE_TEST_DIR/reviews.json" ;;
  *"comments(first"*)  cat "$GATE_TEST_DIR/comments.json" ;;
  *headRefOid*)        printf 'deadbeef\n' ;;  # the recheck passes --jq
esac
SHIM
chmod +x "$TMP/bin/gh"
edit_case() {
  local name=$1 want_rc=$2 want_txt=$3 out rc
  rm -f "$TMP/threads.count" "$TMP/page.count"
  out=$(GATE_TEST_DIR="$TMP" PATH="$TMP/bin:$PATH" bash "$GATE" 1 2>&1); rc=$?
  if [ "$rc" = "$want_rc" ] && grep -qF "$want_txt" <<<"$out"; then
    echo "  PASS  $name"; pass=$((pass+1))
  else
    echo "  FAIL  $name (rc=$rc want=$want_rc)"; sed 's/^/          /' <<<"$out" | head -4; fail=$((fail+1))
  fi
}
GATE_TEST_THREADS2=threads2 \
  edit_case "a disposition edited between the two reads blocks" 2 "review threads on this PR changed"
COMMENTS_PAGE_SIZE=2 GATE_TEST_THREADS1=paged GATE_TEST_PAGE2=threadpage2 \
  edit_case "a disposition edited on a comment PAGE blocks" 2 "review threads on this PR changed"
# Guards, green before and after: two identical reads reach a verdict, paged or not.
edit_case "two identical thread reads still reach a verdict" 0 "CLEAR"
COMMENTS_PAGE_SIZE=2 GATE_TEST_THREADS1=paged \
  edit_case "two identical paged thread reads still reach a verdict" 0 "CLEAR"

echo "== finding 41: an acknowledgement is not a new obligation =="
# A PR-level REVIEW body from the PR author was claimable like everyone else's, so the answer
# this gate itself asks for ("Post a review on the PR OPENING with one of RED-VERIFIED: /
# NOT-A-DEFECT: / DISAGREE:") became a NEW claim the moment it did not open with one of those
# three words. Every round left one more unanswered body behind, and the count only grew:
# #874 was carrying 4 of them and #872 5, all the author's own acks, drowning the bot findings
# that genuinely had no answer. A review from the author is an answer to this PR, not a
# finding against it, and the head-coverage rule already discounts the author for the same
# reason. Everyone else's review body is claimable exactly as before, and the vocabulary is
# unchanged: REVIEW-ACK is still not a disposition and still answers nothing, it merely stops
# being a claim itself.
AUTHOR_ACK='{"author":{"login":"me"},"state":"COMMENTED","submittedAt":"2026-01-05T00:00:00Z","lastEditedAt":null,"body":"REVIEW-ACK: round 3, three findings closed in abc1234"}'
BOT_CLAIM='{"author":{"login":"codex"},"state":"COMMENTED","submittedAt":"2026-01-01T00:00:00Z","lastEditedAt":null,"body":"P1: this drops the last row"}'
AUTHOR_DISP='{"author":{"login":"me"},"state":"COMMENTED","submittedAt":"2026-01-02T00:00:00Z","lastEditedAt":null,"body":"RED-VERIFIED: tests/row.rs"}'
run_case "an author review body with no disposition does not block" \
  "$(wrap '[]' "[$AUTHOR_ACK]")" 0 "CLEAR"
run_case "an author ack posted after the last disposition does not re-block" \
  "$(wrap '[]' "[$BOT_CLAIM,$AUTHOR_DISP,$AUTHOR_ACK]")" 0 "CLEAR"
# Guards, green before and after: nobody else is exempt, an author disposition still answers
# the claims that came before it, and the exemption belongs to the author's login, so it
# cannot be worn by a review that names no author, nor by anyone at all on a payload that
# names no author. (GitHub logins are unique across accounts, so no bot can hold the author's
# login; what IS reachable is an empty or absent one, and matching "" against "" would exempt
# every unattributed body on such a payload.)
run_case "a non-author review body with no disposition still blocks" \
  "$(wrap '[]' '[{"author":{"login":"reviewer"},"state":"COMMENTED","submittedAt":"2026-01-05T00:00:00Z","lastEditedAt":null,"body":"REVIEW-ACK: round 3, three findings closed in abc1234"}]')" \
  1 "carry no disposition"
run_case "an author disposition still answers a claim dated before it" \
  "$(wrap '[]' "[$BOT_CLAIM,$AUTHOR_DISP]")" 0 "CLEAR"
run_case "a review naming no author is not the author's" \
  "$(wrap '[]' '[{"author":null,"state":"COMMENTED","submittedAt":"2026-01-05T00:00:00Z","lastEditedAt":null,"body":"P1: this drops the last row"}]')" \
  1 "carry no disposition"
run_case "a payload naming no author exempts nobody" \
  "$(printf '{"data":{"repository":{"pullRequest":{"author":{"login":""},"headRefOid":"deadbeef","reviewThreads":{"nodes":[]},"reviews":{"nodes":[%s,{"author":null,"state":"COMMENTED","submittedAt":"2026-01-05T00:00:00Z","lastEditedAt":null,"body":"P1: this drops the last row"}]}}}}}' "$COVER")" \
  1 "carry no disposition"
# And the author's TOP-LEVEL COMMENT stays claimable: that is where a self-reported defect
# lands, and finding 17 pins it. Only the review body, which is the channel this gate names
# for answering, is an answer by construction.
run_case "the author's own top-level comment is still claimable" \
  "$(wrap4 me '[]' '[]' "[$(cmt me User 2026-01-05T00:00:00Z '"P1: this drops records"')]")" \
  1 "carry no disposition"

echo "== finding 42: a page this gate cannot read is not an empty page =="
# Every paging loop folded each page in with `<connection>.nodes // []` and then read
# hasNextPage from the same page. Both readings turn a response the loop CANNOT READ into
# "this connection is empty and it is finished": a null `pullRequest` (a wrong number, a
# renamed repo, a token that cannot see the PR, a partial GraphQL result) contributes no
# nodes, and hasNextPage evaluates to null rather than "true", so the loop stops holding [].
# `[]` is indistinguishable from a connection that is genuinely empty, which is the gate's
# recurring fail-open shape: a check that could not evaluate anything reporting that it
# found nothing. On the recheck comments loop it dropped every top-level claim.
#
# All of these are properties of the fetch, so they go through a gh shim. The fixture below
# carries an unanswered claim in the top-level comments and a stranger's review of the head,
# so a run that reads every page reports the claim and a run that silently empties a page
# reports CLEAR.
mkdir -p "$TMP/bin"
CLAIM42=$(cmt reviewer User 2026-01-02T01:00:00Z '"P1: this drops the last row"')
printf '{"data":{"repository":{"pullRequest":null}}}' > "$TMP/nullpr.json"
printf '{"data":{"repository":{"pullRequest":{}}}}' > "$TMP/noconn.json"
printf '{"data":{"node":null}}' > "$TMP/nullnode.json"
printf '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}}' > "$TMP/threads.json"
# One resolved thread whose comments do not fit a page: the finding and its disposition on
# page 1, one more comment on page 2. With COMMENTS_PAGE_SIZE=2 the gate pages it.
printf '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"id":"T1","isResolved":true,"isOutdated":false,"comments":{"totalCount":3,"pageInfo":{"hasNextPage":true,"endCursor":"CUR1"},"nodes":[{"author":{"login":"reviewer"},"path":"a.ts","line":1,"originalLine":1,"createdAt":"2026-01-01T00:33:00Z","lastEditedAt":null,"body":"this drops the last row"},{"author":{"login":"me"},"path":"a.ts","line":1,"originalLine":1,"createdAt":"2026-01-01T00:34:00Z","lastEditedAt":null,"body":"NOT-A-DEFECT: renamed only, no behaviour change"}]}}]}}}}}' > "$TMP/pagedthreads.json"
printf '{"data":{"node":{"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"author":{"login":"onlooker"},"path":"a.ts","line":1,"originalLine":1,"createdAt":"2026-01-01T00:35:00Z","lastEditedAt":null,"body":"discussion"}]}}}}' > "$TMP/threadpage.json"
# The same comments page, claiming a page after it and naming no cursor to fetch that page
# with. Folded in and read for hasNextPage, it ends the loop on a thread nobody finished.
printf '{"data":{"node":{"comments":{"pageInfo":{"hasNextPage":true,"endCursor":null},"nodes":[{"author":{"login":"onlooker"},"path":"a.ts","line":1,"originalLine":1,"createdAt":"2026-01-01T00:36:00Z","lastEditedAt":null,"body":"discussion"}]}}}}' > "$TMP/nodenocursor.json"
# A resolved thread of 3 comments whose FIRST page (the one that arrives with the thread
# list) already says another page follows and names no cursor. The disposition is on the
# page nobody can ask for, so a run that skips the paging judges the thread undisposed.
printf '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"id":"T1","isResolved":true,"isOutdated":false,"comments":{"totalCount":3,"pageInfo":{"hasNextPage":true,"endCursor":null},"nodes":[{"author":{"login":"reviewer"},"path":"a.ts","line":1,"originalLine":1,"createdAt":"2026-01-01T00:37:00Z","lastEditedAt":null,"body":"this drops the last row"},{"author":{"login":"onlooker"},"path":"a.ts","line":1,"originalLine":1,"createdAt":"2026-01-01T00:38:00Z","lastEditedAt":null,"body":"discussion"}]}}]}}}}}' > "$TMP/pagednocursor.json"
printf '{"data":{"repository":{"pullRequest":{"author":{"login":"me"},"headRefOid":"deadbeef","commits":{"nodes":[{"commit":{"committedDate":"2026-01-02T00:00:00Z","checkSuites":{"nodes":[{"createdAt":"2026-01-02T00:30:00Z"}]}}}]},"reviews":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"author":{"login":"reviewer"},"state":"COMMENTED","submittedAt":"2026-01-02T01:00:00Z","lastEditedAt":null,"body":"","commit":{"oid":"deadbeef"},"comments":{"totalCount":1,"nodes":[{"replyTo":null}]}}]}}}}}' > "$TMP/reviews.json"
printf '{"data":{"repository":{"pullRequest":{"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[%s]}}}}}' "$CLAIM42" > "$TMP/comments.json"
printf '{"data":{"repository":{"pullRequest":{"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}}' > "$TMP/nocomments.json"
printf '%s' "$PRCOMMITS_LIVE" > "$TMP/prcommits.json"
cat > "$TMP/bin/gh" <<'SHIM'
#!/bin/bash
# GATE_TEST_NULL names the ONE read answered with a page the gate cannot use
# (nullpr.json, or GATE_TEST_BAD=noconn for a pullRequest with no connection on it);
# every other read is answered normally. Connections read twice take a 1 or a 2.
nth() { local f=$GATE_TEST_DIR/$1.count n; n=$(cat "$f" 2>/dev/null || echo 0); n=$((n+1)); printf '%s' "$n" > "$f"; printf '%s' "$n"; }
which_read() { printf '%s%d' "$1" "$(( $(nth "$1") >= 2 ? 2 : 1 ))"; }
# $1 names the connection being read, which the nocursor page has to carry.
# GATE_TEST_BAD=nocursor answers with a page of that connection claiming another page
# follows while naming no cursor to fetch it with; GATE_TEST_CURSOR holds the JSON for
# endCursor, null by default and "" for the empty-string shape.
bad() {
  if [ "${GATE_TEST_BAD:-nullpr}" = nocursor ]; then
    printf '{"data":{"repository":{"pullRequest":{"author":{"login":"me"},"headRefOid":"deadbeef","%s":{"totalCount":1,"pageInfo":{"hasNextPage":true,"endCursor":%s},"nodes":[]}}}}}' \
      "$1" "${GATE_TEST_CURSOR:-null}"
  else cat "$GATE_TEST_DIR/${GATE_TEST_BAD:-nullpr}.json"; fi
}
case "$*" in
  *"commits(first"*)
    if [ "${GATE_TEST_NULL:-}" = commits ]; then bad commits
    else cat "$GATE_TEST_DIR/prcommits.json"; fi ;;
  *"node(id"*)
    if [ "${GATE_TEST_NULL:-}" = node ]; then cat "$GATE_TEST_DIR/${GATE_TEST_NODEBAD:-nullnode}.json"
    else cat "$GATE_TEST_DIR/threadpage.json"; fi ;;
  *reviewThreads*)
    if [ "${GATE_TEST_NULL:-}" = "$(which_read threads)" ]; then bad reviewThreads
    else cat "$GATE_TEST_DIR/${GATE_TEST_THREADS:-threads}.json"; fi ;;
  *"reviews(first"*)
    if [ "${GATE_TEST_NULL:-}" = "$(which_read reviews)" ]; then bad reviews
    else cat "$GATE_TEST_DIR/reviews.json"; fi ;;
  *"comments(first"*)
    if [ "${GATE_TEST_NULL:-}" = "$(which_read comments)" ]; then bad comments
    else cat "$GATE_TEST_DIR/${GATE_TEST_COMMENTS:-comments}.json"; fi ;;
  *headRefOid*)
    # gh --jq prints an empty line when the filter lands on a null pullRequest.
    if [ "${GATE_TEST_NULL:-}" = headread ]; then printf '\n'
    else printf 'deadbeef\n'; fi ;;
esac
SHIM
chmod +x "$TMP/bin/gh"
page_case() {
  local name=$1 want_rc=$2 want_txt=$3 out rc
  rm -f "$TMP"/threads.count "$TMP"/reviews.count "$TMP"/comments.count
  # `timeout`, because a loop that omits `after` and re-requests the first page never
  # returns. The run has to end in a FAIL naming the case, not in a hung harness.
  out=$(GATE_TEST_DIR="$TMP" PATH="$TMP/bin:$PATH" timeout 20 bash "$GATE" 1 2>&1); rc=$?
  if [ "$rc" = "$want_rc" ] && grep -qF "$want_txt" <<<"$out"; then
    echo "  PASS  $name"; pass=$((pass+1))
  else
    echo "  FAIL  $name (rc=$rc want=$want_rc)"; sed 's/^/          /' <<<"$out" | head -4; fail=$((fail+1))
  fi
}
# The reported defect: the second read of the comments, which is the read the verdict is
# computed from. Emptied, it takes every top-level claim with it and the run reports CLEAR.
GATE_TEST_NULL=comments2 \
  page_case "a recheck comment page with a null pullRequest blocks" 2 "no pull request"
GATE_TEST_NULL=comments2 GATE_TEST_BAD=noconn \
  page_case "a recheck comment page with no comments connection blocks" 2 "no nodes array"
GATE_TEST_NULL=comments1 \
  page_case "the first comment page with a null pullRequest blocks" 2 "no pull request"
GATE_TEST_NULL=reviews2 \
  page_case "a reviews recheck page with a null pullRequest blocks as unread" 2 "no pull request"
GATE_TEST_NULL=commits \
  page_case "a commit page with a null pullRequest blocks as unread" 2 "no pull request"
GATE_TEST_NULL=headread \
  page_case "a head re-read naming no commit blocks" 2 "re-read of the head"
COMMENTS_PAGE_SIZE=2 GATE_TEST_THREADS=pagedthreads GATE_TEST_COMMENTS=nocomments GATE_TEST_NULL=node \
  page_case "a thread comment page with a null node blocks instead of truncating" 2 "comments page for thread"
# Guards, green before and after: the first thread page already blocked on a null
# pullRequest and still does, pages that can all be read still reach a verdict, and the
# fixture without the claim still reaches CLEAR, which is what the red above reported.
GATE_TEST_NULL=threads1 \
  page_case "the first thread page with a null pullRequest still blocks" 2 "no pull request"
page_case "every page readable reaches a verdict on the claim" 1 "carry no disposition"
GATE_TEST_COMMENTS=nocomments \
  page_case "every page readable and no claim still clears" 0 "CLEAR"

echo "== finding 43: a page saying more follows must name the cursor to fetch it with =="
# require_page validated hasNextPage and not endCursor, so a page could say "another page
# follows" and name nothing to fetch it with. Both readings of that page are wrong in the
# gate's usual direction. In the outer loops `jq -r` renders a null endCursor as the STRING
# "null", which is the loops' own "no cursor yet" sentinel, so the next request omits
# `after` and asks for the FIRST page again: the same page answers, forever. An empty-string
# cursor sends `after: ""` and, on a source that ignores it, loops the same way. In the
# oversized-thread loop the cursor is instead tested for "null"/empty as the exit condition,
# so the loop ENDS and the thread is judged from the pages fetched so far, which is the
# truncation the transient-failure branch beside it already refuses to accept.
GATE_TEST_NULL=comments2 GATE_TEST_BAD=nocursor \
  page_case "a recheck comment page with hasNextPage and no cursor blocks" 2 "names no cursor"
GATE_TEST_NULL=comments2 GATE_TEST_BAD=nocursor GATE_TEST_CURSOR='""' \
  page_case "a recheck comment page with an empty-string cursor blocks" 2 "names no cursor"
GATE_TEST_NULL=threads1 GATE_TEST_BAD=nocursor \
  page_case "a thread page with hasNextPage and no cursor blocks" 2 "names no cursor"
COMMENTS_PAGE_SIZE=2 GATE_TEST_THREADS=pagedthreads GATE_TEST_COMMENTS=nocomments \
  GATE_TEST_NULL=node GATE_TEST_NODEBAD=nodenocursor \
  page_case "a thread comment page with no cursor blocks instead of truncating" 2 "names no cursor"
COMMENTS_PAGE_SIZE=2 GATE_TEST_THREADS=pagednocursor GATE_TEST_COMMENTS=nocomments \
  page_case "an oversized thread whose first page names no cursor blocks" 2 "thread T1"
# Guard, green before and after: hasNextPage false with a null endCursor is what the LAST
# page of every connection looks like, and it has to keep reaching a verdict. Every fixture
# above ends that way, so a rule written as "endCursor must be a string" would fail here.
page_case "a last page with hasNextPage false and a null cursor still reaches a verdict" 1 "carry no disposition"

echo "== finding 44: a bot saying its review did not run is not a finding =="
# Each listed reviewer posts a notice when it cannot review. Codex out of quota posts a
# plain top-level comment, "You have reached your Codex usage limits for code reviews",
# either that one line or the line plus an "add credits" line. CodeRabbit answers a trigger
# it cannot serve with "Review rate limited." (or "Already reviewed.", "No files to
# review.", "Pull request is closed.") folded under "Action not completed", answers a chat
# it cannot serve with "Rate Limit Exceeded", and before any review has run its summary
# comment holds nothing but a "Review limit reached" or "Review skipped" notice. Both bots
# are in VERDICT_BOTS, so none of that fell under the notification-bot exemption, and every
# such comment was a PR-level claim needing a disposition dated after it. On 2026-09-02
# #898 carried three Codex quota notices and the gate reported all three UNANSWERED (aws
# #46 one more); the author cleared them with a NOT-A-DEFECT review answering text that
# claimed nothing. That is the block-on-ordinary-traffic shape the withdrawn last-word rule
# had. A notice is now matched as a whole body, line for line, against the shapes the bots
# post here, and belongs to the bot that posts it. It needs no disposition and covers no
# head. Bodies copied from #898, aws #46, #847, #844, #846, #893, #874 and #789.
CODEX_LIMIT1=$(jq -n '"You have reached your Codex usage limits for code reviews. You can see your limits in the [Codex usage dashboard](https://chatgpt.com/codex/cloud/settings/usage)."')
CODEX_LIMIT2=$(jq -n '"You have reached your Codex usage limits for code reviews. You can see your limits in the [Codex usage dashboard](https://chatgpt.com/codex/cloud/settings/usage).\nTo continue using code reviews, add credits to your account and enable them for code reviews in your [settings](https://chatgpt.com/codex/cloud/settings/code-review)."')
# CodeRabbit's reply to a command it did not carry out, folding $1 under "Action not completed".
cr_not_done() { jq -n --arg t "$1" '"<!-- This is an auto-generated reply by CodeRabbit -->\n<!-- CodeRabbit review command invocation: 03686aea-15d0-48ab-a4bd-bf524726db31 -->\n<details>\n<summary>⚠️ Action not completed</summary>\n\n\($t)\n\n</details>"'; }
CR_INCREMENTAL_NOTE='> Note: CodeRabbit is an incremental review system and does not re-review already reviewed commits. This command is applicable only when automatic reviews are paused.'
CR_LIMITED=$(cr_not_done "Review rate limited.

$CR_INCREMENTAL_NOTE")
CR_FAIR=$(cr_not_done "Review rate limited.

---

Your included review limit is currently reached under our [Fair Usage Limits Policy](https://docs.coderabbit.ai/management/plans#fair-usage-limits-policy). This review may still proceed through usage-based billing if eligible. Your next included review will be available in 7 minutes.")
CR_ALREADY=$(cr_not_done "Already reviewed.

$CR_INCREMENTAL_NOTE")
CR_CHAT=$(jq -n '"<!-- This is an auto-generated reply by CodeRabbit -->\n### Rate Limit Exceeded\n\n`@ejc3` have exceeded the limit for the number of chat messages per hour. Please wait **3 minutes and 10 seconds** before sending another message."')
# The tips block CodeRabbit appends to its summary comment, whatever else the comment holds.
CR_TIPS=$'<!-- tips_start -->\n\n---\n\nThanks for using [CodeRabbit](https://coderabbit.ai?utm_source=oss&utm_medium=github&utm_campaign=ejc3/fcvm&utm_content=874)! It\'s free for OSS, and your support helps us grow. If you like it, consider giving us a shout-out.\n\n<details>\n<summary>❤️ Share</summary>\n\n- [X](https://twitter.com/intent/tweet?text=I%20just%20used%20%40coderabbitai%20for%20my%20code%20review%2C%20and%20it%27s%20fantastic%21&url=https%3A//coderabbit.ai)\n\n</details>\n\n\n<sub>Comment `@coderabbitai help` to get the list of available commands.</sub>\n\n<!-- tips_end -->'
# CodeRabbit's summary comment before any review has run: the summarize marker, one notice
# of kind $1 holding the blockquote $2, the tips block, and $3 (default nothing) after it.
cr_summary_notice() { jq -n --arg k "$1" --arg n "$2" --arg x "${3:-}" --arg tips "${4:-$CR_TIPS}" '"<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n<!-- This is an auto-generated comment: \($k) by coderabbit.ai -->\n\n\($n)\n\n<!-- end of auto-generated comment: \($k) by coderabbit.ai -->\n\n\($tips)" + (if $x == "" then "" else "\n\n" + $x end)'; }
# The #874 notice quotes the range a review WOULD have covered, ending at the head.
LIMIT_NOTICE=$'> [!WARNING]\n> ## Review limit reached\n> \n> **Next included review available in 53 minutes.**\n> \n> <details>\n> <summary>View limit details</summary>\n> \n> **Limit details:** You’ve used the included review currently available.\n> \n> [Learn how review limits work](https://docs.coderabbit.ai/management/plans#rate-limits).\n> \n> **Review configuration:**\n> \n> <details>\n> <summary>📥 Commits</summary>\n> \n> Reviewing files that changed from the base of the PR and between '"$BASE40"$' and '"$HEAD40"$'.\n> \n> </details>\n> \n> </details>'
SKIP_NOTICE=$'> [!IMPORTANT]\n> ## Review skipped\n> \n> Auto reviews are disabled on base/target branches other than the default branch.\n> \n> Please check the settings in the CodeRabbit UI or the `.coderabbit.yaml` file in this repository. To trigger a single review, invoke the `@coderabbitai review` command.\n> \n> <details>\n> <summary>⚙️ Run configuration</summary>\n> \n> **Configuration used**: defaults\n> \n> **Run ID**: `29692184-5f4e-43c5-8f4f-ccb92b0cf21e`\n> \n> </details>\n> \n> Use the checkbox below for a quick retry:\n> - [ ] <!-- {"checkboxId": "e9bb8d72-00e8-4f67-9cb2-caf3b22574fe"} --> 🔍 Trigger review'
run_case "a codex usage-limit comment needs no disposition (#898)" \
  "$(wrap9 "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$CODEX_LIMIT2")")" 0 "CLEAR"
run_case "the one-line codex usage-limit comment needs no disposition (#898, 05:16Z)" \
  "$(wrap9 "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$CODEX_LIMIT1")")" 0 "CLEAR"
run_case "a coderabbit rate-limited reply needs no disposition (#847)" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$CR_LIMITED")")" 0 "CLEAR"
run_case "a rate-limited reply naming the fair-usage wait needs no disposition (#844)" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$CR_FAIR")")" 0 "CLEAR"
run_case "an already-reviewed reply needs no disposition (#846)" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$CR_ALREADY")")" 0 "CLEAR"
run_case "a chat rate-limit reply needs no disposition (#893)" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$CR_CHAT")")" 0 "CLEAR"
run_case "a summary comment holding only a rate-limit notice needs no disposition (#874)" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_summary_notice 'rate limited' "$LIMIT_NOTICE")" 2026-01-02T01:00:00Z)")" 0 "CLEAR"
run_case "a summary comment holding only a skipped notice needs no disposition (#789)" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_summary_notice 'skip review' "$SKIP_NOTICE")" 2026-01-02T01:00:00Z)")" 0 "CLEAR"
# The #898 shape: quota notices around a finding that was answered, on a covered head. The
# last notice is dated after the disposition, so under the old rule nothing answered it.
run_case "quota notices beside an answered finding on a covered head clear" \
  "$(wrap9 "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$CODEX_LIMIT2"),$(cmt reviewer User 2026-01-02T01:10:00Z '"P1: this drops the last row"'),$(cmt coderabbitai Bot 2026-01-02T01:15:00Z "$CR_LIMITED"),$(cmt me User 2026-01-02T01:20:00Z '"RED-VERIFIED: tests/row.rs"'),$(cmt "$CODEX" Bot 2026-01-02T01:30:00Z "$CODEX_LIMIT1")")" \
  0 "CLEAR"
# Guards, green before and after. A notice covers no head: an unreviewed head under a quota
# notice stays unreviewed, and the range a summary notice quotes binds nothing.
run_case "a codex usage-limit comment covers no head" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$CODEX_LIMIT2")")" 1 "UNREVIEWED HEAD"
run_case "a coderabbit rate-limited reply covers no head" \
  "$(wrap8 "$SUITE" "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$CR_LIMITED")")" 1 "UNREVIEWED HEAD"
run_case "a summary notice quoting the head's range covers no head" \
  "$(wrap7 "[$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_summary_notice 'rate limited' "$LIMIT_NOTICE")" 2026-01-02T01:00:00Z)]")" 1 "UNREVIEWED HEAD"
# The match is the whole body, and a notice belongs to the bot that posts it.
run_case "the codex notice with a finding appended is claimable" \
  "$(wrap9 "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(jq -n --argjson b "$CODEX_LIMIT2" '$b + "\n\nP1: this drops the last row"')")")" 1 "carry no disposition"
run_case "a human posting the codex notice is claimable" \
  "$(wrap9 "$(cmt helpful-human User 2026-01-02T01:00:00Z "$CODEX_LIMIT2")")" 1 "carry no disposition"
run_case "coderabbit posting the codex notice is claimable" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$CODEX_LIMIT2")")" 1 "carry no disposition"
run_case "codex posting the coderabbit reply notice is claimable" \
  "$(wrap9 "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$CR_LIMITED")")" 1 "carry no disposition"
run_case "a finding folded under Action not completed is claimable" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(cr_not_done 'P1: this drops the last row')")")" 1 "carry no disposition"
run_case "a rate-limited reply with a finding appended is claimable" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(cr_not_done "Review rate limited.

P1: this drops the last row")")")" 1 "carry no disposition"
run_case "a summary notice with text after the tips is claimable" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_summary_notice 'rate limited' "$LIMIT_NOTICE" 'P1: this drops the last row')" 2026-01-02T01:00:00Z)")" 1 "carry no disposition"
run_case "node-monorepo-perf: text inside a CodeRabbit summary region is not a claim (upstream: a summary notice with an unquoted line inside it is claimable)" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_summary_notice 'rate limited' "$LIMIT_NOTICE"$'\n\nP1: this drops the last row')" 2026-01-02T01:00:00Z)")" 0 "CLEAR"
# The payload between a notice's markers is parsed, not skimmed for a leading ">". This
# body is CodeRabbit's current rate-limit copy in full (aws #17): the prose paragraphs, the
# nested Review details block, the run configuration and the file list. Every line of it is
# a shape the gate lists, so it is still a notice.
LIMIT_NOTICE_ADAPTIVE=$(cat <<'CRNOTICE'
> [!WARNING]
> ## Review limit reached
> 
> `@ejc3`, you've reached your PR review limit, so we couldn't start this review.
> 
> **Next review available in:** **54 minutes**
> 
> You've used all free OSS reviews for now. Wait for the free limit to reset to keep reviewing this public repository.
> 
> <details>
> <summary>How can I continue?</summary>
> 
> After more reviews become available, a review can be triggered using the `@coderabbitai review` command as a PR comment. Alternatively, push new commits to this PR.
> 
> To avoid repeated limits, reduce automatic review volume by pausing incremental auto-reviews earlier, using label-based review opt-in, excluding WIP or generated PR titles, or requesting reviews manually when the PR is ready. If your team needs uninterrupted high-volume reviews, an organization admin can enable usage-based reviews.
> 
> </details>
> 
> 
> <details>
> <summary>How do review limits work?</summary>
> 
> CodeRabbit enforces per-developer PR review limits for each organization. Most developers receive the normal plan review availability.
> 
> For paid Pro and Pro+ PR reviews, CodeRabbit uses adaptive limits for sustained high-volume activity. When a developer's recent PR review activity reaches the 95th percentile or higher among CodeRabbit users, additional reviews become available more gradually as earlier reviews age out of the rolling window.
> 
> Please refer [docs](https://docs.coderabbit.ai/management/plans#rate-limits) for additional details.
> 
> </details>
> 
> <details>
> <summary>Review details</summary>
> 
> <details>
> <summary>⚙️ Run configuration</summary>
> 
> **Configuration used**: defaults
> 
> **Review profile**: CHILL
> 
> **Plan**: Pro Plus
> 
> **Run ID**: `d307059f-0ec1-452c-b65f-d1401be25dd9`
> 
> </details>
> 
> <details>
> <summary>📥 Commits</summary>
> 
> Reviewing files that changed from the base of the PR and between b7de97dc7f93551685f6933646dc75dac7cff83b and 2f6be9ef3599cff99406a5fe176bdbdfae6863b0.
> 
> </details>
> 
> <details>
> <summary>📒 Files selected for processing (5)</summary>
> 
> * `.github/workflows/drift.yml`
> * `.terraform.lock.hcl`
> * `README.md`
> * `cloudflare.tf`
> * `main.tf`
> 
> </details>
> 
> </details>
CRNOTICE
)
run_case "today's rate-limit copy, prose and file list and all, needs no disposition (aws #17)" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_summary_notice 'rate limited' "$LIMIT_NOTICE_ADAPTIVE")" 2026-01-02T01:00:00Z)")" 0 "CLEAR"
# A finding quoted INSIDE the notice is the same hole as one appended after the tips: the
# body is exempted from dispositions and the claim is never answered. Both positions, and
# both notice kinds, must stay claimable.
run_case "node-monorepo-perf: text inside a CodeRabbit summary region is not a claim (upstream: a summary notice with a quoted finding appended is claimable)" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_summary_notice 'rate limited' "$LIMIT_NOTICE"$'\n> \n> P1: this drops the last row')" 2026-01-02T01:00:00Z)")" 0 "CLEAR"
run_case "node-monorepo-perf: text inside a CodeRabbit summary region is not a claim (upstream: a summary notice with a quoted finding inside its details block is claimable)" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_summary_notice 'rate limited' "${LIMIT_NOTICE_ADAPTIVE/'> <summary>How can I continue?</summary>'/'> <summary>How can I continue?</summary>'$'\n> \n> P1: this drops the last row'}")" 2026-01-02T01:00:00Z)")" 0 "CLEAR"
run_case "node-monorepo-perf: text inside a CodeRabbit summary region is not a claim (upstream: a skipped notice with a quoted finding is claimable)" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_summary_notice 'skip review' "$SKIP_NOTICE"$'\n> \n> P1: this drops the last row')" 2026-01-02T01:00:00Z)")" 0 "CLEAR"
run_case "a summary notice of a kind this gate does not list is claimable" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_summary_notice failure $'> [!CAUTION]\n> ## Review failed\n> \n> The pull request is closed.')" 2026-01-02T01:00:00Z)")" 1 "carry no disposition"
run_case "node-monorepo-perf: text inside a CodeRabbit summary region is not a claim (upstream: a summary notice beside a walkthrough is a walkthrough, still claimable)" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_walk "$NOTICE_LIMITED" clean "$BASE40" "$HEAD40")" 2026-01-02T01:00:00Z)")" 0 "CLEAR"


echo "== finding 45: a region removed before classification is a region nobody read =="
# Round 1 of this class (finding 44) was the notice payload: every line starting with ">"
# was accepted, so "> P1: this drops the last row" rode inside a notice and needed no
# disposition. The payload is now parsed against shapes. That fixed one SITE, not the
# class: three more regions were REMOVED from the body before the shapes ever ran, and
# content removed before classification is content the classifier did not read.
#
#   region                                    removed by                    rendered
#   <!-- tips_start --> .. <!-- tips_end -->  is_cr_summary_notice residue  yes
#   <details> <summary>ℹ️ About Codex ..      verdict_lines, summary_lines  yes
#   <!-- .. -->                               verdict_lines, summary_lines,
#                                             is_cr_summary_notice residue  no
#
# Both rendered regions were live holes, verified red before the fix: a finding inside the
# tips block made a CodeRabbit summary notice exempt from dispositions, and a finding
# inside the About Codex block made a Codex verdict exempt AND still bound coverage to the
# head. The invariant now: a body is exempt only if the classifier accounted for every
# byte of it, so each removal names a declared region whose content must match that
# region's line shapes, and a region holding anything else makes the whole body claimable.
# HTML comments are declared unrendered: GitHub shows none of it, so nothing inside one is
# a claim anybody can read or answer. Shapes were read off the 13 About blocks and 17 tips
# blocks the two bots posted on ejc3/fcvm #789 through #901.
CR_TIPS_FINDING=${CR_TIPS/'<sub>Comment'/'P1: this drops the last row'$'\n\n''<sub>Comment'}
[ "$CR_TIPS_FINDING" != "$CR_TIPS" ] || { echo "  FAIL  tips fixture edit did not apply"; fail=$((fail+1)); }
CR_TIPS_UNLISTED=${CR_TIPS/'<sub>Comment'/'<sub>A tips line this gate has never seen.</sub>'$'\n\n''<sub>Comment'}
[ "$CR_TIPS_UNLISTED" != "$CR_TIPS" ] || { echo "  FAIL  tips fixture edit did not apply"; fail=$((fail+1)); }
run_case "node-monorepo-perf: text inside a CodeRabbit summary region is not a claim (upstream: a summary notice with a finding in its tips block is claimable)" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_summary_notice 'rate limited' "$LIMIT_NOTICE" '' "$CR_TIPS_FINDING")" 2026-01-02T01:00:00Z)")" 0 "CLEAR"
run_case "node-monorepo-perf: text inside a CodeRabbit summary region is not a claim (upstream: a summary notice whose tips block holds an unlisted line is claimable)" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_summary_notice 'rate limited' "$LIMIT_NOTICE" '' "$CR_TIPS_UNLISTED")" 2026-01-02T01:00:00Z)")" 0 "CLEAR"
# A finding APPENDED to a line that is itself a listed shape. This is what the anchors in
# each shape list are for: without them the shape matches the head of the line and the rest
# rides along, which is round 1 of this class with a different marker.
CR_TIPS_TRAILING=${CR_TIPS/'available commands.</sub>'/'available commands.</sub> P1: this drops the last row'}
[ "$CR_TIPS_TRAILING" != "$CR_TIPS" ] || { echo "  FAIL  tips fixture edit did not apply"; fail=$((fail+1)); }
run_case "node-monorepo-perf: text inside a CodeRabbit summary region is not a claim (upstream: a summary notice whose tips line carries a finding after it is claimable)" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_summary_notice 'rate limited' "$LIMIT_NOTICE" '' "$CR_TIPS_TRAILING")" 2026-01-02T01:00:00Z)")" 0 "CLEAR"
run_case "a summary notice with a finding in its tips block covers no head" \
  "$(wrap7 "[$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_summary_notice 'rate limited' "$LIMIT_NOTICE" '' "$CR_TIPS_FINDING")" 2026-01-02T01:00:00Z)]")" 1 "UNREVIEWED HEAD"
# The About Codex block, in both comments Codex folds one into: the legacy verdict, which
# names the commit it covers, and the review-summary table, whose rows do.
CODEX_VERDICT=$(codex_body ' Bravo.' deadbeef)
CODEX_VERDICT_FINDING=${CODEX_VERDICT/'If Codex has suggestions'/'P1: this drops the last row\n\nIf Codex has suggestions'}
[ "$CODEX_VERDICT_FINDING" != "$CODEX_VERDICT" ] || { echo "  FAIL  About-block fixture edit did not apply"; fail=$((fail+1)); }
CODEX_SUM=$(codex_summary "$(sum_row Completed 2026-01-02T01:00:00.123456Z deadbee)")
CODEX_SUM_FINDING=${CODEX_SUM/'Codex reacts with'/'P1: this drops the last row\n\nCodex reacts with'}
[ "$CODEX_SUM_FINDING" != "$CODEX_SUM" ] || { echo "  FAIL  About-block fixture edit did not apply"; fail=$((fail+1)); }
CODEX_VERDICT_TRAILING=${CODEX_VERDICT/'- Mark a draft as ready'/'- Mark a draft as ready. P1: this drops the last row'}
[ "$CODEX_VERDICT_TRAILING" != "$CODEX_VERDICT" ] || { echo "  FAIL  About-block fixture edit did not apply"; fail=$((fail+1)); }
run_case "a codex verdict whose About line carries a finding after it is claimable" \
  "$(wrap9 "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$CODEX_VERDICT_TRAILING")")" 1 "carry no disposition"
run_case "a codex verdict with a finding in its About block is claimable" \
  "$(wrap9 "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$CODEX_VERDICT_FINDING")")" 1 "carry no disposition"
run_case "a codex verdict with a finding in its About block covers no head" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$CODEX_VERDICT_FINDING")")" 1 "UNREVIEWED HEAD"
run_case "a codex review summary with a finding in its About block is claimable" \
  "$(wrap9 "$(cmt "$CODEX" Bot 2026-01-02T00:20:00Z "$CODEX_SUM_FINDING" 2026-01-02T01:00:05Z)")" 1 "carry no disposition"
run_case "a codex review summary with a finding in its About block covers no head" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T00:20:00Z "$CODEX_SUM_FINDING" 2026-01-02T01:00:05Z)")" 1 "UNREVIEWED HEAD"
# The negative cases the exemption exists for, green before and after: the same bodies with
# the regions as the bots actually post them stay exempt, and the verdict still covers.
run_case "the same summary notice with the real tips block still needs no disposition" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_summary_notice 'rate limited' "$LIMIT_NOTICE")" 2026-01-02T01:00:00Z)")" 0 "CLEAR"
run_case "the same summary notice with the real tips block still covers no head" \
  "$(wrap7 "[$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_summary_notice 'rate limited' "$LIMIT_NOTICE")" 2026-01-02T01:00:00Z)]")" 1 "UNREVIEWED HEAD"
run_case "the same codex verdict with the real About block still covers the head" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$CODEX_VERDICT")")" 0 "HEAD COVERED"
run_case "the same codex review summary with the real About block still covers the head" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T00:20:00Z "$CODEX_SUM" 2026-01-02T01:00:05Z)")" 0 "HEAD COVERED"
run_case "a codex quota notice is still exempt and still covers no head" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$CODEX_LIMIT2")")" 1 "UNREVIEWED HEAD"
run_case "a coderabbit rate-limit reply is still exempt and still covers no head" \
  "$(wrap8 "$SUITE" "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$CR_LIMITED")")" 1 "UNREVIEWED HEAD"
# Structural pin. Fixing sites one at a time is what produced rounds 1, 2 and 3, so the
# NEXT removal must fail a test unless it declares a region. gate-discard-sites.sh reads
# VERDICT_JQ, enumerates every call that discards content, and blocks on any that is
# neither the accounting primitive nor one of the listed normalizations. It enumerates
# rather than naming, so a step added under any name is caught.
if out=$(bash "$(dirname "$GATE")/gate-discard-sites.sh" 2>&1); then
  echo "  PASS  every discard in VERDICT_JQ is a declared region or a listed normalization"; pass=$((pass+1))
else
  echo "  FAIL  every discard in VERDICT_JQ is a declared region or a listed normalization"
  sed 's/^/          /' <<<"$out" | head -8; fail=$((fail+1))
fi

echo "== finding 46: an EMPTY review object is not a review =="
# #897 merged on head 27b1b943 with its last two commits reviewed by nobody. CodeRabbit
# reviewed the previous head 34f66d47, posted two findings, and was refused under Fair
# Usage on every request after that. The author fixed both findings, pushed, replied in
# both threads and resolved them. GitHub minted an empty COMMENTED review object as the
# container for each of those bot replies, bound to the new head:
#     [coderabbitai] COMMENTED body_len=0  14:16:37Z  commit=27b1b943
#     [coderabbitai] COMMENTED body_len=0  14:16:41Z  commit=27b1b943
# `reviewed` counted them, the gate said CLEAR, and the merge went through 12 minutes
# later. A reply to a comment thread is not a review of the code; the container carries
# nothing that could only exist because a review ran.
#
# What counts now, and why each: a non-empty BODY (the reviewer wrote something), a state
# of APPROVED or CHANGES_REQUESTED (GitHub only mints those from the review form; a reply
# container is always COMMENTED), or an inline comment of its own that is not a reply
# (the reviewer placed a finding). The last is not decoration: a human who reviews with
# inline comments and no summary submits exactly that shape, and refusing it would leave
# such a head permanently uncoverable once its threads were answered.
CR_REVIEW='**Actionable comments posted: 2**\n\n<details>\n<summary>scripts/x.sh (1)</summary>\n\nP1: this drops the last row.\n\n</details>'
# A review object as GraphQL returns it: $1 login, $2 state, $3 submittedAt, $4 commit,
# $5 body, $6 the comments connection (default: none, the shape of a fixture captured
# before the gate read them).
rev() { printf '{"author":{"login":"%s"},"state":"%s","submittedAt":"%s","lastEditedAt":null,"commit":{"oid":"%s"},"body":"%s"%s}' \
  "$1" "$2" "$3" "$4" "$5" "${6:+,\"comments\":$6}"; }
REPLY_CONTAINER='{"totalCount":1,"nodes":[{"replyTo":{"id":"PRRC_reply"}}]}'
INLINE_FINDING='{"totalCount":1,"nodes":[{"replyTo":null}]}'
# The #897 payload: findings raised on the OLD head, both threads answered and resolved,
# the author's disposition review, and two empty bot containers on the current head.
wrap11() { printf '{"data":{"repository":{"pullRequest":{"author":{"login":"me"},"headRefOid":"deadbeef","commits":{"nodes":[{"commit":{"committedDate":"2026-01-02T00:00:00Z","checkSuites":{"nodes":[{"createdAt":"2026-01-02T00:30:00Z"}]}}}]},"reviewThreads":{"nodes":%s},"reviews":{"nodes":%s},"comments":{"nodes":[]},"recheck":{"comments":{"nodes":[]}}}}}}' "${2:-$ANSWERED_THREADS}" "$1"; }
ANSWERED_THREADS='[{"id":"PRRT_1","isResolved":true,"isOutdated":false,"comments":{"nodes":[{"author":{"login":"coderabbitai"},"path":"scripts/x.sh","line":10,"originalLine":10,"createdAt":"2026-01-01T00:39:00Z","lastEditedAt":null,"body":"P1: this drops the last row"},{"author":{"login":"me"},"path":"scripts/x.sh","line":10,"originalLine":10,"createdAt":"2026-01-01T00:40:00Z","lastEditedAt":null,"body":"RED-VERIFIED: tests/row.rs"}]}},{"id":"PRRT_2","isResolved":true,"isOutdated":false,"comments":{"nodes":[{"author":{"login":"coderabbitai"},"path":"scripts/x.sh","line":20,"originalLine":20,"createdAt":"2026-01-01T00:41:00Z","lastEditedAt":null,"body":"P2: the count is off by one"},{"author":{"login":"me"},"path":"scripts/x.sh","line":20,"originalLine":20,"createdAt":"2026-01-01T00:42:00Z","lastEditedAt":null,"body":"NOT-A-DEFECT: reworded the message only"}]}}]'
PR897=$(printf '[%s,%s,%s,%s]' \
  "$(rev coderabbitai COMMENTED 2026-01-02T00:10:00Z 0ldc0mm1t "$CR_REVIEW")" \
  "$(rev me COMMENTED 2026-01-02T01:00:00Z deadbeef 'RED-VERIFIED: tests/row.rs — both findings answered')" \
  "$(rev coderabbitai COMMENTED 2026-01-02T00:50:00Z deadbeef '' "$REPLY_CONTAINER")" \
  "$(rev coderabbitai COMMENTED 2026-01-02T00:50:04Z deadbeef '' "$REPLY_CONTAINER")")
run_case "the #897 shape: two empty bot reply containers on the head cover nothing" \
  "$(wrap11 "$PR897")" 1 "UNREVIEWED HEAD"
run_case "one empty-bodied COMMENTED review on the head is not coverage" \
  "$(wrap5 deadbeef "[$(rev coderabbitai COMMENTED 2026-01-02T00:50:00Z deadbeef '' "$REPLY_CONTAINER")]")" \
  1 "UNREVIEWED HEAD"
# A fixture captured before the gate read review comments carries no comments connection
# at all. That is no evidence, not evidence of a review, and it declines.
run_case "an empty COMMENTED review with no comments connection is not coverage" \
  "$(wrap5 deadbeef "[$(rev coderabbitai COMMENTED 2026-01-02T00:50:00Z deadbeef '')]")" \
  1 "UNREVIEWED HEAD"

# The other direction, which matters just as much: an over-tight rule refuses real
# coverage, and a gate that cries wolf gets switched off. Each of these must still cover.
run_case "a bot review with findings on the head covers it" \
  "$(wrap11 "$(printf '[%s,%s]' \
     "$(rev coderabbitai COMMENTED 2026-01-02T00:40:00Z deadbeef "$CR_REVIEW" '{"totalCount":2,"nodes":[{"replyTo":null},{"replyTo":null}]}')" \
     "$(rev me COMMENTED 2026-01-02T01:00:00Z deadbeef 'RED-VERIFIED: tests/row.rs')")")" \
  0 "CLEAR"
run_case "a stranger's APPROVED review with an empty body covers the head" \
  "$(wrap5 deadbeef "[$(rev reviewer APPROVED 2026-01-02T00:50:00Z deadbeef '')]")" 0 "CLEAR"
run_case "a CHANGES_REQUESTED review with an empty body covers the head" \
  "$(wrap5 deadbeef "[$(rev reviewer CHANGES_REQUESTED 2026-01-02T00:50:00Z deadbeef '')]")" 0 "CLEAR"
run_case "a review that placed an inline finding but wrote no summary covers the head" \
  "$(wrap11 "[$(rev reviewer COMMENTED 2026-01-02T00:40:00Z deadbeef '' "$INLINE_FINDING")]")" \
  0 "CLEAR"
# A DISMISSED review is a review withdrawn: GitHub flips its state and leaves the body and
# the inline comments in place, so a body or comment alone proves nothing. Only a submitted
# state (APPROVED, CHANGES_REQUESTED, COMMENTED) can cover the head.
run_case "a DISMISSED review with a non-empty body on the head is not coverage" \
  "$(wrap5 deadbeef "[$(rev reviewer DISMISSED 2026-01-02T00:50:00Z deadbeef 'Looks fine to me.'),$(rev me COMMENTED 2026-01-02T01:00:00Z deadbeef 'NOT-A-DEFECT: nothing to fix')]")" \
  1 "UNREVIEWED HEAD"
run_case "a COMMENTED review with a non-empty body on the head covers it" \
  "$(wrap5 deadbeef "[$(rev reviewer COMMENTED 2026-01-02T00:50:00Z deadbeef 'Looks fine to me.'),$(rev me COMMENTED 2026-01-02T01:00:00Z deadbeef 'NOT-A-DEFECT: nothing to fix')]")" \
  0 "CLEAR"
run_case "a DISMISSED review that placed an inline finding is not coverage" \
  "$(wrap11 "[$(rev reviewer DISMISSED 2026-01-02T00:40:00Z deadbeef '' "$INLINE_FINDING")]")" \
  1 "UNREVIEWED HEAD"
run_case "a PENDING review with a non-empty body on the head is not coverage" \
  "$(wrap5 deadbeef "[$(rev reviewer PENDING 2026-01-02T00:50:00Z deadbeef 'Looks fine to me.'),$(rev me COMMENTED 2026-01-02T01:00:00Z deadbeef 'NOT-A-DEFECT: nothing to fix')]")" \
  1 "UNREVIEWED HEAD"
# A review object this gate cannot read must block, not be waved past as coverage and not
# be silently dropped from the count.
run_case "a review on the head with a non-string state exits 2" \
  "$(wrap5 deadbeef '[{"author":{"login":"reviewer"},"state":null,"submittedAt":"2026-01-02T00:50:00Z","lastEditedAt":null,"commit":{"oid":"deadbeef"},"body":""}]')" \
  2 "BLOCKED"
run_case "a review whose comments connection is truncated exits 2" \
  "$(wrap5 deadbeef "[$(rev reviewer COMMENTED 2026-01-02T00:50:00Z deadbeef '' '{"totalCount":7,"nodes":[{"replyTo":{"id":"PRRC_reply"}}]}')]")" \
  2 "BLOCKED"


echo "== finding 46: a comment is removed unread only where GitHub actually hides it =="
# Round 4 of the same class. Finding 45 gave the two RENDERED regions shape lists and left
# the third, html_comment, stripped with no check at all, on the premise that "GitHub
# renders none of it". That premise is false. CommonMark's HTML-block start condition 2
# admits at most three spaces of indentation; at four columns the same bytes are an indented
# code block and every reader sees them. Confirmed against GitHub's own renderer
# (POST /markdown, mode gfm): `<!-- P1 -->` returns nothing at 0-3 spaces and comes back as
# a <pre><code> block at 4 spaces, after a tab, and inside a fenced block.
#
# So a finding a reader could see was removed before classification, which made the comment
# a no-findings verdict: exempt from dispositions AND binding coverage to the head. The
# region is now removed by strip_hidden_comments, which takes out a complete single-line
# comment only on a line that is not indented four columns and not inside a fence, measured
# after any blockquote markers. Anything else stays in the body and the body is claimable.
# Codex's no-findings verdict with $1 appended: the two lines it must reduce to, plus the
# bytes under test. The apostrophe is written \u0027 so this can live in a single-quoted
# shell string, as codex_body above does.
codex_plus() { jq -n --arg x "$1" '"Codex Review: Didn\u0027t find any major issues.\n\n**Reviewed commit:** `deadbeef`\n\n\($x)"'; }
SPACE_FINDING='    <!-- P1: the restore path drops the last row -->'
TAB_FINDING=$'\t<!-- P1: the restore path drops the last row -->'
SPAN_FINDING=$'    <!-- P1: the restore path drops the last row\n    and the compaction pass never reruns\n    -->'
FENCE_FINDING=$'```\n<!-- P1: the restore path drops the last row -->\n```'
QUOTED_FINDING='>     <!-- P1: the restore path drops the last row -->'
INLINE_CODE_VERDICT=$(jq -n '"Codex Review: Didn\u0027t find any major issues.\n\n**Reviewed commit:** `deadbeef<!-- P1: drops last row -->`"')
run_case "a finding inside the reviewed-commit code span is claimable" \
  "$(wrap9 "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$INLINE_CODE_VERDICT")")" \
  1 "carry no disposition"
run_case "a finding inside the reviewed-commit code span covers no head" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$INLINE_CODE_VERDICT")")" \
  1 "UNREVIEWED HEAD"
# The four-space case, in both of the things a verdict decides.
run_case "a verdict with a four-space indented finding is claimable" \
  "$(wrap9 "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_plus "$SPACE_FINDING")")")" \
  1 "carry no disposition"
run_case "a verdict with a four-space indented finding covers no head" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_plus "$SPACE_FINDING")")")" \
  1 "UNREVIEWED HEAD"
# A tab is four columns, so a tab-indented comment renders the same way and a space-only
# indentation test cannot see it.
run_case "a verdict with a tab-indented finding is claimable" \
  "$(wrap9 "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_plus "$TAB_FINDING")")")" \
  1 "carry no disposition"
run_case "a verdict with a tab-indented finding covers no head" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_plus "$TAB_FINDING")")")" \
  1 "UNREVIEWED HEAD"
# An indented comment SPANNING lines shows every line of itself in the code block, so the
# more text it carries the more a reader sees and the more the old region removed.
run_case "a verdict with an indented finding spanning lines is claimable" \
  "$(wrap9 "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_plus "$SPAN_FINDING")")")" \
  1 "carry no disposition"
# The same bytes in the two other comments the exemption covers: Codex's review-summary
# table, whose rows bind coverage, and a CodeRabbit summary notice, whose residue check
# runs after the region is removed.
run_case "a codex review summary with an indented finding is claimable" \
  "$(wrap9 "$(cmt "$CODEX" Bot 2026-01-02T00:20:00Z "$(codex_summary_plus "$(sum_row Completed 2026-01-02T01:00:00.123456Z deadbee)" "$SPACE_FINDING")" 2026-01-02T01:00:05Z)")" \
  1 "carry no disposition"
run_case "a codex review summary with an indented finding covers no head" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T00:20:00Z "$(codex_summary_plus "$(sum_row Completed 2026-01-02T01:00:00.123456Z deadbee)" "$SPACE_FINDING")" 2026-01-02T01:00:05Z)")" \
  1 "UNREVIEWED HEAD"
run_case "a summary notice with an indented finding appended is claimable" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_summary_notice 'rate limited' "$LIMIT_NOTICE" "$SPACE_FINDING")" 2026-01-02T01:00:00Z)")" \
  1 "carry no disposition"
# A fenced block renders its content literally the same way. This pair was already green:
# the fence markers themselves survive the removal and no shape list accepts a line of
# backticks, so the shape lists caught it rather than the region rule. strip_hidden_comments
# tracks fences so that protection stops depending on that coincidence; the scanner
# assertion below is what goes red if the fence handling is dropped.
run_case "a verdict with a fenced finding is claimable" \
  "$(wrap9 "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_plus "$FENCE_FINDING")")")" \
  1 "carry no disposition"
run_case "a verdict with a fenced finding covers no head" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_plus "$FENCE_FINDING")")")" \
  1 "UNREVIEWED HEAD"
# Indentation is measured inside the blockquote, not from the start of the line: GitHub
# renders `>     <!-- .. -->` as a code block inside the quote.
run_case "a verdict with a finding indented inside a blockquote is claimable" \
  "$(wrap9 "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_plus "$QUOTED_FINDING")")")" \
  1 "carry no disposition"
# The negative cases the exemption exists for. Every HTML comment the two bots posted on
# ejc3/fcvm #789 through #901 (1602 of them) sits at column 0 on one line or inline on a
# column-0 line, and all of it must stay exempt: an over-tight rule blocks on ordinary bot
# traffic, which is how a gate gets switched off.
run_case "a verdict carrying a column-0 hidden marker still covers the head" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_plus '<!-- an ordinary hidden marker -->')")")" \
  0 "HEAD COVERED"
run_case "a verdict whose reviewed-commit line carries an inline marker still covers" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(jq -n '"Codex Review: Didn\u0027t find any major issues.\n\n**Reviewed commit:** `deadbeef` <!-- run 4c1f -->"')")")" \
  0 "HEAD COVERED"
run_case "the real codex verdict with its About block still covers the head" \
  "$(wrap8 "$SUITE" "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Bravo.' deadbeef)")")" \
  0 "HEAD COVERED"
run_case "the real summary notice still needs no disposition" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_summary_notice 'rate limited' "$LIMIT_NOTICE")" 2026-01-02T01:00:00Z)")" \
  0 "CLEAR"
# The skip notice carries CodeRabbit's inline checkbox marker inside its blockquote, which
# is the live inline case; it must stay a notice.
run_case "the real skip notice with its inline checkbox marker still needs no disposition" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_summary_notice 'skip review' "$SKIP_NOTICE")" 2026-01-02T01:00:00Z)")" \
  0 "CLEAR"

# The other two regions were checked for the same premise. Their DELIMITERS can be moved
# into a code context the same way, but that hides nothing: what a rendered region removes
# still has to match that region's line shapes, and a finding matches none of them. All four
# were green before this change too, which is the answer to "is this the same class twice":
# it is not, because those regions are justified by their shapes rather than by invisibility.
run_case "a finding inside an indented About Codex block is claimable" \
  "$(wrap9 "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_plus $'    <details> <summary>\u2139\ufe0f About Codex in GitHub</summary>\n    <br/>\n    P1: this drops the last row\n    </details>')")")" \
  1 "carry no disposition"
run_case "a finding inside a fenced About Codex block is claimable" \
  "$(wrap9 "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_plus $'```\n<details> <summary>\u2139\ufe0f About Codex in GitHub</summary>\n<br/>\nP1: this drops the last row\n</details>\n```')")")" \
  1 "carry no disposition"
run_case "a finding inside an indented tips block is claimable" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_summary_notice 'rate limited' "$LIMIT_NOTICE" '' $'    <!-- tips_start -->\n    ---\n    P1: this drops the last row\n    <!-- tips_end -->')" 2026-01-02T01:00:00Z)")" \
  1 "carry no disposition"
run_case "a finding inside a fenced tips block is claimable" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-01T00:00:00Z "$(cr_summary_notice 'rate limited' "$LIMIT_NOTICE" '' $'```\n<!-- tips_start -->\n---\nP1: this drops the last row\n<!-- tips_end -->\n```')" 2026-01-02T01:00:00Z)")" \
  1 "carry no disposition"

# The scanner, exercised directly from the gate's own VERDICT_JQ. The end-to-end cases above
# cannot go red for the fence and blockquote rules, because today the leftover fence markers
# and quote markers are themselves unlisted lines. This asserts the rule instead of the
# coincidence, so dropping either one fails here.
jqprog=$(awk '{f = f $0 "\n"}
  END { k = index(f, "VERDICT_JQ=\047"); if (k == 0) exit 1
        r = substr(f, k + length("VERDICT_JQ=\047")); e = index(r, "\047"); if (e == 0) exit 1
        printf "%s", substr(r, 1, e - 1) }' "$GATE")
scan_case() {
  local name=$1 body=$2 want=$3 got
  got=$(printf '%s' "$body" | jq -Rrs "$jqprog"' strip_hidden_comments' 2>&1)
  if [ "$got" = "$want" ]; then echo "  PASS  $name"; pass=$((pass+1))
  else echo "  FAIL  $name"; printf '          want %q\n          got  %q\n' "$want" "$got"; fail=$((fail+1)); fi
}
scan_case "a column-0 comment is removed"         '<!-- m -->'              ''
scan_case "a fenced comment is kept"             $'```\n<!-- P1 -->\n```'    $'```\n<!-- P1 -->\n```'
scan_case "a four-space comment is kept"         '    <!-- P1 -->'          '    <!-- P1 -->'
scan_case "a tab-indented comment is kept"       $'\t<!-- P1 -->'           $'\t<!-- P1 -->'
scan_case "a blockquote-indented comment is kept" '>     <!-- P1 -->'       '>     <!-- P1 -->'
scan_case "a comment spanning lines is kept"     $'<!-- P1\nmore\n-->'      $'<!-- P1\nmore\n-->'
scan_case "an inline comment is removed"         '- [ ] <!-- {"checkboxId":"a"} --> Trigger review' '- [ ]  Trigger review'
scan_case "a quoted column-0 comment is removed" '> <!-- m -->'             '> '
scan_case "a comment inside a multiline code span is kept" $'`code\n<!-- P1 -->\ncode`' $'`code\n<!-- P1 -->\ncode`'

# ---------------------------------------------------------------------------------------
# node-monorepo-perf sections.
# ---------------------------------------------------------------------------------------

# $1 name, $2 env assignments separated by "|" (may be empty), $3 fixture json, $4 expected
# exit code, $5 a substring that must appear, $6 a substring that must NOT appear.
run_env_case() {
  local name=$1 envs=$2 json=$3 want_rc=$4 want_txt=${5:-} absent_txt=${6:-}
  printf '%s' "$json" > "$TMP/f.json"
  local out rc envarr=()
  [ -z "$envs" ] || IFS='|' read -r -a envarr <<<"$envs"
  out=$(env "${envarr[@]}" bash "$GATE" --from-file "$TMP/f.json" 2>&1); rc=$?
  if [ "$rc" = "$want_rc" ] && { [ -z "$want_txt" ] || grep -qF "$want_txt" <<<"$out"; } \
     && { [ -z "$absent_txt" ] || ! grep -qF "$absent_txt" <<<"$out"; }; then
    echo "  PASS  $name"; pass=$((pass+1))
  else
    echo "  FAIL  $name (rc=$rc want=$want_rc)"
    sed 's/^/          /' <<<"$out" | head -6
    fail=$((fail+1))
  fi
}

echo "== fixtures: the payloads in fixtures/ (upstream runs these from tests/test_log_scan.rs) =="
# Each fixture carries a head, a check suite dating its arrival, and a stranger's APPROVED
# review of that head, so each case tests the rule it is named for and not head coverage.
fixture_case() {
  local name=$1 file=$2 want_rc=$3 want_txt=${4:-} want_txt2=${5:-}
  if [ ! -r "$FIXTURES/$file" ]; then
    echo "  FAIL  $name (missing fixture $FIXTURES/$file)"; fail=$((fail+1)); return
  fi
  run_case "$name" "$(cat "$FIXTURES/$file")" "$want_rc" "$want_txt" "$want_txt2"
}
fixture_case "unresolved threads block, the outdated one included" \
  review-threads-unresolved.json 1 "2 unresolved"
fixture_case "an all-resolved, disposed PR passes" \
  review-threads-clear.json 0 "CLEAR"
fixture_case "a resolved defect claim with no disposition blocks" \
  review-threads-resolved-unproven.json 1 "carry no disposition reply"
fixture_case "a resolved defect claim with RED-VERIFIED passes" \
  review-threads-resolved-proven.json 0 "CLEAR"
fixture_case "a defect report cannot serve as its own RED-VERIFIED" \
  review-threads-selfproof.json 1 "carry no disposition reply"
# Captured from this repository's PR #46 with capture-review-threads-fixture.sh: CodeRabbit
# reviewed head 99e4925d9 with findings and the PR merged 28 seconds later, every finding
# open. Real bodies are markdown with badges, HTML comments and folded blocks.
fixture_case "a real captured PR (#46) blocks on its open findings" \
  review-threads-live-46.json 1 "7 total, 6 unresolved" "UNRESOLVED  coderabbitai"
run_env_case "on the real capture, CodeRabbit covered the head and Codex did not" \
  "REQUIRE_HEAD_REVIEW_FROM=chatgpt-codex-connector,coderabbitai" \
  "$(cat "$FIXTURES/review-threads-live-46.json")" 1 \
  "MISSING HEAD REVIEW  chatgpt-codex-connector" "MISSING HEAD REVIEW  coderabbitai"

# A fixture missing a field the query selects lets a test pass against data the code can
# never receive. Upstream checks this in Rust; this is the same check in jq.
shape_problems=$(for f in "$FIXTURES"/review-threads-*.json; do
  jq -r --arg f "$(basename "$f")" '
    .data.repository.pullRequest as $pr
    | if ($pr | type) != "object" then "\($f): no pullRequest object"
      elif ($pr.headRefOid | type) != "string" then "\($f): headRefOid is not a string"
      elif ($pr.commits.nodes[0].commit.checkSuites.nodes | type) != "array" then "\($f): no head checkSuites array"
      elif ([ "reviews", "comments", "reviewThreads" ] | any(. as $k | ($pr[$k].nodes | type) != "array"))
        then "\($f): reviews/comments/reviewThreads.nodes is not an array"
      elif ($pr.reviews.nodes | any((.state | type) != "string" or (.body | type) != "string"
              or (has("lastEditedAt") | not)
              or (.comments.totalCount | type) != "number" or (.comments.nodes | type) != "array"
              or any(.comments.nodes[]; has("replyTo") | not)))
        then "\($f): a review lacks state/body/lastEditedAt/comments.totalCount/comments.nodes[].replyTo"
      elif ($pr.reviewThreads.nodes | any((.id | type) != "string" or (.isResolved | type) != "boolean"
              or (.isOutdated | type) != "boolean"
              or any(.comments.nodes[]; (.id | type) != "string" or (.author.login | type) != "string"
                     or (.author.__typename | type) != "string" or (.body | type) != "string"
                     or (.path | type) != "string" or (.createdAt | type) != "string"
                     or (has("lastEditedAt") | not))))
        then "\($f): a thread lacks id/isResolved/isOutdated or a comment lacks id/author/__typename/body/path/createdAt/lastEditedAt"
      elif ($pr.reviewThreads.nodes | any(. as $t | .comments.nodes | to_entries | any(
              (.value | has("userContentEdits"))
              != ($t.isResolved and .key == 0 and .value.lastEditedAt != null))))
        then "\($f): userContentEdits is not on exactly the edited findings of resolved threads"
      else empty end' "$f" 2>&1 || echo "$(basename "$f"): not JSON"
done)
nfix=$(find "$FIXTURES" -maxdepth 1 -name 'review-threads-*.json' | wc -l)
if [ -z "$shape_problems" ] && [ "$nfix" -ge 6 ]; then
  echo "  PASS  every fixture ($nfix) carries the fields the query selects"; pass=$((pass+1))
else
  echo "  FAIL  fixture shape ($nfix fixtures)"; sed 's/^/          /' <<<"$shape_problems"; fail=$((fail+1))
fi

# A gate that cannot run must block, not pass. PATH is REPLACED, not trimmed: on a
# usr-merged system /bin is /usr/bin, so dropping one entry does not hide jq.
BASH_BIN=$(command -v bash)
mkdir -p "$TMP/empty-path"
out=$(PATH="$TMP/empty-path" "$BASH_BIN" "$GATE" --from-file "$FIXTURES/review-threads-unresolved.json" 2>&1); rc=$?
if [ "$rc" != 0 ] && grep -qF "BLOCKED" <<<"$out" && ! grep -qF "verdict: CLEAR" <<<"$out"; then
  echo "  PASS  with jq unreachable the gate blocks instead of reporting CLEAR"; pass=$((pass+1))
else
  echo "  FAIL  with jq unreachable the gate blocks instead of reporting CLEAR (rc=$rc)"
  sed 's/^/          /' <<<"$out" | head -4; fail=$((fail+1))
fi

echo "== addition 1: the repository comes from GITHUB_REPOSITORY, else this repository =="
# Through the live path: the shim answers every query with a null pullRequest, which the
# gate reports naming the repository it asked about.
mkdir -p "$TMP/repobin"
cat > "$TMP/repobin/gh" <<'SHIM'
#!/bin/bash
printf '%s\n' '{"data":{"repository":{"pullRequest":null}}}'
SHIM
chmod +x "$TMP/repobin/gh"
repo_case() {
  local name=$1 envs=$2 want_rc=$3 want_txt=$4 out rc
  # shellcheck disable=SC2086  # $envs is a list of NAME=value words, none with a space
  out=$(env -u GITHUB_REPOSITORY -u REPO_OWNER -u REPO_NAME $envs PATH="$TMP/repobin:$PATH" bash "$GATE" 7 2>&1); rc=$?
  if [ "$rc" = "$want_rc" ] && grep -qF "$want_txt" <<<"$out"; then
    echo "  PASS  $name"; pass=$((pass+1))
  else
    echo "  FAIL  $name (rc=$rc want=$want_rc)"; sed 's/^/          /' <<<"$out" | head -4; fail=$((fail+1))
  fi
}
repo_case "with nothing set the gate reads ejc3/node-monorepo-perf" "" 2 "in ejc3/node-monorepo-perf"
repo_case "GITHUB_REPOSITORY names the repository" "GITHUB_REPOSITORY=someone/some.repo" 2 "in someone/some.repo"
repo_case "an explicit REPO_OWNER wins over GITHUB_REPOSITORY" \
  "GITHUB_REPOSITORY=someone/somerepo REPO_OWNER=other" 2 "in other/somerepo"
repo_case "a GITHUB_REPOSITORY that is not owner/name blocks" "GITHUB_REPOSITORY=not-a-repo" 2 "is not owner/name"

echo "== addition 2: EXPECT_HEAD binds the verdict to the commit CI posts it on =="
H40=0123456789abcdef0123456789abcdef01234567
wrapH() { printf '{"data":{"repository":{"pullRequest":{"author":{"login":"me"},"headRefOid":"%s","reviewThreads":{"nodes":[]},"reviews":{"nodes":[{"author":{"login":"reviewer"},"state":"APPROVED","submittedAt":"2026-01-01T00:00:00Z","lastEditedAt":null,"body":"","commit":{"oid":"%s"}}]},"comments":{"nodes":[]}}}}}' "$1" "$1"; }
run_env_case "EXPECT_HEAD equal to the head clears" "EXPECT_HEAD=$H40" "$(wrapH "$H40")" 0 "CLEAR"
run_env_case "EXPECT_HEAD compares case-insensitively" "EXPECT_HEAD=${H40^^}" "$(wrapH "$H40")" 0 "CLEAR"
run_env_case "a head other than EXPECT_HEAD blocks" \
  "EXPECT_HEAD=fedcba9876543210fedcba9876543210fedcba98" "$(wrapH "$H40")" 2 "not the expected"
run_env_case "an abbreviated EXPECT_HEAD blocks" "EXPECT_HEAD=${H40:0:7}" "$(wrapH "$H40")" 2 "not a full 40-character"

echo "== addition 3: REQUIRE_HEAD_REVIEW_FROM needs EVERY listed reviewer on the head =="
REQ="REQUIRE_HEAD_REVIEW_FROM=chatgpt-codex-connector,coderabbitai"
# One review object: $1 login, $2 __typename, $3 commit, $4 body (a JSON string literal),
# $5 state, $6 its inline comments connection.
rv() { printf '{"author":{"login":"%s","__typename":"%s"},"state":"%s","submittedAt":"2026-01-02T02:00:00Z","lastEditedAt":null,"body":%s,"commit":{"oid":"%s"},"comments":%s}' \
  "$1" "$2" "${5:-COMMENTED}" "$4" "$3" "${6:-{\"totalCount\":0,\"nodes\":[]\}}"; }
# The author's answer to every bot review body, dated after them (a review body from the
# author is an answer, never a claim).
ANS='{"author":{"login":"me","__typename":"User"},"state":"COMMENTED","submittedAt":"2026-01-03T00:00:00Z","lastEditedAt":null,"body":"NOT-A-DEFECT: answered","commit":{"oid":"deadbeef"},"comments":{"totalCount":0,"nodes":[]}}'
# $1 reviews (a JSON array body, without brackets), $2 top-level comments (likewise).
wrapQ() { printf '{"data":{"repository":{"pullRequest":{"author":{"login":"me"},"headRefOid":"deadbeef","commits":{"nodes":[{"commit":{"committedDate":"2026-01-02T00:00:00Z","checkSuites":{"nodes":[{"createdAt":"2026-01-02T00:30:00Z"}]}}}]},"reviewThreads":{"nodes":[]},"reviews":{"nodes":[%s]},"comments":{"nodes":[%s]},"recheck":{"comments":{"nodes":[%s]}}}}}}' "$1" "${2:-}" "${2:-}"; }
CODEX_RV=$(rv chatgpt-codex-connector Bot deadbeef '"### Codex Review\n\nP2: a finding"')
CR_RV=$(rv coderabbitai Bot deadbeef '"**Actionable comments posted: 1**"')
run_env_case "without the knob one reviewer covers the head, as upstream" \
  "" "$(wrapQ "$CODEX_RV,$ANS")" 0 "CLEAR"
run_env_case "with both required, Codex alone is not enough" \
  "$REQ" "$(wrapQ "$CODEX_RV,$ANS")" 1 "MISSING HEAD REVIEW  coderabbitai" "MISSING HEAD REVIEW  chatgpt-codex-connector"
run_env_case "with both required, CodeRabbit alone is not enough" \
  "$REQ" "$(wrapQ "$CR_RV,$ANS")" 1 "MISSING HEAD REVIEW  chatgpt-codex-connector" "MISSING HEAD REVIEW  coderabbitai"
run_env_case "with both required, both reviewing the head clears" \
  "$REQ" "$(wrapQ "$CODEX_RV,$CR_RV,$ANS")" 0 "CLEAR"
run_env_case "spaces around the listed logins are ignored" \
  "REQUIRE_HEAD_REVIEW_FROM= chatgpt-codex-connector , coderabbitai " "$(wrapQ "$CODEX_RV,$ANS")" 1 \
  "MISSING HEAD REVIEW  coderabbitai has" "MISSING HEAD REVIEW  chatgpt-codex-connector"
run_env_case "a user account with a listed bot's login is not that bot" \
  "$REQ" "$(wrapQ "$CODEX_RV,$(rv coderabbitai User deadbeef '"**Actionable comments posted: 1**"'),$ANS")" 1 \
  "MISSING HEAD REVIEW  coderabbitai"
run_env_case "an empty reply container from a required bot is not its review" \
  "$REQ" "$(wrapQ "$CODEX_RV,$(rv coderabbitai Bot deadbeef '""' COMMENTED '{"totalCount":1,"nodes":[{"replyTo":{"id":"x"}}]}'),$ANS")" 1 \
  "MISSING HEAD REVIEW  coderabbitai"
run_env_case "a DISMISSED review with a non-empty body from a required bot is not its review" \
  "$REQ" "$(wrapQ "$CODEX_RV,$(rv coderabbitai Bot deadbeef '"**Actionable comments posted: 1**"' DISMISSED),$ANS")" 1 \
  "MISSING HEAD REVIEW  coderabbitai"
run_env_case "a COMMENTED review with a non-empty body from a required bot is its review" \
  "$REQ" "$(wrapQ "$CODEX_RV,$(rv coderabbitai Bot deadbeef '"**Actionable comments posted: 1**"' COMMENTED),$ANS")" 0 "CLEAR"
run_env_case "a required bot's review of an older commit is not a review of the head" \
  "$REQ" "$(wrapQ "$CODEX_RV,$(rv coderabbitai Bot 0ldc0mm1t '"**Actionable comments posted: 1**"'),$ANS")" 1 \
  "MISSING HEAD REVIEW  coderabbitai"
run_env_case "Codex's no-findings verdict bound to the head counts as Codex's review" \
  "$REQ" "$(wrapQ "$CR_RV,$ANS" "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Bravo.' deadbeef)")")" 0 "CLEAR"
run_env_case "Codex's verdict naming an older commit does not" \
  "$REQ" "$(wrapQ "$CR_RV,$ANS" "$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Bravo.' abc123def4)")")" 1 \
  "MISSING HEAD REVIEW  chatgpt-codex-connector"
run_env_case "Codex's verdict posted by another bot is not Codex's" \
  "$REQ" "$(wrapQ "$CR_RV,$ANS" "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(codex_body ' Bravo.' deadbeef)"),$(cmt me User 2026-01-02T03:00:00Z '"NOT-A-DEFECT: not a finding"')")" 1 \
  "MISSING HEAD REVIEW  chatgpt-codex-connector"

# `make review-gate` and the review-gate status must judge by the same list, or a PR that
# is CLEAR locally sits blocked in CI (or the reverse).
ROOT="$(dirname "$0")/../../.."
mk_req=$(sed -n 's/^REVIEW_GATE_REQUIRED ?= *//p' "$ROOT/Makefile" 2>/dev/null)
wf_req=$(sed -n 's/^  REQUIRE_HEAD_REVIEW_FROM: *//p' "$ROOT/.github/workflows/review-gate.yml" 2>/dev/null)
if [ -n "$mk_req" ] && [ "$mk_req" = "$wf_req" ]; then
  echo "  PASS  the Makefile and the workflow require the same reviewers ($mk_req)"; pass=$((pass+1))
else
  echo "  FAIL  the Makefile requires '$mk_req' and the workflow '$wf_req'"; fail=$((fail+1))
fi

echo "== addition 4: Codex's no-findings verdict with a sign-off that changes every time =="
for signoff in ' Already looking forward to the next diff.' ' What shall we delve into next?' \
               " Chef's kiss." ' Another round soon, please!' ' Delightful!'; do
  run_case "the codex sign-off '$signoff' is a verdict that covers the head it names" \
    "$(wrap6 "[$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body "$signoff" deadbeef)")]")" \
    0 "HEAD COVERED"
done
for claim in ' Only the workflow files were reviewed.' ' Not much to say!' ' Nothing broken here!' \
             ' The error path leaks memory.' ' Mostly fine but slow!' ' Everything compiles fine.' \
             ' Credentials exposed!' ' Reviewed documentation exclusively!' ' Lovely work!'; do
  run_case "the sign-off '$claim' is a claim and binds no coverage" \
    "$(wrap6 "[$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body "$claim" deadbeef)")]")" \
    1 "carry no disposition" "UNREVIEWED HEAD"
done
run_case "a sign-off carrying a colon is a finding, not a verdict" \
  "$(wrap6 "[$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' One thing: the lease drops.' deadbeef)")]")" \
  1 "carry no disposition" "UNREVIEWED HEAD"
run_case "a sign-off carrying a number is a finding, not a verdict" \
  "$(wrap6 "[$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Line 42 drops the lease.' deadbeef)")]")" \
  1 "carry no disposition" "UNREVIEWED HEAD"
run_case "a sign-off of two sentences is a finding, not a verdict" \
  "$(wrap6 "[$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Nice. The lease drops before the rename.' deadbeef)")]")" \
  1 "carry no disposition" "UNREVIEWED HEAD"
run_case "the new sign-off from a human is claimable, not coverage" \
  "$(wrap6 "[$(cmt helpful-human User 2026-01-02T01:00:00Z "$(codex_body ' Already looking forward to the next diff.' deadbeef)")]")" \
  1 "carry no disposition" "UNREVIEWED HEAD"
run_env_case "the new sign-off naming an older commit needs no answer and covers nothing" \
  "" "$(wrap6 "[$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Already looking forward to the next diff.' abc123def4)")]")" \
  1 "UNREVIEWED HEAD" "UNANSWERED"
run_case "the new sign-off from the CodeRabbit bot is claimable, not coverage" \
  "$(wrap6 "[$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(codex_body ' Already looking forward to the next diff.' deadbeef)")]")" \
  1 "carry no disposition" "UNREVIEWED HEAD"
# The verdict is coverage, so it is one of the comments the gate re-reads and compares: a
# new-shape verdict edited between the two reads must block like any other.
FLAVOR=$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' Already looking forward to the next diff.' deadbeef)")
FLAVOR_EDITED=$(cmt "$CODEX" Bot 2026-01-02T01:00:00Z "$(codex_body ' What shall we delve into next?' deadbeef)" 2026-01-02T02:00:00Z)
run_case "a new-shape verdict that changed between the two reads blocks" \
  "$(wrap6 "[$FLAVOR]" "[$FLAVOR_EDITED]")" 2 "changed under us"

echo "== addition 5: Codex's review object that only holds its inline comments =="
# As posted on #64, #65 and #67: heading, one sentence, the reviewed commit, About Codex.
codex_container() { jq -n --arg sha "$1" --arg extra "${2:-}" '"\n### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request.\n\(if $extra == "" then "" else "\n" + $extra + "\n" end)\n**Reviewed commit:** `\($sha)`\n    \n\n<details> <summary>ℹ️ About Codex in GitHub</summary>\n<br/>\n\n[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you\n- Open a pull request for review\n- Mark a draft as ready\n- Comment \"@codex review\".\n\nIf Codex has suggestions, it will comment; otherwise it will react with 👍.\n\n\n\n\nCodex can also answer questions or update the PR. Try commenting \"@codex address that feedback\".\n            \n</details>"'; }
APPROVE=$(rv reviewer User deadbeef '""' APPROVED)
ONE_INLINE='{"totalCount":1,"nodes":[{"replyTo":null}]}'
run_env_case "the container review is not a claim; its inline thread is judged as a thread" \
  "" "$(wrapQ "$(rv chatgpt-codex-connector Bot 0ldc0mm1t "$(codex_container abc1234)" COMMENTED "$ONE_INLINE"),$APPROVE")" \
  0 "CLEAR" "UNANSWERED"
run_env_case "a container review with a finding added to its body is a claim" \
  "" "$(wrapQ "$(rv chatgpt-codex-connector Bot 0ldc0mm1t "$(codex_container abc1234 'P1: this also drops the last row')" COMMENTED "$ONE_INLINE"),$APPROVE")" \
  1 "UNANSWERED chatgpt-codex-connector"
run_env_case "the container shape from a user account is a claim" \
  "" "$(wrapQ "$(rv chatgpt-codex-connector User 0ldc0mm1t "$(codex_container abc1234)" COMMENTED "$ONE_INLINE"),$APPROVE")" \
  1 "UNANSWERED chatgpt-codex-connector"
run_env_case "the container shape from another bot is a claim" \
  "" "$(wrapQ "$(rv coderabbitai Bot 0ldc0mm1t "$(codex_container abc1234)" COMMENTED "$ONE_INLINE"),$APPROVE")" \
  1 "UNANSWERED coderabbitai"

echo "== addition 6: CodeRabbit's acknowledgements and summary comment are not claims =="
cr_ack() { jq -n --arg s "$1" --arg t "$2" '"<!-- This is an auto-generated reply by CodeRabbit -->\n<!-- CodeRabbit review command invocation: v2:0000 -->\n<details>\n<summary>\($s)</summary>\n\n\($t)\n\n> Note: CodeRabbit is an incremental review system and does not re-review already reviewed commits. This command is applicable only when automatic reviews are paused.\n\n</details>"'; }
run_case "'Head commit changed.' (as posted on #64) is a notice, not a claim" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(cr_ack '⚠️ Action not completed' 'Head commit changed.')")")" 0 "CLEAR"
run_case "'Review triggered.' is a notice, not a claim" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(cr_ack '✅ Actions performed' 'Review triggered.')")")" 0 "CLEAR"
run_case "'Review triggered.' without the emoji (as posted on #65) is a notice, not a claim" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(cr_ack 'Action performed' 'Review triggered.')")")" 0 "CLEAR"
run_case "'Review triggered.' is not coverage" \
  "$(wrap6 "[$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(cr_ack '✅ Actions performed' 'Review triggered.')")]")" 1 "UNREVIEWED HEAD"
run_case "an acknowledgement with a finding added is a claim" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(cr_ack '⚠️ Action not completed' $'Head commit changed.\n\nP1: this drops the last row')")")" 1 "carry no disposition"
# The summary comment as CodeRabbit posts it on this repository (#66): summarize marker, a
# rate-limit notice region, the autopilot region, the tips region.
CR_SUM=$(jq -r '.data.repository.pullRequest.comments.nodes[] | select(.author.login == "coderabbitai")
                | select(.body | startswith("<!-- This is an auto-generated comment: summarize")) | .body' \
         "$FIXTURES/review-threads-live-66.json" | jq -R -s .)
run_case "the summary comment from the CodeRabbit bot is not a claim" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$CR_SUM")")" 0 "CLEAR"
run_case "the summary comment from a user account is a claim" \
  "$(wrap9 "$(cmt coderabbitai User 2026-01-02T01:00:00Z "$CR_SUM")")" 1 "carry no disposition"
run_case "a summary comment with text after its regions is a claim" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(jq -n --argjson b "$CR_SUM" '$b + "\n\nP1: this drops the last row"')")")" 1 "carry no disposition"
run_case "a summary comment whose region never closes is a claim" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(jq -n --argjson b "$CR_SUM" '$b | sub("<!-- tips_end -->"; "")')")")" 1 "carry no disposition"
run_case "a summary comment with text on its marker line is a claim" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(jq -n --argjson b "$CR_SUM" '$b | sub("summarize by coderabbit.ai -->"; "summarize by coderabbit.ai --> P1: this drops the last row")')")")" 1 "carry no disposition"
run_case "a summary comment with visible text between two hidden comments is a claim" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(jq -n --argjson b "$CR_SUM" '$b + "\n<!-- a --> P1: this drops the last row <!-- b -->"')")")" 1 "carry no disposition"
run_case "a summary comment with a region this gate has not seen is a claim" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(jq -n --argjson b "$CR_SUM" '$b + "\n<!-- new_section_start -->\nP1: this drops the last row\n<!-- new_section_end -->"')")")" 1 "carry no disposition"
run_case "an unseen region nested inside an allowed one is a claim" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(jq -n --argjson b "$CR_SUM" '$b + "\n<!-- walkthrough_start -->\n<!-- hidden_findings_start -->\nP1\n<!-- hidden_findings_end -->\n<!-- walkthrough_end -->"')")")" 1 "carry no disposition"
run_case "a recent-review block that posted actionable comments is a claim" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(jq -n --argjson b "$CR_SUM" '$b + "\n<!-- recent_review_start -->\n**Actionable comments posted: 2**\n<!-- recent_review_end -->"')")")" 1 "carry no disposition"
run_case "a recent-review block that posted none is not" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(jq -n --argjson b "$CR_SUM" '$b + "\n<!-- recent_review_start -->\nNo actionable comments were generated in the recent review. 🎉\n<!-- recent_review_end -->"')")")" 0 "CLEAR"
run_case "pre-merge checks with a warning are a claim" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(jq -n --argjson b "$CR_SUM" '$b + "\n<!-- pre_merge_checks_walkthrough_start -->\n| Docstring Coverage | ⚠️ Warning | 39% |\n<!-- pre_merge_checks_walkthrough_end -->"')")")" 1 "carry no disposition"
run_case "pre-merge checks that all passed are not" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(jq -n --argjson b "$CR_SUM" '$b + "\n<!-- pre_merge_checks_walkthrough_start -->\n<summary>✅ Passed checks (5 passed)</summary>\n<!-- pre_merge_checks_walkthrough_end -->"')")")" 0 "CLEAR"
run_case "a merge risk above Low is a claim" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(jq -n --argjson b "$CR_SUM" '$b + "\n<!-- final_review_risk_start -->\n**Merge Risk:** **🔴 High** · up to `ada54`\n<!-- final_review_risk_end -->"')")")" 1 "carry no disposition"
run_case "a merge risk of Minimal is not" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(jq -n --argjson b "$CR_SUM" '$b + "\n<!-- final_review_risk_start -->\n**Merge Risk:** **⚪ Minimal** · up to `ada54`\n<!-- final_review_risk_end -->"')")")" 0 "CLEAR"
run_case "a region carrying Review failed is a claim" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(jq -n --argjson b "$CR_SUM" '$b + "\n<!-- walkthrough_start -->\n> [!CAUTION]\n> ## Review failed\n<!-- walkthrough_end -->"')")")" 1 "carry no disposition"
run_case "failed pre-merge checks nested inside the walkthrough are a claim" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(jq -n --argjson b "$CR_SUM" '$b + "\n<!-- walkthrough_start -->\n<!-- pre_merge_checks_walkthrough_start -->\n### ❌ Failed checks (1 warning)\n<!-- pre_merge_checks_walkthrough_end -->\n<!-- walkthrough_end -->"')")")" 1 "carry no disposition"
run_case "a High merge risk nested inside the walkthrough is a claim" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(jq -n --argjson b "$CR_SUM" '$b + "\n<!-- walkthrough_start -->\n<!-- final_review_risk_start -->\n**Merge Risk:** **🔴 High** · up to `ada54`\n<!-- final_review_risk_end -->\n<!-- walkthrough_end -->"')")")" 1 "carry no disposition"
run_case "a result region that opens inside another and never closes is a claim" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(jq -n --argjson b "$CR_SUM" '$b + "\n<!-- walkthrough_start -->\n<!-- recent_review_start -->\n**Actionable comments posted: 3**\n<!-- walkthrough_end -->"')")")" 1 "carry no disposition"
run_case "a result region nested in one of the same name is a claim" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(jq -n --argjson b "$CR_SUM" '$b + "\n<!-- walkthrough_start -->\n<!-- pre_merge_checks_walkthrough_start -->\n<!-- pre_merge_checks_walkthrough_start -->\nall clean\n<!-- pre_merge_checks_walkthrough_end -->\n### ❌ Failed checks (1 warning)\n<!-- pre_merge_checks_walkthrough_end -->\n<!-- walkthrough_end -->"')")")" 1 "carry no disposition"
run_case "a region that closes out of order is a claim" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(jq -n --argjson b "$CR_SUM" '$b + "\n<!-- walkthrough_start -->\n<!-- recent_review_start -->\n<!-- walkthrough_end -->\n<!-- recent_review_end -->"')")")" 1 "carry no disposition"
run_case "a close marker of a region that is not open is a claim" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(jq -n --argjson b "$CR_SUM" '$b + "\n<!-- walkthrough_start -->\n<!-- recent_review_end -->\n**Actionable comments posted: 3**\n<!-- walkthrough_end -->"')")")" 1 "carry no disposition"
# The allow-list is what CodeRabbit has emitted, no more: every region marker in the
# captured CodeRabbit summaries is on it, and every entry on it occurs in one of them. A new
# region CodeRabbit starts emitting makes its summary a claim until it is captured and listed.
allow=$(sed -n '/^def cr_summary_regions:/,/\];$/p' "$GATE" | sed 's/^def cr_summary_regions://' \
        | grep -o '"[^"]*"' | tr -d '"' | sort -u)
seen=$(for f in "$FIXTURES"/review-threads-live-*.json; do
  jq -r '.data.repository.pullRequest.comments.nodes[] | select(.author.login == "coderabbitai")
         | select(.body | startswith("<!-- This is an auto-generated comment: summarize")) | .body' "$f"
done | sed -n -E 's/^<!-- ([a-z_]+)_start -->[ \t\r]*$/\1/p; s/^<!-- ([a-z_]+):start -->[ \t\r]*$/\1:/p;
                   s/^<!-- This is an auto-generated comment: ([a-z ]+) by coderabbit\.ai -->[ \t\r]*$/auto:\1/p' \
  | grep -v '^auto:summarize$' | sort -u)
if [ -n "$allow" ] && [ "$allow" = "$seen" ]; then
  echo "  PASS  the summary region allow-list is exactly the regions in the captured fixtures"; pass=$((pass+1))
else
  echo "  FAIL  the summary region allow-list and the captured regions differ"
  diff <(printf '%s\n' "$allow") <(printf '%s\n' "$seen") | sed 's/^/          /'; fail=$((fail+1))
fi
run_case "a summary comment with an indented region marker is a claim" \
  "$(wrap9 "$(cmt coderabbitai Bot 2026-01-02T01:00:00Z "$(jq -n --argjson b "$CR_SUM" '$b | sub("\n<!-- tips_start -->"; "\n    <!-- tips_start -->")')")")" 1 "carry no disposition"

echo "== addition 6b: a review body is dated by its last edit =="
# Finding submitted 01-02, answered 01-03, then edited 01-04 to add a second finding: the
# 01-03 answer predates what the body now says.
EDITED_RV='{"author":{"login":"coderabbitai","__typename":"Bot"},"state":"COMMENTED","submittedAt":"2026-01-02T00:00:00Z","lastEditedAt":"%s","body":"P1: drops a row. P1: and the index","commit":{"oid":"0ldc0mm1t"},"comments":{"totalCount":0,"nodes":[]}}'
ANSWER_RV='{"author":{"login":"me","__typename":"User"},"state":"COMMENTED","submittedAt":"2026-01-03T00:00:00Z","lastEditedAt":null,"body":"RED-VERIFIED: row.test.ts","commit":{"oid":"deadbeef"},"comments":{"totalCount":0,"nodes":[]}}'
run_env_case "a review edited after its answer is unanswered again" \
  "" "$(wrapQ "$(printf "$EDITED_RV" 2026-01-04T00:00:00Z),$ANSWER_RV,$APPROVE")" 1 "UNANSWERED coderabbitai"
run_env_case "a review edited before its answer stays answered" \
  "" "$(wrapQ "$(printf "$EDITED_RV" 2026-01-02T12:00:00Z),$ANSWER_RV,$APPROVE")" 0 "CLEAR"
run_env_case "a review never edited (lastEditedAt null) is dated by its submission" \
  "" "$(wrapQ "$(printf "$EDITED_RV" '' | sed 's/"lastEditedAt":""/"lastEditedAt":null/'),$ANSWER_RV,$APPROVE")" 0 "CLEAR"

echo "== addition 6c: an inline finding is dated by its last edit, like every other claim =="
# A thread's finding is its FIRST comment, and GitHub lets it be edited in place. The thread
# rule asked only that a disposition reply exist, so a nit answered NOT-A-DEFECT and resolved,
# then edited into a P1, stayed CLEAR on the old answer. Review bodies and top-level comments
# were already dated by their last edit; this is the same rule (written_at in the gate), so
# a disposition answers the finding only when it was written after the finding's current
# text. $1 is the finding's lastEditedAt member (with its trailing comma, or empty for a
# payload that omits the field), $2 any further replies (each with a leading comma).
# Guards, green before and after: edited before the answer, answered again after the edit,
# and never edited.
EDITED_TH='[{"id":"PRRT_edited","isResolved":true,"isOutdated":false,"comments":{"nodes":[{"author":{"login":"codex"},"path":"src/row.ts","line":7,"originalLine":7,"createdAt":"2026-01-01T00:00:00Z",%s"body":"P1: this drops the final row"},{"author":{"login":"me"},"path":"src/row.ts","line":7,"originalLine":7,"createdAt":"2026-01-02T00:00:00Z","lastEditedAt":null,"body":"NOT-A-DEFECT: renamed only"}%s]}}]'
edited_th() { printf "$EDITED_TH" "$1" "${2:-}"; }
LATE_ANSWER=',{"author":{"login":"me"},"path":"src/row.ts","line":7,"originalLine":7,"createdAt":"2026-01-04T00:00:00Z","lastEditedAt":null,"body":"RED-VERIFIED: row.test.ts"}'
run_case "an inline finding edited after its disposition is reopened" \
  "$(wrap "$(edited_th '"lastEditedAt":"2026-01-03T00:00:00Z",')")" 1 "REOPENED" "src/row.ts:7"
run_case "an inline finding edited half a second after its disposition is reopened" \
  "$(wrap "$(edited_th '"lastEditedAt":"2026-01-02T00:00:00.5Z",')")" 1 "REOPENED" "src/row.ts:7"
run_case "an inline finding edited before its disposition stays answered" \
  "$(wrap "$(edited_th '"lastEditedAt":"2026-01-01T12:00:00Z",')")" 0 "CLEAR"
run_case "a new disposition after the edit answers the edited finding" \
  "$(wrap "$(edited_th '"lastEditedAt":"2026-01-03T00:00:00Z",' "$LATE_ANSWER")")" 0 "CLEAR"
run_case "an inline finding never edited (lastEditedAt null) is dated by its creation" \
  "$(wrap "$(edited_th '"lastEditedAt":null,')")" 0 "CLEAR"
# Fail closed: a resolved thread whose comments cannot be dated cannot be shown answered.
run_case "an inline finding with no lastEditedAt field blocks" \
  "$(wrap "$(edited_th '')")" 2 "lastEditedAt"
run_case "an inline finding with an unparsable lastEditedAt blocks" \
  "$(wrap "$(edited_th '"lastEditedAt":"yesterday",')")" 2 "lastEditedAt"
run_case "an inline finding with no createdAt blocks" \
  "$(wrap "$(edited_th '"lastEditedAt":null,' | sed 's/"createdAt":"2026-01-01T00:00:00Z",//')")" 2 "createdAt"
run_case "a disposition reply with an unparsable createdAt blocks" \
  "$(wrap "$(edited_th '"lastEditedAt":null,' | sed 's/"createdAt":"2026-01-02T00:00:00Z"/"createdAt":"2026-02-31T00:00:00Z"/')")" 2 "createdAt"

# One rule for the review body as well: it is dated by the LATER of its submission and its
# last edit. Dated by lastEditedAt alone, a review whose body was edited while it was still a
# pending draft (lastEditedAt 01-02) and submitted 01-04 read as written before an answer
# posted 01-03, an answer to an earlier round that could not have seen it.
PENDING_RV='{"author":{"login":"coderabbitai","__typename":"Bot"},"state":"COMMENTED","submittedAt":"2026-01-04T00:00:00Z",%s"body":"P1: drops a row","commit":{"oid":"0ldc0mm1t"},"comments":{"totalCount":0,"nodes":[]}}'
run_env_case "a review edited while pending is dated by its later submission" \
  "" "$(wrapQ "$(printf "$PENDING_RV" '"lastEditedAt":"2026-01-02T00:00:00Z",'),$ANSWER_RV,$APPROVE")" 1 "UNANSWERED coderabbitai"
# Answered on 01-05, after everything: only the missing or unparsable date can block these.
LATE_ANSWER_RV='{"author":{"login":"me","__typename":"User"},"state":"COMMENTED","submittedAt":"2026-01-05T00:00:00Z","lastEditedAt":null,"body":"RED-VERIFIED: row.test.ts","commit":{"oid":"deadbeef"},"comments":{"totalCount":0,"nodes":[]}}'
run_env_case "an answered review with no lastEditedAt field blocks" \
  "" "$(wrapQ "$(printf "$PENDING_RV" ''),$LATE_ANSWER_RV,$APPROVE")" 2 "lastEditedAt"
run_env_case "an answered review with an unparsable lastEditedAt blocks" \
  "" "$(wrapQ "$(printf "$PENDING_RV" '"lastEditedAt":"2026-13-01T00:00:00Z",'),$LATE_ANSWER_RV,$APPROVE")" 2 "lastEditedAt"

# The live path must FETCH what the rule reads: every thread-comment selection in the gate
# asks for createdAt and lastEditedAt. Without them every finding reads as never edited.
sel_total=$(grep -c 'path line originalLine' "$GATE")
sel_dated=$(grep 'path line originalLine' "$GATE" | grep -c 'createdAt lastEditedAt')
if [ "$sel_total" -ge 2 ] && [ "$sel_total" = "$sel_dated" ]; then
  echo "  PASS  every thread-comment selection fetches createdAt and lastEditedAt"; pass=$((pass+1))
else
  echo "  FAIL  every thread-comment selection fetches createdAt and lastEditedAt ($sel_dated of $sel_total)"; fail=$((fail+1))
fi

# And the two reads of the threads are compared on the dates too: an edit landing between
# them that leaves the body byte-identical still moves lastEditedAt, and the verdict must not
# be taken from the earlier date.
mkdir -p "$TMP/bin"
dated_read() {
  printf '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"id":"T1","isResolved":true,"isOutdated":false,"comments":{"totalCount":2,"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"author":{"login":"reviewer"},"path":"a.ts","line":1,"originalLine":1,"createdAt":"2026-01-01T00:00:00Z","lastEditedAt":%s,"body":"this drops the last row"},{"author":{"login":"me"},"path":"a.ts","line":1,"originalLine":1,"createdAt":"2026-01-01T01:00:00Z","lastEditedAt":null,"body":"NOT-A-DEFECT: renamed only, no behaviour change"}]}}]}}}}}' "$1"
}
dated_read 'null' > "$TMP/dthreads.json"
dated_read '"2026-01-01T00:30:00Z"' > "$TMP/dthreads2.json"
printf '{"data":{"repository":{"pullRequest":{"author":{"login":"me"},"headRefOid":"deadbeef","commits":{"nodes":[{"commit":{"committedDate":"2026-01-02T00:00:00Z","checkSuites":{"nodes":[{"createdAt":"2026-01-02T00:30:00Z"}]}}}]},"reviews":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"author":{"login":"reviewer"},"state":"COMMENTED","submittedAt":"2026-01-02T01:00:00Z","lastEditedAt":null,"body":"","commit":{"oid":"deadbeef"},"comments":{"totalCount":1,"nodes":[{"replyTo":null}]}}]}}}}}' > "$TMP/dreviews.json"
printf '{"data":{"repository":{"pullRequest":{"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}}' > "$TMP/dcomments.json"
printf '%s' "$PRCOMMITS_LIVE" > "$TMP/prcommits.json"
cat > "$TMP/bin/gh" <<'SHIM'
#!/bin/bash
nth() { local f=$GATE_TEST_DIR/$1.count n; n=$(cat "$f" 2>/dev/null || echo 0); n=$((n+1)); printf '%s' "$n" > "$f"; printf '%s' "$n"; }
case "$*" in
  *"commits(first"*)   cat "$GATE_TEST_DIR/prcommits.json" ;;
  *reviewThreads*)
    if [ "$(nth dthreads)" -le 1 ]; then cat "$GATE_TEST_DIR/dthreads.json"
    else cat "$GATE_TEST_DIR/${GATE_TEST_DTHREADS2:-dthreads}.json"; fi ;;
  *"reviews(first"*)   cat "$GATE_TEST_DIR/dreviews.json" ;;
  *"comments(first"*)  cat "$GATE_TEST_DIR/dcomments.json" ;;
  *headRefOid*)        printf 'deadbeef\n' ;;  # the recheck passes --jq
esac
SHIM
chmod +x "$TMP/bin/gh"
dated_case() {
  local name=$1 want_rc=$2 want_txt=$3 out rc
  rm -f "$TMP/dthreads.count"
  out=$(GATE_TEST_DIR="$TMP" PATH="$TMP/bin:$PATH" bash "$GATE" 1 2>&1); rc=$?
  if [ "$rc" = "$want_rc" ] && grep -qF "$want_txt" <<<"$out"; then
    echo "  PASS  $name"; pass=$((pass+1))
  else
    echo "  FAIL  $name (rc=$rc want=$want_rc)"; sed 's/^/          /' <<<"$out" | head -4; fail=$((fail+1))
  fi
}
GATE_TEST_DTHREADS2=dthreads2 \
  dated_case "a finding's edit date moving between the two reads blocks" 2 "review threads on this PR changed"
dated_case "two identically dated thread reads still reach a verdict" 0 "CLEAR"
# A field ABSENT from the second read is not the same as a field that is null in the first:
# null says never edited, absence says the read did not ask, and the gate validates the dates
# of the first read only. A fingerprint that projects the absent field to null compares the
# two as equal and judges from the first read alone.
sed '0,/"lastEditedAt":null,/s///' "$TMP/dthreads.json" > "$TMP/dthreads3.json"
grep -qF '"originalLine":1,"createdAt":"2026-01-01T00:00:00Z","body"' "$TMP/dthreads3.json" \
  || { echo "  FAIL  dthreads3 fixture edit did not apply"; fail=$((fail+1)); }
GATE_TEST_DTHREADS2=dthreads3 \
  dated_case "a second read missing a finding's lastEditedAt field blocks" 2 "review threads on this PR changed"

echo "== addition 6d: an answer is dated by its creation, never by its own edits =="
# A claim is dated by when its current text was written (written_at). An ANSWER is dated by
# when it was created (answered_at): an old disposition edited after a newer claim must not
# stretch over that claim, because it was written before the claim said what it says now.
# Its current text still decides whether it is a disposition at all. Each case: the claim is
# created 01-01 and edited 01-03, the answer created 01-02 and edited 01-04.
run_case "a thread disposition edited after the finding's edit does not answer it" \
  "$(wrap "$(edited_th '"lastEditedAt":"2026-01-03T00:00:00Z",' | sed 's/"createdAt":"2026-01-02T00:00:00Z","lastEditedAt":null/"createdAt":"2026-01-02T00:00:00Z","lastEditedAt":"2026-01-04T00:00:00Z"/')")" \
  1 "REOPENED" "src/row.ts:7"
CLAIM_RV='{"author":{"login":"coderabbitai","__typename":"Bot"},"state":"COMMENTED","submittedAt":"2026-01-01T00:00:00Z","lastEditedAt":"2026-01-03T00:00:00Z","body":"P1: drops a row","commit":{"oid":"0ldc0mm1t"},"comments":{"totalCount":0,"nodes":[]}}'
answer_rv() { printf '{"author":{"login":"me","__typename":"User"},"state":"COMMENTED","submittedAt":"%s","lastEditedAt":"%s","body":"RED-VERIFIED: row.test.ts","commit":{"oid":"deadbeef"},"comments":{"totalCount":0,"nodes":[]}}' "$1" "$2"; }
run_env_case "an author review edited after the review body's edit does not answer it" \
  "" "$(wrapQ "$CLAIM_RV,$(answer_rv 2026-01-02T00:00:00Z 2026-01-04T00:00:00Z),$APPROVE")" 1 "UNANSWERED coderabbitai"
CLAIM_CMT=$(cmt codex User 2026-01-01T00:00:00Z '"P1: drops a row"' 2026-01-03T00:00:00Z)
run_env_case "a PR comment answer edited after the comment claim's edit does not answer it" \
  "" "$(wrapQ "$APPROVE" "$CLAIM_CMT,$(cmt me User 2026-01-02T00:00:00Z '"NOT-A-DEFECT: renamed only"' 2026-01-04T00:00:00Z)")" 1 "UNANSWERED codex"
run_env_case "a review answer edited after the PR comment claim's edit does not answer it" \
  "" "$(wrapQ "$(answer_rv 2026-01-02T00:00:00Z 2026-01-04T00:00:00Z),$APPROVE" "$CLAIM_CMT")" 1 "UNANSWERED codex"
# Guards, green before and after: an answer CREATED after the claim's edit answers it, in
# every container, and an answer's own later edit does not take that away.
run_case "a thread disposition created after the finding's edit answers it" \
  "$(wrap "$(edited_th '"lastEditedAt":"2026-01-03T00:00:00Z",' "$(printf '%s' "$LATE_ANSWER" | sed 's/"lastEditedAt":null/"lastEditedAt":"2026-01-05T00:00:00Z"/')")")" 0 "CLEAR"
run_env_case "an author review created after the review body's edit answers it" \
  "" "$(wrapQ "$CLAIM_RV,$(answer_rv 2026-01-04T00:00:00Z 2026-01-05T00:00:00Z),$APPROVE")" 0 "CLEAR"
run_env_case "a PR comment answer created after the comment claim's edit answers it" \
  "" "$(wrapQ "$APPROVE" "$CLAIM_CMT,$(cmt me User 2026-01-04T00:00:00Z '"NOT-A-DEFECT: renamed only"' 2026-01-05T00:00:00Z)")" 0 "CLEAR"

echo "== addition 6e: a CodeRabbit acknowledgement edit does not reopen an answered finding =="
# CodeRabbit edits its own finding seconds after it is answered: it swaps the closing marker
# "<!-- This is an auto-generated comment by CodeRabbit -->" for "...reply by CodeRabbit -->"
# and, on #65, appends "✅ Confirmed as addressed by @<login>" plus the comment marker again.
# Under 6c every addressed CodeRabbit finding read as edited after its answer and reopened.
# The gate now rebuilds the finding as it stood when the answer was created from GitHub's
# edit history (userContentEdits) and lets the answer stand only when every later edit was
# made by the CodeRabbit Bot and turned that body into the current one by those observed
# steps alone. The fixtures are the live #65 and #67 payloads with the edit histories the
# gate fetches.
run_env_case "#65: CodeRabbit's acknowledgement edits leave its three answered findings answered" \
  "" "$(cat "$FIXTURES/review-threads-live-65-cr-ack.json")" 0 "CLEAR" "REOPENED"
run_env_case "#67: CodeRabbit's marker-swap edit leaves its answered finding answered" \
  "" "$(cat "$FIXTURES/review-threads-live-67-cr-ack.json")" 0 "CLEAR" "REOPENED"
# Guards, BLOCKED before and after: anything but the observed acknowledgement, by anyone but
# the bot, or a history the gate cannot read in full, reopens the finding. Each varies the
# #65 finding on FEASIBILITY.md:42 (thread PRRT_kwDOS6_t2M6rRnNY); the edit history lists the
# newest revision first, so nodes[0] is the current body.
ack_guard() {
  local name=$1 filter=$2 varied
  varied=$(jq --arg nl $'\n' "$ACK_THREAD_FILTER_PRE($filter)$ACK_THREAD_FILTER_POST" \
    "$FIXTURES/review-threads-live-65-cr-ack.json")
  if [ "$(jq -cS . <<<"$varied")" = "$(jq -cS . "$FIXTURES/review-threads-live-65-cr-ack.json")" ]; then
    echo "  FAIL  $name (the variation did not change the fixture)"; fail=$((fail+1)); return
  fi
  run_env_case "$name" "" "$varied" 1 "REOPENED   coderabbitai  FEASIBILITY.md:42"
}
ACK_THREAD_FILTER_PRE='.data.repository.pullRequest.reviewThreads.nodes |= map(if .id == "PRRT_kwDOS6_t2M6rRnNY" then .comments.nodes[0] |= '
ACK_THREAD_FILTER_POST=' else . end)'
ack_guard "the acknowledgement plus another text change reopens" \
  '(.body |= sub("Quick win"; "Trivial")) | (.userContentEdits.nodes[0].diff |= sub("Quick win"; "Trivial"))'
ack_guard "an edit that rewrites the finding reopens" \
  '("P1: this deletes the lockfile." + $nl + $nl + "<!-- This is an auto-generated reply by CodeRabbit -->" + $nl + $nl + "✅ Confirmed as addressed by @ejc3" + $nl + $nl + "<!-- This is an auto-generated comment by CodeRabbit -->") as $b | .body = $b | .userContentEdits.nodes[0].diff = $b'
ack_guard "two acknowledgements reopen" \
  '($nl + $nl + "✅ Confirmed as addressed by @ejc3" + $nl + $nl + "<!-- This is an auto-generated comment by CodeRabbit -->") as $a | .body += $a | .userContentEdits.nodes[0].diff += $a'
ack_guard "the acknowledgement added by a user account reopens" \
  '.userContentEdits.nodes[0].editor = {"login":"ejc3","__typename":"User"}'
ack_guard "the acknowledgement added by a user account named like the bot reopens" \
  '.userContentEdits.nodes[0].editor = {"login":"coderabbitai","__typename":"User"}'
ack_guard "a finding from a user account named like the bot reopens" \
  '.author.__typename = "User"'
ack_guard "a finding with no edit history reopens" \
  'del(.userContentEdits)'
ack_guard "an edit history with a further page reopens" \
  '.userContentEdits.pageInfo.hasNextPage = true'
ack_guard "an edit history shorter than its totalCount reopens" \
  '.userContentEdits.totalCount = 4'
ack_guard "a deleted revision in the edit history reopens" \
  '.userContentEdits.nodes[1].deletedAt = "2026-10-11T21:30:00Z"'
ack_guard "an edit history whose newest revision is not the body reopens" \
  '.userContentEdits.nodes[0].diff = "P2: something else"'
ack_guard "an edit history with an unparsable editedAt reopens" \
  '.userContentEdits.nodes[1].editedAt = "soon"'
ack_guard "an edit history missing the original revision reopens" \
  '.userContentEdits.nodes |= .[0:2] | .userContentEdits.totalCount = 2'

# The live path FETCHES the history: the thread query carries each comment's id and author
# type, and an edited finding on a resolved thread has its userContentEdits read by node id.
# A history the query cannot return (a null node) reopens the finding; a failed request is a
# read failure and exits 2.
mkdir -p "$TMP/bin"
ACK_B0=$'P2: tighten the wording.\n\n<!-- This is an auto-generated comment by CodeRabbit -->'
ACK_B1=$'P2: tighten the wording.\n\n<!-- This is an auto-generated reply by CodeRabbit -->\n\n✅ Confirmed as addressed by @me\n\n<!-- This is an auto-generated comment by CodeRabbit -->'
jq -n --arg b "$ACK_B1" '{data:{repository:{pullRequest:{reviewThreads:{pageInfo:{hasNextPage:false,endCursor:null},nodes:[{id:"T1",isResolved:true,isOutdated:false,comments:{totalCount:2,pageInfo:{hasNextPage:false,endCursor:null},nodes:[
  {id:"C1",author:{login:"coderabbitai",__typename:"Bot"},path:"a.ts",line:1,originalLine:1,createdAt:"2026-01-01T00:00:00Z",lastEditedAt:"2026-01-01T02:00:00Z",body:$b},
  {id:"C2",author:{login:"me",__typename:"User"},path:"a.ts",line:1,originalLine:1,createdAt:"2026-01-01T01:00:00Z",lastEditedAt:null,body:"NOT-A-DEFECT: reworded"}]}}]}}}}}' > "$TMP/athreads.json"
jq -n --arg b0 "$ACK_B0" --arg b1 "$ACK_B1" '{data:{node:{userContentEdits:{totalCount:2,pageInfo:{hasNextPage:false,endCursor:"E2"},nodes:[
  {editedAt:"2026-01-01T02:00:00Z",deletedAt:null,editor:{login:"coderabbitai",__typename:"Bot"},diff:$b1},
  {editedAt:"2026-01-01T00:00:00Z",deletedAt:null,editor:{login:"coderabbitai",__typename:"Bot"},diff:$b0}]}}}}' > "$TMP/aedits.json"
printf '{"data":{"node":null}}' > "$TMP/aedits-null.json"
printf '{"data":{"repository":{"pullRequest":{"author":{"login":"me"},"headRefOid":"deadbeef","commits":{"nodes":[{"commit":{"committedDate":"2026-01-02T00:00:00Z","checkSuites":{"nodes":[{"createdAt":"2026-01-02T00:30:00Z"}]}}}]},"reviews":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"author":{"login":"reviewer"},"state":"COMMENTED","submittedAt":"2026-01-02T01:00:00Z","lastEditedAt":null,"body":"","commit":{"oid":"deadbeef"},"comments":{"totalCount":1,"nodes":[{"replyTo":null}]}}]}}}}}' > "$TMP/areviews.json"
printf '{"data":{"repository":{"pullRequest":{"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}}' > "$TMP/acomments.json"
printf '%s' "$PRCOMMITS_LIVE" > "$TMP/prcommits.json"
cat > "$TMP/bin/gh" <<'SHIM'
#!/bin/bash
case "$*" in
  *userContentEdits*)
    [ "${GATE_TEST_EDITS:-aedits}" = fail ] && exit 1
    cat "$GATE_TEST_DIR/${GATE_TEST_EDITS:-aedits}.json" ;;
  *"commits(first"*)   cat "$GATE_TEST_DIR/prcommits.json" ;;
  *reviewThreads*)     cat "$GATE_TEST_DIR/athreads.json" ;;
  *"reviews(first"*)   cat "$GATE_TEST_DIR/areviews.json" ;;
  *"comments(first"*)  cat "$GATE_TEST_DIR/acomments.json" ;;
  *headRefOid*)        printf 'deadbeef\n' ;;  # the recheck passes --jq
esac
SHIM
chmod +x "$TMP/bin/gh"
ack_live_case() {
  local name=$1 want_rc=$2 want_txt=$3 out rc
  out=$(GATE_TEST_DIR="$TMP" PATH="$TMP/bin:$PATH" bash "$GATE" 1 2>&1); rc=$?
  if [ "$rc" = "$want_rc" ] && grep -qF "$want_txt" <<<"$out"; then
    echo "  PASS  $name"; pass=$((pass+1))
  else
    echo "  FAIL  $name (rc=$rc want=$want_rc)"; sed 's/^/          /' <<<"$out" | head -4; fail=$((fail+1))
  fi
}
ack_live_case "the live path reads an edited finding's history and keeps its answer" 0 "CLEAR"
GATE_TEST_EDITS=aedits-null ack_live_case "an edit history the query cannot return reopens the finding" 1 "REOPENED"
GATE_TEST_EDITS=fail ack_live_case "a failed edit-history request exits 2" 2 "edit history"

echo "== addition 7: the live PRs these rules were written against =="
# #46: CodeRabbit's three review bodies (actionable comments, nitpicks) and six open threads
# block, and so does its summary, whose pre-merge checks report a failed check (docstring
# coverage warning): a summary that reports a failure is not waved through.
run_env_case "#46: the review bodies, the threads and the failed-check summary all block" \
  "" "$(cat "$FIXTURES/review-threads-live-46.json")" 1 "4 PR-level review body/bodies"
run_env_case "#46: the summary with a failed pre-merge check is listed" \
  "" "$(cat "$FIXTURES/review-threads-live-46.json")" 1 "UNANSWERED coderabbitai (COMMENT)"
run_env_case "#46: the six open CodeRabbit threads are still listed" \
  "" "$(cat "$FIXTURES/review-threads-live-46.json")" 1 "7 total, 6 unresolved"
# #64: Codex P1 inline (answered RED-VERIFIED, resolved), container review, two no-findings
# verdicts, CodeRabbit summary + three acknowledgements.
# Its CodeRabbit summary reports "Failed checks (1 warning)" (docstring coverage), so that
# summary is the one thing left to answer.
run_env_case "#64: only the summary with a failed pre-merge check is unanswered" \
  "" "$(cat "$FIXTURES/review-threads-live-64.json")" 1 "1 PR-level review body/bodies" "UNANSWERED chatgpt-codex-connector"
run_env_case "#64: with both bots required, CodeRabbit's head review is missing" \
  "$REQ" "$(cat "$FIXTURES/review-threads-live-64.json")" 1 "MISSING HEAD REVIEW  coderabbitai"
run_env_case "#63: the skip-review summary is not a claim" \
  "" "$(cat "$FIXTURES/review-threads-live-63.json")" 1 "UNREVIEWED HEAD" "UNANSWERED"
run_env_case "#65: an answered, resolved thread and a :+1: verdict on the head, CLEAR" \
  "" "$(cat "$FIXTURES/review-threads-live-65.json")" 0 "CLEAR" "UNANSWERED"
run_env_case "#66: the new sign-off verdict covers the head, CLEAR" \
  "" "$(cat "$FIXTURES/review-threads-live-66.json")" 0 "HEAD COVERED" "UNANSWERED"
run_env_case "#67: both threads answered, nothing unanswered, the head not yet reviewed" \
  "" "$(cat "$FIXTURES/review-threads-live-67.json")" 1 "UNREVIEWED HEAD" "UNANSWERED"

echo "== addition 8: post-status.sh posts a success only against an unchanged snapshot =="
POSTER="$(dirname "$0")/post-status.sh"
mkdir -p "$TMP/psbin"
# gh shim: GET answers come from $PS_DIR/<endpoint-with-slashes-as-underscores>.json, passed
# through the --jq filter the way gh applies it (a missing file is a failed read); a POST is
# recorded and exits $PS_POST_RC.
cat > "$TMP/psbin/gh" <<'SHIM'
#!/bin/bash
args=("$@"); filter=""; endpoint=""; post=0; paginate=0
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[$i]}" in
    --jq) filter=${args[$((i + 1))]}; i=$((i + 1)) ;;
    -X) [ "${args[$((i + 1))]}" = POST ] && post=1; i=$((i + 1)) ;;
    -f | -F) i=$((i + 1)) ;;
    --paginate) paginate=1 ;;
    api) ;;
    *) endpoint=${args[$i]} ;;
  esac
done
if [ "$post" = 1 ]; then printf '%s\n' "$*" >> "$PS_DIR/posts"; exit "${PS_POST_RC:-0}"; fi
f="$PS_DIR/$(printf '%s' "${endpoint%%\?*}" | tr '/' '_').json"
# A fixture "<name>.after" replaces <name> once a POST has been recorded: what changed after
# the write. Its content SHIM_FAIL makes that read fail.
[ -s "$PS_DIR/posts" ] && [ -r "$f.after" ] && f="$f.after"
[ -r "$f" ] || { echo "shim: no fixture for $endpoint" >&2; exit 1; }
[ "$(head -c 9 "$f")" != SHIM_FAIL ] || { echo "shim: read failed for $endpoint" >&2; exit 1; }
# With --paginate, a fixture "<name>.page2" is the next page; without it, the caller sees page 1 only.
pages=("$f"); [ "$paginate" = 1 ] && [ -r "$f.page2" ] && pages+=("$f.page2")
for pg in "${pages[@]}"; do
  if [ -n "$filter" ]; then jq -r "$filter" "$pg"; else cat "$pg"; fi
done
SHIM
chmod +x "$TMP/psbin/gh"
PS_SHA=0123456789abcdef0123456789abcdef01234567
ps_n=0
OURS_URL=https://github.com/o/r/actions/runs/77
OURS_RUN='{"path":".github/workflows/review-gate.yml","event":"issue_comment","head_branch":"main"}'
# One status; $5 is its created_at.
st() { printf '{"context":"review-gate","state":"%s","description":"%s","creator":{"login":"%s"},"target_url":"%s","created_at":"%s"}' \
  "$1" "$2" "$3" "$4" "${5:-2026-01-01T00:00:00Z}"; }
runs() { printf '{"workflow_runs":[%s]}' "$1"; }
wrun() { printf '{"id":%s,"event":"%s","created_at":"%s"}' "$1" "$2" "$3"; }
# The PR as the success check reads it: $1 head, $2 the newest activity.
gql() { printf '{"data":{"repository":{"pullRequest":{"headRefOid":"%s","updatedAt":"%s","comments":{"nodes":[{"createdAt":"2026-01-01T00:00:00Z","updatedAt":"%s","lastEditedAt":null}]},"reviews":{"nodes":[]},"reviewThreads":{"nodes":[]}}}}}' "$1" "$2" "$2"; }
# The snapshot every success case starts from: evaluation began 00:04, PR #7, this is run 88,
# no other run since, PR quiet since 00:03. A case overrides one piece with PS_RUNS, PS_GQL
# (UNREADABLE makes the read fail) or its env column.
SNAP="EVAL_STARTED=2026-01-02T00:04:00Z|PRS=7|GITHUB_RUN_ID=88"
NOW_OK=$(st success 'CLEAR' 'github-actions[bot]' "$OURS_URL" 2026-01-02T00:06:00Z)
QUIET_RUNS=$(runs "$(wrun 88 issue_comment 2026-01-02T00:04:00Z),$(wrun 90 schedule 2026-01-02T00:05:00Z)")
QUIET_PR=$(gql "$PS_SHA" 2026-01-02T00:03:00Z)
# $1 name, $2 statuses JSON (newest first, or UNREADABLE), $3 run JSON for run 77 (or ""),
# $4 env, $5 state, $6 description, $7 expected exit, $8 expected POSTs, $9 text the POST
# must carry, $10 text the LAST POST must carry (the newest status is what a merge reads).
ps_case() {
  local name=$1 statuses=$2 run=$3 envs=$4 st=$5 de=$6 want_rc=$7 want_posts=$8 want_post_txt=${9:-} want_last=${10:-}
  ps_n=$((ps_n + 1)); local d="$TMP/ps.$ps_n"; mkdir "$d"
  [ "$statuses" = UNREADABLE ] || printf '%s' "$statuses" > "$d/repos_o_r_commits_${PS_SHA}_statuses.json"
  [ -z "$run" ] || printf '%s' "$run" > "$d/repos_o_r_actions_runs_77.json"
  local r=${PS_RUNS-$QUIET_RUNS} g=${PS_GQL-$QUIET_PR}
  [ "$r" = UNREADABLE ] || printf '%s' "$r" > "$d/repos_o_r_actions_workflows_review-gate.yml_runs.json"
  [ "$g" = UNREADABLE ] || printf '%s' "$g" > "$d/graphql.json"
  # After a success is posted, a status read shows that success as the newest status.
  printf '%s' "${PS_AFTER_STATUSES:-[$NOW_OK]}" > "$d/repos_o_r_commits_${PS_SHA}_statuses.json.after"
  [ -z "${PS_AFTER_RUNS:-}" ] || printf '%s' "$PS_AFTER_RUNS" > "$d/repos_o_r_actions_workflows_review-gate.yml_runs.json.after"
  [ -z "${PS_AFTER_GQL:-}" ] || printf '%s' "$PS_AFTER_GQL" > "$d/graphql.json.after"
  local envarr=() out rc posts
  [ -z "$envs" ] || IFS='|' read -r -a envarr <<<"$envs"
  out=$(env -u EVAL_STARTED -u PRS -u GITHUB_RUN_ID PS_DIR="$d" PATH="$TMP/psbin:$PATH" GITHUB_REPOSITORY=o/r \
        GITHUB_SERVER_URL=https://github.com RUN_URL=https://github.com/o/r/actions/runs/88 "${envarr[@]}" \
        bash "$POSTER" "$PS_SHA" "$st" "$de" 2>&1); rc=$?
  posts=$(grep -c . "$d/posts" 2>/dev/null || true)
  if [ "$rc" = "$want_rc" ] && [ "${posts:-0}" = "$want_posts" ] \
     && { [ -z "$want_post_txt" ] || grep -qF -- "$want_post_txt" "$d/posts"; } \
     && { [ -z "$want_last" ] || tail -n1 "$d/posts" | grep -qF -- "$want_last"; }; then
    echo "  PASS  $name"; pass=$((pass+1))
  else
    echo "  FAIL  $name (rc=$rc want=$want_rc, posts=${posts:-0} want=$want_posts)"
    sed 's/^/          /' <<<"$out" | head -4; [ -r "$d/posts" ] && sed 's/^/          POST /' "$d/posts"
    fail=$((fail+1))
  fi
}
FAIL_ST="[$(st failure 'BLOCKED x' 'github-actions[bot]' "$OURS_URL")]"
OK_ST="[$(st success 'CLEAR' 'github-actions[bot]' "$OURS_URL")]"
# Changes only, and the quota (PR #70's P2: two statuses per event).
ps_case "no status yet: post the verdict" '[]' "" "" failure "BLOCKED x" 0 1 "state=failure"
ps_case "the same failure again: post nothing" "$FAIL_ST" "$OURS_RUN" "" failure "BLOCKED x" 0 0
ps_case "a changed description: post it" "$FAIL_ST" "$OURS_RUN" "" failure "BLOCKED y" 0 1 "BLOCKED y"
ps_case "our own success again: post nothing" "$OK_ST" "$OURS_RUN" "$SNAP" success "CLEAR" 0 0
ps_case "only the newest status of the context counts" \
  "[$(st failure 'BLOCKED x' 'github-actions[bot]' "$OURS_URL"),$(st success 'CLEAR' 'github-actions[bot]' "$OURS_URL")]" \
  "$OURS_RUN" "$SNAP" success "CLEAR" 0 1 "state=success"
many=$(for i in $(seq 1 5); do st failure "BLOCKED $i" 'github-actions[bot]' "$OURS_URL"; echo ,; done | tr -d '\n' | sed 's/,$//')
ps_case "near the status cap a success is posted as error" "[$many]" "$OURS_RUN" "$SNAP|STATUS_QUOTA_GUARD=5" success "CLEAR" 0 1 "state=error"
ps_case "below the cap a success is posted as success" "[$many]" "$OURS_RUN" "$SNAP|STATUS_QUOTA_GUARD=6" success "CLEAR" 0 1 "state=success"
ps_case "a refused POST fails loudly" '[]' "" "PS_POST_RC=1" failure "BLOCKED x" 1 1
ps_case "pending is not posted over a missing status" '[]' "" "" pending "x" 0 0
ps_case "pending is not posted over a failure" "$FAIL_ST" "$OURS_RUN" "" pending "x" 0 0
ps_case "pending is posted over a success" "$OK_ST" "$OURS_RUN" "" pending "x" 0 1 "state=pending"
ps_case "an unknown state is refused" '[]' "" "" approved "x" 2 0
# Forged successes.
ps_case "a success posted by a person is replaced even by the same verdict" \
  "[$(st success 'CLEAR' 'someone' '')]" "" "$SNAP" success "CLEAR" 0 1 "state=success"
ps_case "a success from another workflow is replaced" "$OK_ST" \
  '{"path":".github/workflows/other.yml","event":"pull_request","head_branch":"x"}' "" failure "BLOCKED x" 0 1 "state=failure"
ps_case "a success from review-gate.yml run on a branch push is replaced" "$OK_ST" \
  '{"path":".github/workflows/review-gate.yml","event":"push","head_branch":"evil"}' "$SNAP" success "CLEAR" 0 1 "state=success"
ps_case "a success from review-gate.yml dispatched on another ref is replaced" "$OK_ST" \
  '{"path":".github/workflows/review-gate.yml","event":"workflow_dispatch","head_branch":"evil"}' "$SNAP" success "CLEAR" 0 1 "state=success"
# The success rule: verified against the snapshot, or blocking (PR #70's P1 and the closure
# review's races and partial failures).
ps_case "a success with a quiet snapshot is posted" "$FAIL_ST" "$OURS_RUN" "$SNAP" success "CLEAR" 0 1 "state=success"
ps_case "a success with no snapshot is posted as error" "$FAIL_ST" "$OURS_RUN" "" success "CLEAR" 0 1 "state=error"
ps_case "a success is not posted over another run's newer error" \
  "[$(st error 'The gate could not resolve this event' 'github-actions[bot]' "$OURS_URL" 2026-01-02T00:05:00Z)]" \
  "$OURS_RUN" "$SNAP" success "CLEAR" 0 1 "state=pending"
ps_case "an error posted in the snapshot's own second holds a success back" \
  "[$(st error 'The gate could not resolve this event' 'github-actions[bot]' "$OURS_URL" 2026-01-02T00:04:00Z)]" \
  "$OURS_RUN" "$SNAP" success "CLEAR" 0 1 "state=pending"
PS_GQL=$(gql "$PS_SHA" 2026-01-02T00:04:00Z) \
  ps_case "PR activity in the snapshot's own second turns a success into pending" "$FAIL_ST" "$OURS_RUN" "$SNAP" success "CLEAR" 0 1 "state=pending"
ps_case "an error older than the snapshot does not hold a success back" \
  "[$(st error 'The gate could not resolve this event' 'github-actions[bot]' "$OURS_URL" 2026-01-02T00:03:00Z)]" \
  "$OURS_RUN" "$SNAP" success "CLEAR" 0 1 "state=success"
PS_RUNS=$(runs "$(wrun 88 issue_comment 2026-01-02T00:04:00Z),$(wrun 91 issue_comment 2026-01-02T00:05:00Z)") \
  ps_case "a newer event run turns a success into pending" "$FAIL_ST" "$OURS_RUN" "$SNAP" success "CLEAR" 0 1 "state=pending"
PS_RUNS=$(runs "$(wrun 91 workflow_run 2026-01-02T00:05:00Z)") \
  ps_case "a standing success is turned pending when a newer event run exists" "$OK_ST" "$OURS_RUN" "$SNAP" success "CLEAR" 0 1 "state=pending"
PS_RUNS=$(runs "$(wrun 91 issue_comment 2026-01-02T00:03:00Z)") \
  ps_case "a run created before the evaluation began does not defer it" "$FAIL_ST" "$OURS_RUN" "$SNAP" success "CLEAR" 0 1 "state=success"
PS_RUNS=UNREADABLE \
  ps_case "a run list that cannot be read turns a success into error" "$FAIL_ST" "$OURS_RUN" "$SNAP" success "CLEAR" 0 1 "state=error"
PS_GQL=$(gql "$PS_SHA" 2026-01-02T00:05:00Z) \
  ps_case "activity on the PR after the snapshot turns a success into pending" "$FAIL_ST" "$OURS_RUN" "$SNAP" success "CLEAR" 0 1 "state=pending"
PS_GQL=$(gql fedcba9876543210fedcba9876543210fedcba98 2026-01-02T00:03:00Z) \
  ps_case "a PR that moved off the commit turns a success into pending" "$FAIL_ST" "$OURS_RUN" "$SNAP" success "CLEAR" 0 1 "state=pending"
PS_GQL=UNREADABLE \
  ps_case "a PR that cannot be read turns a success into error" "$FAIL_ST" "$OURS_RUN" "$SNAP" success "CLEAR" 0 1 "state=error"
PS_GQL='{"data":{"repository":{"pullRequest":null}}}' \
  ps_case "a PR the token cannot see turns a success into error" "$FAIL_ST" "$OURS_RUN" "$SNAP" success "CLEAR" 0 1 "state=error"
# The success POST is unconditional, so what changes after the last pre-POST read is only
# visible to a re-read: a blocking signal there leaves the newest status blocking again
# (PR #70's P1 on the success POST). The ".after" fixtures appear once the success is posted.
RACE_URL=https://github.com/o/r/actions/runs/91
PS_AFTER_STATUSES="[$NOW_OK,$(st pending 'Re-evaluating after a new event' 'github-actions[bot]' "$RACE_URL" 2026-01-02T00:05:00Z)]" \
  ps_case "a pending posted just before the success leads to a pending POST after it" "$FAIL_ST" "$OURS_RUN" "$SNAP" success "CLEAR" 0 2 "state=pending" "state=pending"
PS_AFTER_STATUSES="[$NOW_OK,$(st error 'The gate could not resolve this event' 'github-actions[bot]' "$RACE_URL" 2026-01-02T00:05:00Z)]" \
  ps_case "an error posted just before the success leads to a pending POST after it" "$FAIL_ST" "$OURS_RUN" "$SNAP" success "CLEAR" 0 2 "state=pending" "state=pending"
PS_AFTER_STATUSES="[$NOW_OK,$(st pending 'x' 'github-actions[bot]' "$RACE_URL" 2026-01-02T00:05:00Z)]" \
  ps_case "the post-success pending names the race" "$FAIL_ST" "$OURS_RUN" "$SNAP" success "CLEAR" 0 2 "state=success" "description=Raced a success"
PS_AFTER_STATUSES="[$(st pending 'x' 'github-actions[bot]' "$RACE_URL" 2026-01-02T00:07:00Z),$NOW_OK]" \
  ps_case "a pending newer than the success is not posted again" "$FAIL_ST" "$OURS_RUN" "$SNAP" success "CLEAR" 0 1 "state=success" "state=success"
PS_AFTER_RUNS=$(runs "$(wrun 88 issue_comment 2026-01-02T00:04:00Z),$(wrun 91 issue_comment 2026-01-02T00:05:30Z)") \
  ps_case "an event run created after the last read leads to a pending POST after the success" "$FAIL_ST" "$OURS_RUN" "$SNAP" success "CLEAR" 0 2 "state=pending" "state=pending"
PS_AFTER_GQL=$(gql "$PS_SHA" 2026-01-02T00:05:30Z) \
  ps_case "PR activity after the last read leads to a pending POST after the success" "$FAIL_ST" "$OURS_RUN" "$SNAP" success "CLEAR" 0 2 "state=pending" "state=pending"
PS_AFTER_GQL=$(gql fedcba9876543210fedcba9876543210fedcba98 2026-01-02T00:03:00Z) \
  ps_case "a head that moved after the last read leads to a pending POST after the success" "$FAIL_ST" "$OURS_RUN" "$SNAP" success "CLEAR" 0 2 "state=pending" "state=pending"
PS_AFTER_GQL=SHIM_FAIL \
  ps_case "a PR re-read that fails after the success leaves an error, not the success" "$FAIL_ST" "$OURS_RUN" "$SNAP" success "CLEAR" 0 2 "state=error" "state=error"
PS_AFTER_STATUSES=SHIM_FAIL \
  ps_case "a status re-read that fails after the success leaves an error" "$FAIL_ST" "$OURS_RUN" "$SNAP" success "CLEAR" 0 2 "state=error" "state=error"
PS_AFTER_STATUSES="[$NOW_OK]" \
  ps_case "nothing changed after the success: the success stands, one POST" "$FAIL_ST" "$OURS_RUN" "$SNAP" success "CLEAR" 0 1 "state=success" "state=success"
# A status list that cannot be read: nothing is skipped.
ps_case "an unreadable status list posts the error asked for" UNREADABLE "" "" error "could not evaluate" 0 1 "state=error"
ps_case "an unreadable status list posts the pending asked for" UNREADABLE "" "" pending "x" 0 1 "state=pending"
ps_case "an unreadable status list turns a success into error" UNREADABLE "" "$SNAP" success "CLEAR" 0 1 "state=error"

echo "== addition 8b: merge-pr.sh merges only a CLEAR head, by that head =="
MERGER="$(dirname "$0")/merge-pr.sh"
mkdir -p "$TMP/mpbin"
cat > "$TMP/mpbin/gh" <<'SHIM'
#!/bin/bash
printf '%s\n' "$*" >> "$MP_DIR/calls"
case "$*" in
  "pr view"*) [ -n "${MP_VIEW:-}" ] || exit 1; printf '%s\n' "$MP_VIEW" ;;
  "pr merge"*) exit 0 ;;
esac
SHIM
chmod +x "$TMP/mpbin/gh"
printf '#!/bin/bash\necho "EXPECT_HEAD=$EXPECT_HEAD REQ=$REQUIRE_HEAD_REVIEW_FROM pr=$1" >> "$MP_DIR/gate"\nexit "${MP_GATE_RC:-0}"\n' > "$TMP/mpgate.sh"
mp_case() {
  local name=$1 view=$2 gate_rc=$3 want_rc=$4 want_merge=$5 out rc d
  ps_n=$((ps_n + 1)); d="$TMP/mp.$ps_n"; mkdir "$d"
  out=$(env MP_DIR="$d" MP_VIEW="$view" MP_GATE_RC="$gate_rc" MERGE_GATE_SCRIPT="$TMP/mpgate.sh" \
        PATH="$TMP/mpbin:$PATH" GITHUB_REPOSITORY=o/r bash "$MERGER" 7 2>&1); rc=$?
  local merged; merged=$(grep -c '^pr merge' "$d/calls" 2>/dev/null || true)
  if [ "$rc" = "$want_rc" ] && [ "${merged:-0}" = "$want_merge" ] \
     && { [ "$want_merge" = 0 ] || { grep -qF -- "--match-head-commit $PS_SHA" "$d/calls" \
          && grep -qF "EXPECT_HEAD=$PS_SHA" "$d/gate"; }; }; then
    echo "  PASS  $name"; pass=$((pass+1))
  else
    echo "  FAIL  $name (rc=$rc want=$want_rc, merges=${merged:-0} want=$want_merge)"
    sed 's/^/          /' <<<"$out" | head -4; fail=$((fail+1))
  fi
}
MP_OPEN=$(printf '{"state":"OPEN","headRefOid":"%s","baseRefName":"main"}' "$PS_SHA")
mp_case "a CLEAR head is merged by that head" "$MP_OPEN" 0 0 1
# The gate and the merge read one repository, whichever variables are set.
d="$TMP/mp.repo"; mkdir "$d"
printf '#!/bin/bash\necho "gate repo=$REPO_OWNER/$REPO_NAME" >> "$MP_DIR/gate"\n' > "$TMP/mpgate-repo.sh"
env MP_DIR="$d" MP_VIEW="$MP_OPEN" MERGE_GATE_SCRIPT="$TMP/mpgate-repo.sh" PATH="$TMP/mpbin:$PATH" \
  GITHUB_REPOSITORY=a/b REPO_OWNER=c bash "$MERGER" 7 >/dev/null 2>&1
if grep -q 'gate repo=c/b' "$d/gate" 2>/dev/null && grep -q '^pr view 7 --repo c/b' "$d/calls" \
   && grep -q '^pr merge 7 --repo c/b' "$d/calls"; then
  echo "  PASS  the gate and the merge read the same repository"; pass=$((pass+1))
else
  echo "  FAIL  the gate and the merge read the same repository"; cat "$d/gate" "$d/calls" 2>/dev/null | sed 's/^/          /'; fail=$((fail+1))
fi
mp_case "a blocked head is not merged" "$MP_OPEN" 1 1 0
mp_case "a gate that cannot evaluate does not merge" "$MP_OPEN" 2 1 0
mp_case "a PR that cannot be read is not merged" "" 0 2 0
mp_case "a closed PR is not merged" "$(printf '{"state":"CLOSED","headRefOid":"%s","baseRefName":"main"}' "$PS_SHA")" 0 2 0

echo "== addition 9: the gate workflows' structure =="
# Each check below pins one property of .github/workflows/review-gate*.yml that no runtime
# case can reach. Point WORKFLOWS_DIR elsewhere to run them against another copy.
WORKFLOWS_DIR=${WORKFLOWS_DIR:-"$(dirname "$0")/../../../.github/workflows"}
wf_out=$(python3 - "$WORKFLOWS_DIR" <<'PY'
import glob, os, re, sys, yaml
d = sys.argv[1]
def load(name):
    with open(os.path.join(d, name)) as f:
        return yaml.safe_load(f)
def check(name, ok):
    print(("PASS" if ok else "FAIL") + "\t" + name)
files = sorted(glob.glob(os.path.join(d, "review-gate*.yml")))
uses = []
for f in files:
    for job in (yaml.safe_load(open(f)).get("jobs") or {}).values():
        for step in job.get("steps") or []:
            if "uses" in step:
                uses.append(step["uses"])
check("every action in the gate workflows is pinned to a full commit sha",
      len(files) == 3 and all(re.fullmatch(r"[\w.-]+/[\w.-]+@[0-9a-f]{40}", u) for u in uses))
wf = load("review-gate.yml")
text = open(os.path.join(d, "review-gate.yml")).read()
check("pending is posted only through post-status.sh, and not by the sweep",
      "state=pending" not in text
      and any("post-status.sh" in (s.get("run") or "") and " pending " in (s.get("run") or "")
              and "schedule" in s.get("if", "") for s in wf["jobs"]["resolve"]["steps"]))
ev = wf["jobs"]["evaluate"]["steps"]
gate = next(s for s in ev if s.get("id") == "gate")["run"]
i_stop, i_gate, i_resume = gate.find("::stop-commands::"), gate.find("check-review-threads.sh"), gate.find('echo "::$stop::"')
check("the gate runs with workflow commands stopped", -1 < i_stop < i_gate < i_resume)
check("the step summary prints the gate output HTML-escaped in <pre>",
      "<pre>" in gate and "s/</\\&lt;/g" in gate and "```" not in gate)
post = ev[-1]
check("the verdict step runs always() and posts through post-status.sh",
      "always()" in post.get("if", "") and "post-status.sh" in post["run"]
      and post.get("env", {}).get("EVAL_STARTED") == "${{ steps.head.outputs.started }}")
head = next(s for s in ev if s.get("id") == "head")["run"]
check("the evaluation start is taken before the PRs on the head are read",
      -1 < head.find("started=") < head.find("pulls?state=open"))
check("a blocked verdict fails the job only on pull_request_target",
      'failure) [ "$GITHUB_EVENT_NAME" != pull_request_target ]' in post["run"])
check("every status POST in review-gate.yml outside post-status.sh is an error",
      all("state=error" in m for m in re.findall(r"statuses/\S+\"[^\n]*(?:\n[^\n]*){0,3}", text)))
rs = wf["jobs"]["resolve"]
check("pull_request_target is answered for its own head sha",
      rs.get("env", {}).get("PRT_HEAD_SHA") == "${{ github.event.pull_request.head.sha }}"
      and any(s.get("id") == "heads" and "shas=$PRT_HEAD_SHA" in (s.get("run") or "") for s in rs["steps"]))
fb = [s for s in rs["steps"] if "failure()" in s.get("if", "")]
check("a resolve that fails has exactly one failure() fallback step", len(fb) == 1)
PY
)
while IFS=$'\t' read -r verdict wname; do
  [ -n "$verdict" ] || continue
  if [ "$verdict" = PASS ]; then echo "  PASS  $wname"; pass=$((pass+1)); else echo "  FAIL  $wname"; fail=$((fail+1)); fi
done <<<"$wf_out"
[ "$(grep -c . <<<"$wf_out")" -eq 10 ] || { echo "  FAIL  the workflow structure checks did not all run"; fail=$((fail+1)); }

echo "== addition 10: the workflow's fallback steps, run against a stubbed gh =="
# The steps run as GitHub would run them: their `run:` text, with the step's env, a gh that
# records every call. Each case names the heads that must be marked error.
fb_extract() {  # $1 job, $2 python predicate on the step -> the step's run text
  python3 - "$WORKFLOWS_DIR/review-gate.yml" "$1" "$2" <<'PY'
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
steps = [s for s in wf["jobs"][sys.argv[2]]["steps"] if eval(sys.argv[3], {"s": s})]
print(steps[0]["run"] if len(steps) == 1 else "echo 'no unique step'; exit 99")
PY
}
FB_RUN=$(fb_extract resolve '"failure()" in s.get("if", "")')
INV_RUN=$(fb_extract resolve '"schedule" in s.get("if", "")')
POST_RUN=$(fb_extract evaluate '"always()" in s.get("if", "")')
# The workflow-level env every step sees: the direct poster both fallbacks call.
POST_ERROR_DIRECT=$(python3 - "$WORKFLOWS_DIR/review-gate.yml" <<'PY2'
import sys, yaml
print(yaml.safe_load(open(sys.argv[1])).get("env", {}).get("POST_ERROR_DIRECT", ""))
PY2
)
export POST_ERROR_DIRECT
mkdir -p "$TMP/fbbin"
cat > "$TMP/fbbin/gh" <<'SHIM'
#!/bin/bash
printf '%s\n' "$*" >> "$FB_DIR/calls"
case "$*" in
  *"-X POST"*) exit 0 ;;
  *"pulls/42"*) echo "4242424242424242424242424242424242424242" ;;
  *"pulls?state=open"*) printf '%s\n%s\n' 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 ;;
  *) exit 1 ;;
esac
SHIM
chmod +x "$TMP/fbbin/gh"
H1=1111111111111111111111111111111111111111; H2=2222222222222222222222222222222222222222
HF=abababababababababababababababababababab; H42=4242424242424242424242424242424242424242
fb_case() {  # $1 name, $2 env (|-separated), $3 space-separated heads that must get state=error
  local name=$1 envs=$2 want=$3 d out rc envarr=() missing=""
  ps_n=$((ps_n + 1)); d="$TMP/fb.$ps_n"; mkdir "$d"
  IFS='|' read -r -a envarr <<<"$envs"
  out=$(cd "$d" && env FB_DIR="$d" PATH="$TMP/fbbin:$PATH" GITHUB_REPOSITORY=o/r GITHUB_SERVER_URL=https://github.com \
        GITHUB_RUN_ID=5 STATUS_CONTEXT=review-gate RUN_URL=https://github.com/o/r/actions/runs/5 RUN_PRS='[]' \
        RUN_HEAD_SHA= INPUT_PR= PRT_HEAD_SHA= ISSUE_NUMBER= "${envarr[@]}" bash -c "$FB_RUN" 2>&1); rc=$?
  for h in $want; do
    grep -q "statuses/$h.*state=error" "$d/calls" 2>/dev/null || missing+=" ${h:0:6}"
  done
  if [ -z "$missing" ] && [ "$rc" != 0 ]; then echo "  PASS  $name"; pass=$((pass+1))
  else echo "  FAIL  $name (rc=$rc, not marked:$missing)"; sed 's/^/          /' <<<"$out" | head -3; fail=$((fail+1)); fi
}
fb_case "pull_request_target: the event's own head" "EVENT=pull_request_target|PRT_HEAD_SHA=$H1" "$H1"
fb_case "issue_comment: the commented PR's head" "EVENT=issue_comment|ISSUE_NUMBER=42" "$H42"
fb_case "workflow_run from a fork: the run's head sha" "EVENT=workflow_run|RUN_HEAD_SHA=$HF" "$HF"
fb_case "workflow_run listing its PRs: their heads" \
  "EVENT=workflow_run|RUN_PRS=[{\"number\":3,\"head\":{\"sha\":\"$H2\"}}]" "$H2"
fb_case "workflow_dispatch for one PR: that PR's head" "EVENT=workflow_dispatch|INPUT_PR=42" "$H42"
fb_case "workflow_dispatch for every PR: every open head" "EVENT=workflow_dispatch" "$H1 $H2"
fb_case "schedule: every open head" "EVENT=schedule" "$H1 $H2"
fb_case "a delayed workflow_run: the payload head and the head it resolved" \
  "EVENT=workflow_run|RUN_HEAD_SHA=$HF|RESOLVED=[\"$H2\"]" "$HF $H2"

# The fallback must not add a status when the head already shows the same error: a failure that
# persists on the 10-minute sweep would otherwise exhaust GitHub's 1000 statuses per commit
# and context (PR #70's P2). Statuses come from fixtures; `fbs_case` has the poster checked out
# or, with CHECKOUT=0, not (the checkout is what failed).
FB_DESC="The gate could not resolve this event; see the run"
fbs_case() {  # $1 name, $2 current statuses JSON, $3 want POSTs, $4 checkout (1|0), $5 page 2
  local name=$1 statuses=$2 want=$3 checkout=${4:-1} page2=${5:-} d out rc posts
  ps_n=$((ps_n + 1)); d="$TMP/fbs.$ps_n"; mkdir "$d"
  printf '[{"head":{"sha":"%s"}}]' "$H1" > "$d/repos_o_r_pulls.json"
  printf '%s' "$statuses" > "$d/repos_o_r_commits_${H1}_statuses.json"
  [ -z "$page2" ] || printf '%s' "$page2" > "$d/repos_o_r_commits_${H1}_statuses.json.page2"
  if [ "$checkout" = 1 ]; then
    mkdir -p "$d/.claude/skills/pr-review-gate"; cp "$POSTER" "$d/.claude/skills/pr-review-gate/post-status.sh"
  fi
  out=$(cd "$d" && env PS_DIR="$d" PATH="$TMP/psbin:$PATH" GITHUB_REPOSITORY=o/r GITHUB_SERVER_URL=https://github.com \
        GITHUB_RUN_ID=5 STATUS_CONTEXT=review-gate RUN_URL=https://github.com/o/r/actions/runs/5 RUN_PRS='[]' RUN_HEAD_SHA= \
        INPUT_PR= PRT_HEAD_SHA= ISSUE_NUMBER= EVENT=schedule bash -c "$FB_RUN" 2>&1); rc=$?
  posts=$(grep -c . "$d/posts" 2>/dev/null || true)
  if [ "$rc" != 0 ] && [ "${posts:-0}" = "$want" ]; then echo "  PASS  $name"; pass=$((pass+1))
  else echo "  FAIL  $name (rc=$rc, posts=${posts:-0} want=$want)"; sed 's/^/          /' <<<"$out" | head -4; fail=$((fail+1)); fi
}
FB_ERR="[$(st error "$FB_DESC" 'github-actions[bot]' "$OURS_URL")]"
fbs_case "a repeated identical fallback error posts nothing" "$FB_ERR" 0
fbs_case "a repeated identical fallback error posts nothing without the checkout" "$FB_ERR" 0 0
fbs_case "the fallback error is posted over a success" "[$(st success 'CLEAR' 'github-actions[bot]' "$OURS_URL")]" 1
fbs_case "the fallback error is posted over a success without the checkout" "[$(st success 'CLEAR' 'github-actions[bot]' "$OURS_URL")]" 1 0
fbs_case "the fallback error is posted over a different error" "[$(st error 'The gate could not evaluate (exit 2)' 'github-actions[bot]' "$OURS_URL")]" 1
fbs_case "the fallback error is posted over a different error without the checkout" "[$(st error 'The gate could not evaluate (exit 2)' 'github-actions[bot]' "$OURS_URL")]" 1 0
fbs_case "the fallback error is posted when the head has no status" '[]' 1
# GitHub lists statuses newest first, 100 a page: other contexts' newer statuses can push this
# context's current one to page 2, and the change-only read must still find it.
OTHER_PAGE="[$(st success 'ci' 'github-actions[bot]' "$OURS_URL" | sed 's/"review-gate"/"ci"/')]"
fbs_case "an identical fallback error on page 2 posts nothing without the checkout" "$OTHER_PAGE" 0 0 "$FB_ERR"

# The verdict step without its checkout takes the same change-only rule (PR #70: "Deduplicate
# the evaluate checkout fallback"): both fallbacks call the one direct poster, the workflow's
# POST_ERROR_DIRECT, so a persistent checkout failure adds no status per run either.
FBP_DESC="The gate could not run (checkout failed); see the run"
fbp_case() {  # $1 name, $2 current statuses JSON, $3 want POSTs, $4 page 2
  local name=$1 statuses=$2 want=$3 page2=${4:-} d out rc posts
  ps_n=$((ps_n + 1)); d="$TMP/fbp.$ps_n"; mkdir "$d"
  printf '%s' "$statuses" > "$d/repos_o_r_commits_${H1}_statuses.json"
  [ -z "$page2" ] || printf '%s' "$page2" > "$d/repos_o_r_commits_${H1}_statuses.json.page2"
  out=$(cd "$d" && env PS_DIR="$d" PATH="$TMP/psbin:$PATH" GITHUB_REPOSITORY=o/r SHA="$H1" STATUS_CONTEXT=review-gate \
        RUN_URL="$OURS_URL" RC= EVAL_STARTED= PRS= GITHUB_EVENT_NAME=issue_comment bash -c "$POST_RUN" 2>&1); rc=$?
  posts=$(grep -c . "$d/posts" 2>/dev/null || true)
  if [ "$rc" != 0 ] && [ "${posts:-0}" = "$want" ]; then echo "  PASS  $name"; pass=$((pass+1))
  else echo "  FAIL  $name (rc=$rc, posts=${posts:-0} want=$want)"; sed 's/^/          /' <<<"$out" | head -4; fail=$((fail+1)); fi
}
fbp_case "the verdict step without its checkout posts nothing over the same error" \
  "[$(st error "$FBP_DESC" 'github-actions[bot]' "$OURS_URL")]" 0
fbp_case "the verdict step without its checkout posts error over a success" \
  "[$(st success 'CLEAR' 'github-actions[bot]' "$OURS_URL")]" 1
fbp_case "the verdict step without its checkout posts error when the head has no status" '[]' 1
fbp_case "the verdict step without its checkout finds the same error on page 2" "$OTHER_PAGE" 0 \
  "[$(st error "$FBP_DESC" 'github-actions[bot]' "$OURS_URL")]"
# One direct poster: outside post-status.sh, the only status POST in the workflow is the one
# in POST_ERROR_DIRECT, so a third fallback cannot skip the change-only rule.
direct_posts=$(grep -c -- '-X POST "repos/$GITHUB_REPOSITORY/statuses' "$WORKFLOWS_DIR/review-gate.yml" || true)
if [ "$direct_posts" = 1 ] && grep -q -- '-X POST "repos/$GITHUB_REPOSITORY/statuses' <<<"$POST_ERROR_DIRECT"; then
  echo "  PASS  the workflow's one direct status POST is POST_ERROR_DIRECT's"; pass=$((pass+1))
else
  echo "  FAIL  the workflow's one direct status POST is POST_ERROR_DIRECT's (found $direct_posts)"; fail=$((fail+1))
fi

# The invalidation step: a pending GitHub refuses must fail the step, so the failure step
# runs (PR #70: "Fail closed when the pending status is rejected").
d="$TMP/fb.inv"; mkdir -p "$d/.claude/skills/pr-review-gate"
printf '#!/bin/bash\necho "post $*" >> "%s/calls"; exit 1\n' "$d" > "$d/.claude/skills/pr-review-gate/post-status.sh"
out=$(cd "$d" && env SHAS="[\"$H1\"]" bash -c "$INV_RUN" 2>&1); rc=$?
if [ "$rc" != 0 ] && grep -q "post $H1 pending" "$d/calls"; then
  echo "  PASS  a refused pending fails the invalidation step"; pass=$((pass+1))
else
  echo "  FAIL  a refused pending fails the invalidation step (rc=$rc)"; sed 's/^/          /' <<<"$out" | head -3; fail=$((fail+1))
fi

# The verdict step when the checkout failed: post-status.sh is absent, and the step posts
# error itself.
d="$TMP/fb.post"; mkdir "$d"
out=$(cd "$d" && env FB_DIR="$d" PATH="$TMP/fbbin:$PATH" GITHUB_REPOSITORY=o/r SHA="$H1" STATUS_CONTEXT=review-gate \
      RUN_URL=u RC= EVAL_STARTED= PRS= GITHUB_EVENT_NAME=issue_comment bash -c "$POST_RUN" 2>&1); rc=$?
if grep -q "statuses/$H1.*state=error" "$d/calls" 2>/dev/null && [ "$rc" != 0 ]; then
  echo "  PASS  the verdict step without its checkout posts error and fails"; pass=$((pass+1))
else
  echo "  FAIL  the verdict step without its checkout posts error and fails (rc=$rc)"; sed 's/^/          /' <<<"$out" | head -3; fail=$((fail+1))
fi

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
