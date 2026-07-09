# Living with Published Libs: User Stories

The independently-published model (every lib published to a registry, apps consuming
only published packages), told as the day-to-day experience of the people living in it.
The mechanics behind each story are measured or demonstrated live in this repo:
[WORKSPACE-VS-SEMVER.md](WORKSPACE-VS-SEMVER.md) (resolution, overrides, diamonds, the
publish rewrite), [ROLLOUT.md](ROLLOUT.md) (advancing a lib through waves),
[FEASIBILITY.md](FEASIBILITY.md) (when to pick this model at all). Registry:
AWS CodeArtifact, the same one the demos publish to.

The cast: **Maya** (app developer) owns `checkout-app`; **Sam** (lib developer) owns
`@acme/ui`, which depends on `@acme/core`; **Priya** (platform engineer) owns the shared
infrastructure.

---

## 1. Maya Adds a Lib to Her App

> As an app developer, I want to use the design system, so I add it like any npm package.

Maya runs `pnpm add @acme/ui`. Her `package.json` gains `"@acme/ui": "^1.8.0"`; her
app's lockfile gains pinned entries for `ui@1.8.0` and (automatically, because ui's
published manifest declares them) `@acme/core@2.5.1` and `date-fns@4.1.7`. She never
declared core; she may not know it exists. Her editor autocompletes from
`node_modules/@acme/ui/dist/index.d.ts`. CodeArtifact is "the registry" to her, nothing
more. (Under pnpm's isolated layout she also *cannot* silently `import "@acme/core"`
without declaring it: importing a package you never declared is the "phantom dependency"
mistake, and the layout makes it fail immediately instead of working by accident;
measured in `bench/bun-safety-bench.json` rung D.)

## 2. Maya's CI Is Identical Every Day

> As an app developer, I want today's build to be identical to yesterday's, so nothing
> surprises me under deadline.

Sam merged 11 PRs to ui this week. Maya's CI ran 50 times. Every run did a frozen
install and got byte-identical `ui@1.8.0`, because her **lockfile is the freeze**:
publishes move the registry, never her app. If a manifest is edited without
re-resolving, the frozen install fails closed instead of silently drifting; this is
measured for all five package managers, each in a fresh container
(`bench/container-install-bench.json`; the install itself is 0.9–10.4s depending on the
tool).

## 3. Maya Upgrades on Her Own Terms

> As an app developer, I want to take lib upgrades when I choose, so upgrades are
> scheduled work, not surprises.

Release notes announce `ui@1.9.0`. Maya runs `pnpm up @acme/ui`, and the *entire*
upgrade is a lockfile diff in her PR: `1.8.0 → 1.9.0`, plus `core 2.5.1 → 2.5.3` riding
along inside ui's `^2.5.0` range. Her tests run against the new resolution before merge.
If it breaks her layout tests, she closes the PR and stays on 1.8.0; nobody else is
affected either way.

## 4. Maya Hits a Lib Bug

> As an app developer blocked by a lib bug, I want a fix now, but I can't edit the lib
> in place.

The tooltip in `ui@1.9.0` crashes on Safari. The code is in `dist/`: compiled, not hers
to patch. Her options, in order: file the issue and wait for `1.9.1`; take Sam's
prerelease (story 6); or bridge the gap with a local override/patch on the tarball. The
wait is the tax she pays for stories 2 and 3.

## 5. Sam Fixes the Bug Against HEAD

> As a lib developer, I want a fast local loop, so I fix and test inside my own tree.

Sam works in `packages/ui/`: edits source, unit tests in watch mode. His internal dep on
core is `"@acme/core": "workspace:^"`, so he develops against core's **HEAD source**,
not a published artifact. When core's owner bumped versions yesterday, the workspace
lockfile did not change: the lockfile records a `workspace:` dep as a link to the
sibling directory, not as a resolved version, so bumping an in-house lib's version needs
no install and touches no lockfile
([WORKSPACE-VS-SEMVER.md §2](WORKSPACE-VS-SEMVER.md#2-workspacerange)). No app anywhere
noticed Sam's commits, so no app breakage shows on his screen.

## 6. Sam Ships the Fix

> As a lib developer, I want releasing to be mechanical, so publishing is a ceremony I
> can't get wrong.

Sam merges, bumps ui to `1.9.1`, builds `dist/`, publishes. At pack time his manifest is
rewritten automatically: `"@acme/core": "workspace:^"` becomes `"@acme/core": "^2.5.0"`,
and `"date-fns": "catalog:"` becomes `"^4.1.0"`. The published artifact is an ordinary
npm package with plain semver, and Sam never hand-wrote a cross-version number (the
rewrite is measured for pnpm, bun, and yarn: `bench/wave-rollout-bench.json`,
`bench/yarn-rollout-bench.json`; the spec-form table is in
[WORKSPACE-VS-SEMVER.md §2](WORKSPACE-VS-SEMVER.md#2-workspacerange)). For Maya it
appears as an optional one-line lockfile bump. For a cautious release, Sam first
published `1.9.1-next.0` and one friendly app pointed at it for a day: the prerelease
lane.

## 7. Sam Ships a Breaking Change

> As a lib developer making a breaking change, I want consumers to migrate on their own
> schedule, so I publish a major instead of breaking HEAD.

Sam's new theming API is `ui@2.0.0`. Nothing migrates automatically: every app's
`^1.8.0` range *excludes* 2.0.0 by design. Apps move one PR at a time over a quarter, so
Sam maintains `1.x` and `2.x` side by side, backporting fixes. And since other libs
depend on ui with baked ranges like `^1.8.0`, each of *those* needs a republish to
declare `^2.0.0`: a chain of re-releases in dependency order, deepest lib first (the
republish fanout; [ROLLOUT.md](ROLLOUT.md#two-rules-that-hold-on-any-tool) explains when
a rev is one catalog line vs a dependent-republish chain). Sam now understands why Priya
keeps asking him to make changes additive:
ship the new API next to the old, move consumers over, then delete the old
(expand/migrate/contract).

## 8. Priya Runs a Security Bump as a Campaign

> As a platform engineer, I want a vulnerable transitive dep (one apps get through
> other deps, not by asking) purged everywhere, so I coordinate across every lockfile
> that pins it.

CVE in `date-fns@4.1.7`. In a shared workspace that is one catalog line + one re-resolve
(measured: a catalog bump edits 0 consumer manifests vs 25 for per-app pins,
`bench/lockfile-merge-bench.json`). But apps freeze their own resolutions, so Priya's
bot opens a lockfile-refresh PR **per app**, and she tracks the stragglers. "Which
version is prod on?" genuinely has several answers until the campaign closes: the flip
side of Maya's calm. (Per-app divergence, including transitive divergence, is
demonstrated live on CodeArtifact: `make per-app`,
[WORKSPACE-VS-SEMVER.md §7](WORKSPACE-VS-SEMVER.md#7-per-app-workspaces).)

## 9. Priya Untangles a Diamond

> As a platform engineer, I want one copy of core at runtime, so I collapse version
> splits deliberately.

`checkout-app` depends on `ui` (wants `core ^2.5.0`) and `auth` (an older build wanting
`core ^2.3.0`). The ranges overlap, so the resolver dedupes to one copy, which is fine.
When a stubborn pair doesn't overlap, the app carries two copies of core, and Priya has
a real decision: leave the duplicate (safe, heavier), or add a root `overrides` entry
pinning one version for the whole app, knowing the collapse **breaks the dependent that
was built against the other major** until that dependent is rebuilt against the pinned
one (both outcomes demonstrated live against CodeArtifact: `make diamond`,
[WORKSPACE-VS-SEMVER.md §3](WORKSPACE-VS-SEMVER.md#3-diamond-resolution-under-semver)
and [§4](WORKSPACE-VS-SEMVER.md#4-overriding-one-lib-to-workspace)). The override is a
migration step, not a fix.

## 10. Sam and Maya Co-Develop for One Afternoon

> As a lib and app developer pairing on a feature, we want the app running against the
> lib's HEAD, so we skip the publish cycle temporarily.

For one afternoon, Maya's app flips `"@acme/ui": "^1.9.1"` to `"@acme/ui": "workspace:*"`
(or a root override). Her app now links Sam's working tree, and since apps consume the
lib's built `dist`, Sam keeps `tsc --watch` running so every save rebuilds and shows up
on her screen. Before merging, the override is reverted, Sam publishes properly, Maya bumps her
lockfile. The escape hatch exists so the publish ceremony never has to be the debugging
loop ([WORKSPACE-VS-SEMVER.md §4](WORKSPACE-VS-SEMVER.md#4-overriding-one-lib-to-workspace)
and [§5](WORKSPACE-VS-SEMVER.md#5-switching-one-app-without-changing-the-others):
overriding one lib, and switching one app without changing the others).

## 11. Sam's Team Owns ui and an App

> As a team that builds both the design system and its flagship app, we want the app on
> the lib's HEAD permanently, so a publish cycle is never between us and our own code.

Sam's team ships `@acme/ui` and also owns `brand-portal`, the app that exercises every
component. Waiting for their own publish cycle to see their own change
would be absurd, so both live in the team's workspace and the app declares the dep
permanently as `"@acme/ui": "workspace:^"`: resolution comes from the sibling source at
HEAD, with no publish involved. Everyone else's app keeps `"^1.9.0"` from the registry:
**the same lib lives both lives at once**, and switching one consumer to `workspace:`
changes nothing for the others (demonstrated:
[WORKSPACE-VS-SEMVER.md §5](WORKSPACE-VS-SEMVER.md#5-switching-one-app-without-changing-the-others);
the resolution rule is [§1](WORKSPACE-VS-SEMVER.md#1-the-gate-link-workspace-packages)'s
table: only the `workspace:` protocol forces the local link).

The team gets a permanent canary: a breaking change in ui shows up in `brand-portal`'s
typecheck *before Sam's PR merges*, the pre-merge gate the published
model lacks (story 5's blind spot, closed for this one consumer). Sam
refactors component internals and fixes the app in the same commit, atomically.

Transitively the arrangement compounds. ui's own `"@acme/core": "workspace:^"` resolves
as a workspace link too, so the app rides HEAD of every in-house lib underneath ui, all
the way down, and the canary widens with it: a breaking change in core turns
`brand-portal` red before *core's* PR merges, where the registry world would need two
releases in dependency order (story 7's fanout) to even deliver it. Third-party deps
compound the same way: the shared workspace lockfile means the app runs *exactly* the
`date-fns` ui's own tests ran against. The gap registry consumers live with (lib tested
at one resolution, consumer running another) cannot form here, and neither can story
9's diamonds (one lockfile + the catalog = one version everywhere). Linked is still not
importable: the app cannot `import "@acme/core"` without declaring it, even with core
fully resolved in the tree for ui (workspace phantom imports fail on pnpm and bun alike,
`bench/bun-safety-bench.json` rung D).

The team gives up the ability to lag: `brand-portal` has no version of its own lib to
stay on; it rides HEAD or the dep leaves the workspace. Its
reproducibility for ui comes from the git SHA plus a build, not from a lockfile pin (the
lockfile records a link, story 5), so the app's CI always builds ui from source. And the
no-wait privilege stops at the workspace boundary: every *other* team still waits for
Sam's publish (stories 3 and 4); this story removes the ceremony only between a team
and its own code. The same is true transitively: the app cannot take new ui while
lagging core, and cannot hold any transitive at a version the workspace didn't choose.
Per-app transitive divergence is exactly the capability that requires a separate
workspace and lockfile
([WORKSPACE-VS-SEMVER.md §7](WORKSPACE-VS-SEMVER.md#7-per-app-workspaces)). Transitive
freedom and the no-wait property are the same tradeoff: taking one gives up the other.

## 12. Sam Publishes an Artifact That Needs an Unreleased Core

> As a lib developer whose lib absorbed a neighbor's unreleased change, I want the
> pipeline to catch it, because everything on my screen says it's fine.

core merges a new `formatPrice()` helper; nobody bumps core's version. Sam's ui starts
using it the same day: the workspace always compiles against core's newest source, so
everything is green everywhere Sam can see. Then ui publishes `1.9.2`. The pack rewrite
snapshots core's version *number*, still 2.5.0, so the artifact declares
`"@acme/core": "^2.5.0"` but requires a function no published core has. Maya installs
ui 1.9.2, gets published core 2.5.1, and her build breaks on code Sam has never seen
fail. The workspace stays green while the published artifact is broken.

Three habits close the trap
([Rollback and Publish Order](ROLLOUT.md#rollback-and-publish-order) and
[Gating the Artifact](ROLLOUT.md#gating-the-artifact)): bump a lib's version when its
behavior changes (the step release tooling like Changesets automates; ordering is
meaningless if there is nothing new to publish); publish interdependent libs
deepest-first, so core 2.6.0 exists in the registry before any ui that needs it; and
[gate the **artifact**](ROLLOUT.md#gating-the-artifact): a pre-publish check that
resolves ui against its *installed published* dependencies goes red exactly where Sam's
workspace stayed green.

---

## When `file:` Enters the Model

Some teams in this model also carry `file:` dependencies: a path or tarball on disk
instead of a registry package. Three stories about where that helps and where it causes
problems.

## 13. Maya Vendors a Patched Tarball

> As an app developer blocked on a lib fix (story 4), I want the fix today, so I vendor
> a patched build until the real release lands.

Sam's Safari fix exists on a branch but `1.9.1` is days away. Maya builds the tarball
from Sam's branch and commits it to her app:
`"@acme/ui": "file:./vendor/acme-ui-1.9.0-safari-fix.tgz"`. Her lockfile now pins the
tarball, and CI installs it from the repo checkout: deterministic, with no registry
involved. The discipline that has to come with it: a `file:` dep has no semver, so
nothing will ever tell her an upgrade exists. She files a ticket to revert to `"^1.9.1"`
the day it ships; vendored tarballs without a removal ticket never get removed.

## 14. A Helper Lib That Never Gets Published

> As an app developer with app-private helpers, I want to factor code out without
> adopting the whole publish ceremony, so I keep an unpublished lib next to the app.

`checkout-app` grows a `file:../checkout-helpers` dep: a real package with its own
`package.json`, living in the app's repo, never published. There is no version or
registry involved: changes ride the app's own commits and PRs, and the lockfile records
the path. It is the halfway house between "a folder of utils" and "a published lib",
and it has a hard boundary: the moment a **second** app in another repo wants those
helpers, a `file:` path stops being reproducible. It can technically point at a sibling
checkout, but every consumer's CI would have to materialize that other repo at the same
relative path. The real choices are copy-paste drift or graduating the helpers to a
published `@acme/*` package (story 6's ceremony, applied).

## 15. Priya's Onboarding Rule About `file:` Postinstalls

> As a platform engineer, I want no surprise script execution from local deps, so I
> rely on the measured default and say so in onboarding docs.

A vendored `file:` dep can carry a `postinstall` script. Both pnpm 10 and bun **block
it by default**: the install completes and the script does not run. pnpm reports the
blocked package by name ("Ignored build scripts"); bun reports a count and where to look
(`Blocked 1 postinstall. Run bun pm untrusted...`). Measured on a local `file:` dep's
postinstall, `bench/bun-safety-bench.json` rung A. So Priya's rule is one line: if a
vendored dep genuinely needs its postinstall, allowlist it explicitly
(`pnpm.onlyBuiltDependencies` / bun's `trustedDependencies`); otherwise the silence is
the security default working.

---

## Summary

Maya's unit of change is her lockfile: nothing changes until she changes it. Sam's is
his release: his work reaches others only when published. Priya works across both,
handling the fanouts, campaigns, and diamonds that many frozen worlds create.

The shared-workspace model ([README.md](README.md), [FEASIBILITY.md](FEASIBILITY.md))
exists to flip the two pains: the lib dev sees every app break *before* merge (the
whole-workspace gate is 1.3s at 4,000 apps, `bench/optimal-gate-bench.json`), and the
app dev never waits on a release, at the cost that everyone rides HEAD. Choose by which
pain your organization prefers; [FEASIBILITY.md](FEASIBILITY.md)'s decision table is the
measured basis.
