# Living with Published Libs: User Stories

The independently-published model: every lib is published, and apps consume only published
packages. Mechanics are in
[WORKSPACE-VS-SEMVER.md](WORKSPACE-VS-SEMVER.md), [ROLLOUT.md](ROLLOUT.md), and
[FEASIBILITY.md](FEASIBILITY.md). The publish and semver mechanics are measured on small AWS
CodeArtifact scaffolds; the shared-workspace costs they are contrasted with come from
[the workspace under test](README.md#the-workspace-under-test).
The cast: **Maya** (app dev, `checkout-app`); **Sam** (lib dev, `@acme/ui` → `@acme/core`);
**Priya** (platform).

---

**1. Adds a lib.** As an app dev I add the design system like any npm package: `pnpm add
@acme/ui` pins `ui@1.8.0` plus its declared `@acme/core@2.5.1`/`date-fns@4.1.7`; pnpm's
isolation blocks importing undeclared core (a "phantom dependency",
`bench/bun-safety-bench.json` rung D).

**2. Identical CI.** As an app dev, my build today matches yesterday's because my lockfile is
the freeze. A manifest edited without re-resolving fails the frozen install closed under all
five package managers measured, each sample in a fresh container
(`bench/container-install-bench.json`; 0.9–10.4s by tool on an empty cache).

**3. Upgrades on her terms.** As an app dev I take upgrades when I choose. Each is a lockfile
diff (`1.8.0 → 1.9.0`, `core 2.5.1 → 2.5.3` riding ui's `^2.5.0`); if it breaks, I stay on 1.8.0.

**4. Hits a lib bug.** As a blocked app dev I can't patch `dist/`. I wait for `1.9.1`, take
Sam's prerelease (story 6), or patch the tarball.

**5. Fixes against HEAD.** As a lib dev I get a fast local loop against core's HEAD source
(`workspace:^`, a link not a version), so bumping an in-house lib touches no lockfile
([WORKSPACE-VS-SEMVER.md §2](WORKSPACE-VS-SEMVER.md#2-workspacerange)).

**6. Ships the fix.** As a lib dev releasing is mechanical: pack rewrites `"workspace:^"` →
`"^2.5.0"` and `"catalog:"` → `"^4.1.0"`, so the artifact is plain semver (pnpm/bun/yarn:
`bench/wave-rollout-bench.json`, `bench/yarn-rollout-bench.json`).

**7. Ships a breaking change.** As a lib dev I let consumers migrate on their schedule via
`ui@2.0.0` (every app's `^1.8.0` excludes it); dependent libs each republish to declare
`^2.0.0`, a chain deepest-first ([ROLLOUT.md](ROLLOUT.md#two-rules-that-hold-on-any-tool)).

**8. Security bump as a campaign.** As a platform engineer I purge a transitive CVE: a
catalog bump edits 0 consumer manifests vs 25 per-app pins
(`bench/lockfile-merge-bench.json`), but frozen apps mean a PR per app
([WORKSPACE-VS-SEMVER.md §7](WORKSPACE-VS-SEMVER.md#7-per-app-workspaces), `make per-app`).

**9. Untangles a diamond.** As a platform engineer I collapse version splits: a
non-overlapping pair carries two core copies, and a root `overrides` pin **breaks the
dependent built against the other major** until rebuilt (`make diamond`,
[WORKSPACE-VS-SEMVER.md §3](WORKSPACE-VS-SEMVER.md#3-diamond-resolution-under-semver)
and [§4](WORKSPACE-VS-SEMVER.md#4-overriding-one-lib-to-workspace)).

**10. Co-develop for an afternoon.** As a pairing lib+app dev we run the app against ui's
HEAD by flipping `"^1.9.1"` → `"workspace:*"`, reverting before merge
([WORKSPACE-VS-SEMVER.md §4](WORKSPACE-VS-SEMVER.md#4-overriding-one-lib-to-workspace)).

**11. Team owns ui and an app.** As a team owning `@acme/ui` and `brand-portal` we keep the
app on ui's HEAD via `workspace:^` while others keep `"^1.9.0"`, so one lib is consumed both
ways at once
([§5](WORKSPACE-VS-SEMVER.md#5-switching-one-app-without-changing-the-others)). The payoff is a
permanent pre-merge canary. The cost is that the app can't lag and other teams still wait
([§7](WORKSPACE-VS-SEMVER.md#7-per-app-workspaces)).

**12. Publishes needing an unreleased core.** As a lib dev I want the pipeline to catch this
case. Core adds `formatPrice()` without a version bump; ui uses it and publishes `1.9.2`
declaring `"^2.5.0"`, but no published core has the function, so Maya's install breaks.
The fix is to bump on behavior change, publish deepest-first, and gate the **artifact**
([ROLLOUT.md](ROLLOUT.md#gating-the-artifact)).

---

## When `file:` Enters the Model

**13. Vendors a patched tarball.** As a blocked app dev I vendor
`"file:./vendor/acme-ui-1.9.0-safari-fix.tgz"`: lockfile-pinned, no registry. `file:` has no
semver, so I file a revert ticket.

**14. An unpublished helper lib.** As an app dev I factor helpers out via
`file:../checkout-helpers` (unpublished, riding the app's PRs). A second app in another repo
can't reproduce it; the choice is copy-paste drift or graduating it to `@acme/*`.

**15. `file:` postinstall rule.** As a platform engineer I rely on the default: pnpm 12 and
bun **block** a `file:` dep's `postinstall`, and pnpm 12 also fails the install on the blocked
build with `ERR_PNPM_IGNORED_BUILDS` (`bench/bun-safety-bench.json` rung A). A dep that needs
its script is allowlisted explicitly (`pnpm.onlyBuiltDependencies` / `trustedDependencies`).

---

## Summary

Maya changes by lockfile, Sam by release, Priya across both. The shared-workspace model
([README.md](README.md), [FEASIBILITY.md](FEASIBILITY.md)) inverts both pains: the lib dev
sees every app break before merge (whole-workspace gate 1.6s at 4,000 apps,
`bench/optimal-gate-bench.json`), and the app dev never waits. The cost is that everyone rides
HEAD.
