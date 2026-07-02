# Living with published libs: user stories

The independently-published model — every lib published to a registry, apps consuming
only published packages — told as the day-to-day experience of three people. The
mechanics behind each story are measured in this repo:
[WORKSPACE-VS-SEMVER.md](WORKSPACE-VS-SEMVER.md) (resolution, overrides, diamonds, the
publish rewrite), [ROLLOUT.md](ROLLOUT.md) (advancing a lib through waves),
[FEASIBILITY.md](FEASIBILITY.md) (when to pick this model at all). Registry:
AWS CodeArtifact, the same one the demos publish to.

The cast: **Maya** — app developer, owns `checkout-app`. **Sam** — lib developer, owns
`@acme/ui`, which depends on `@acme/core`. **Priya** — platform engineer, owns the seams.

---

## 1. Maya adds a lib to her app

> As an app developer, I want to use the design system, so I add it like any npm package.

Maya runs `pnpm add @acme/ui`. Her `package.json` gains `"@acme/ui": "^1.8.0"`; her
app's lockfile gains pinned entries for `ui@1.8.0` and — automatically, because ui's
published manifest declares them — `@acme/core@2.5.1` and `date-fns@4.1.7`. She never
declared core; she may not know it exists. Her editor autocompletes from
`node_modules/@acme/ui/dist/index.d.ts`. CodeArtifact is just "the registry" to her.
(Under pnpm's isolated layout she also *cannot* silently `import "@acme/core"` without
declaring it — the phantom-dependency protection measured in
`bench/bun-safety-bench.json` rung D.)

## 2. Maya's CI is boring, every single day

> As an app developer, I want today's build to be identical to yesterday's, so nothing
> surprises me under deadline.

Sam merged eleven PRs to ui this week. Maya's CI ran fifty times. Every run did a frozen
install and got byte-identical `ui@1.8.0`, because her **lockfile is the freeze** —
publishes move the registry, never her app. If a manifest is edited without
re-resolving, the frozen install fails closed instead of silently drifting — measured
for all five package managers, each in a fresh container
(`bench/container-install-bench.json`; the install itself is 0.9–10.4s depending on the
tool).

## 3. Maya upgrades, on her own terms

> As an app developer, I want to take lib upgrades when I choose, so upgrades are
> scheduled work, not ambushes.

Release notes announce `ui@1.9.0`. Maya runs `pnpm up @acme/ui`, and the *entire*
upgrade is a lockfile diff in her PR: `1.8.0 → 1.9.0`, plus `core 2.5.1 → 2.5.3` riding
along inside ui's `^2.5.0` range. Her tests run against the new resolution before merge.
If it breaks her layout tests, she closes the PR and stays on 1.8.0 — nobody else is
affected either way.

## 4. Maya hits a lib bug and feels the model's one real pain

> As an app developer blocked by a lib bug, I want a fix now, but I can't edit the lib
> in place.

The tooltip in `ui@1.9.0` crashes on Safari. The code is in `dist/` — compiled, not hers
to patch. Her options, in order: file the issue and wait for `1.9.1`; take Sam's
prerelease (story 6); or bridge the gap with a local override/patch on the tarball. The
wait is the tax she pays for stories 2 and 3.

## 5. Sam fixes the bug against HEAD, without touching any app

> As a lib developer, I want a fast local loop, so I fix and test inside my own tree.

Sam works in `packages/ui/`: edits source, unit tests in watch mode. His internal dep on
core is `"@acme/core": "workspace:^"`, so he develops against core's **HEAD source**,
not a published artifact. When core's owner bumped versions yesterday, the workspace
lockfile did not change — the lockfile records a `workspace:` dep as a link to the
sibling directory, not as a resolved version, so an internal rev needs no install and
touches no lockfile ([WORKSPACE-VS-SEMVER.md](WORKSPACE-VS-SEMVER.md) §2). No app
anywhere noticed Sam's commits. That is the point —
and also his blind spot: no app breakage shows on his screen.

## 6. Sam ships the fix

> As a lib developer, I want releasing to be mechanical, so publishing is a ceremony I
> can't get wrong.

Sam merges, bumps ui to `1.9.1`, builds `dist/`, publishes. At pack time his manifest is
rewritten automatically: `"@acme/core": "workspace:^"` becomes `"@acme/core": "^2.5.0"`,
`"date-fns": "catalog:"` becomes `"^4.1.0"` — the published artifact is an ordinary npm
package with plain semver, and Sam never hand-wrote a cross-version number (the rewrite
is measured for pnpm, bun, and yarn: `bench/wave-rollout-bench.json`,
`bench/yarn-rollout-bench.json`; the spec-form table is in
[WORKSPACE-VS-SEMVER.md](WORKSPACE-VS-SEMVER.md) §2). For Maya it appears as an optional
one-line lockfile bump. For the nervous case, Sam first published `1.9.1-next.0` and one
friendly app pointed at it for a day — the prerelease lane.

## 7. Sam ships a breaking change and learns what "major" costs

> As a lib developer making a breaking change, I want consumers to migrate on their own
> schedule, so I publish a major instead of breaking HEAD.

Sam's new theming API is `ui@2.0.0`. Nothing migrates automatically: every app's
`^1.8.0` range *excludes* 2.0.0 by design. Apps move one PR at a time over a quarter, so
Sam maintains `1.x` and `2.x` side by side, backporting fixes. And since other libs
depend on ui with baked ranges like `^1.8.0`, each of *those* needs a republish to
declare `^2.0.0` — the topological republish fanout
([ROLLOUT.md](ROLLOUT.md): the direct-clean vs universal-fanout distinction). Sam now
understands why Priya keeps asking him to make changes additive
(expand/migrate/contract).

## 8. Priya runs a security bump as a campaign

> As a platform engineer, I want a vulnerable transitive dep purged everywhere, so I
> coordinate across every lockfile that pins it.

CVE in `date-fns@4.1.7`. In a shared workspace that is one catalog line + one re-resolve
(measured: a catalog bump edits 0 consumer manifests vs 25 for per-app pins,
`bench/lockfile-merge-bench.json`). But apps freeze their own resolutions, so Priya's
bot opens a lockfile-refresh PR **per app**, and she tracks the stragglers. "Which
version is prod on?" genuinely has several answers until the campaign closes — the flip
side of Maya's calm. (Per-app divergence, including transitive divergence, is
demonstrated live on CodeArtifact: `make per-app`,
[WORKSPACE-VS-SEMVER.md](WORKSPACE-VS-SEMVER.md) §7.)

## 9. Priya untangles a diamond

> As a platform engineer, I want one copy of core at runtime, so I collapse version
> splits deliberately.

`checkout-app` depends on `ui` (wants `core ^2.5.0`) and `auth` (an older build wanting
`core ^2.3.0`). The ranges overlap, so the resolver dedupes to one copy — fine. When a
stubborn pair doesn't overlap, the app carries two copies of core, and Priya has a real
decision: leave the duplicate (safe, heavier), or add a root `overrides` entry pinning
one version for the whole app — knowing the collapse **breaks the dependent that was
built against the other major** until that dependent is rebuilt against the pinned one
(both outcomes demonstrated live against CodeArtifact: `make diamond`,
[WORKSPACE-VS-SEMVER.md](WORKSPACE-VS-SEMVER.md) §3–4). The override is a migration
step, not a fix.

## 10. Sam and Maya co-develop for one afternoon

> As a lib and app developer pairing on a feature, we want the app running against the
> lib's HEAD, so we skip the publish cycle temporarily.

For one afternoon, Maya's app flips `"@acme/ui": "^1.9.1"` to `"@acme/ui": "workspace:*"`
(or a root override). Her app now links Sam's working tree — and since apps consume the
lib's built `dist`, Sam keeps `tsc --watch` running so every save rebuilds and shows up
on her screen. Before merging, the override is reverted, Sam publishes properly, Maya bumps her
lockfile. The escape hatch exists so the publish ceremony never has to be the debugging
loop ([WORKSPACE-VS-SEMVER.md](WORKSPACE-VS-SEMVER.md) §4–5: overriding one lib, and
switching one app without changing the others).

---

## When `file:` enters the model

Some teams in this model also carry `file:` dependencies — a path or tarball on disk
instead of a registry package. Three stories about where that helps and where it bites.

## 11. Maya vendors a patched tarball to stop waiting

> As an app developer blocked on a lib fix (story 4), I want the fix today, so I vendor
> a patched build until the real release lands.

Sam's Safari fix exists on a branch but `1.9.1` is days away. Maya builds the tarball
from Sam's branch and commits it to her app:
`"@acme/ui": "file:./vendor/acme-ui-1.9.0-safari-fix.tgz"`. Her lockfile now pins the
tarball, CI installs it from the repo checkout — deterministic, no registry involved.
The discipline that has to come with it: a `file:` dep has no semver, so nothing will
ever tell her an upgrade exists. She files a ticket to revert to `"^1.9.1"` the day it
ships; vendored tarballs without a removal ticket fossilize.

## 12. A helper lib that never gets published

> As an app developer with app-private helpers, I want to factor code out without
> adopting the whole publish ceremony, so I keep an unpublished lib next to the app.

`checkout-app` grows a `file:../checkout-helpers` dep — a real package with its own
`package.json`, living in the app's repo, never published. No version, no registry, no
release notes: changes ride the app's own commits and PRs, and the app's lockfile just
records the path. It is the halfway house between "a folder of utils" and "a published
lib" — and it has a sharp boundary: the moment a **second** app in another repo wants
those helpers, a `file:` path stops being reproducible — it can technically point at a
sibling checkout, but every consumer's CI would have to materialize that other repo at
the same relative path. The real choices are copy-paste drift or graduating the helpers
to a published `@acme/*` package (story 6's ceremony, applied).

## 13. Priya's onboarding rule about `file:` postinstalls

> As a platform engineer, I want no surprise script execution from local deps, so I
> rely on the measured default and say so in onboarding docs.

A vendored `file:` dep can carry a `postinstall` script. Both pnpm 10 and bun **block
it by default** — the install completes and the script does not run: pnpm reports the
blocked package by name ("Ignored build scripts"), bun reports a count and where to look
(`Blocked 1 postinstall. Run bun pm untrusted...`) — measured on a local `file:` dep's
postinstall, `bench/bun-safety-bench.json` rung A. So Priya's rule is one line: if a
vendored dep genuinely needs its postinstall, allowlist it explicitly
(`pnpm.onlyBuiltDependencies` / bun's `trustedDependencies`); otherwise the silence is
the security default working, not a broken install.

---

## The through-line

**Maya's world is her lockfile** — nothing changes until she changes it. **Sam's world
is his release** — nothing he does exists for others until published. **Priya's world is
the seams** — the fanouts, campaigns, and diamonds that stitching many frozen worlds
together creates.

The shared-workspace model ([README](README.md), [FEASIBILITY.md](FEASIBILITY.md))
exists to flip the two pains: the lib dev sees every app break *before* merge (the
whole-workspace gate is 1.3s at 4,000 apps, `bench/optimal-gate-bench.json`), and the
app dev never waits on a release — at the cost that everyone rides HEAD. Choose by which
pain your organization prefers; [FEASIBILITY.md](FEASIBILITY.md)'s decision table is the
measured basis.
