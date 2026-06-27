# OPTIMAL-STACK.md — bun + tsgo + oxlint + turbo at 4,000 apps / 400 libs

Source of record: `bench/optimal-gate-bench.json` (run at 4000:400), `bench/env.json`.
Reproduce: `node scripts/optimal-gate-bench.mjs 4000:400` (in a dedicated git worktree —
the bench overwrites the root `package.json` and regenerates the tree, so it refuses to
run in the primary tree).

One native-compiled tool per job — no slower baseline in the measured loop:

| job                 | tool                                    | version              |
| ------------------- | --------------------------------------- | -------------------- |
| install             | **bun**                                 | 1.3.14               |
| typecheck / gate    | **tsgo** (`@typescript/native-preview`) | 7.0.0-dev.20260614.1 |
| lint                | **oxlint** (oxc)                        | 1.71.0               |
| orchestrate + scope | **turbo**                               | 2.9.18               |

## The scenario

A library owner owns a foundation lib that **every** app imports (`@demo/lib-001`,
generated with `--universal 1` so it is a pure-sink tier every app and every other lib
depends on). At 4,000 apps / 400 libs the daily question is: rev that lib, and catch a
breaking type error in any of the 4,000 apps before it merges — fast.

## Install the workspace — bun, 20.9s

`bun install` materializes the 4,400-package workspace (4,000 apps + 400 libs; 76 unique
external deps, the rest workspace symlinks) in **20.9s** — warm store, `node_modules`
cold, the steady-state clone/CI case. This is a one-time setup cost; revving a lib edits
source and needs no reinstall. For contrast, pnpm's cold-resolve (no lockfile) is 233s at
1,000:200 (`bench/install-modes-bench.json`) — about a quarter the apps and already
minutes.

## The optimal type-error gate — one tsgo program over the whole workspace, 1.32s

For a **universal** rev every app must re-check, so there is nothing to scope away. The
fastest gate is then a single tsgo process over the whole workspace, reading lib **source**
directly (`tsgo --noEmit -p tsconfig.whole.json`, with `@demo/*` resolved to
`packages/*/src/index.ts`). One process parses each lib's source **once** and shares it
across every importing app, and skips the per-lib dist builds entirely.

At 4,000:400 it typechecks the whole tree in **1.32s**, peak RSS **911MB** (one process —
the tradeoff is memory, trivial against the 135GB box). It is typecheck-only: it emits no
`dist`. The timed number follows a throwaway warmup run that absorbs tsgo's binary load and
first-touch fs caching.

## Catching a breaking change — every dependent app, 1.39s

A breaking foundation signature (a new required parameter) turns **every** dependent app
red: **4,000 of 4,000 apps** report `error TS2554: Expected 2 arguments, but got 1`
(4,399 TS2554 in all — 4,000 apps + 399 dependent libs), in **1.39s**. The bench asserts
the catch is exactly this — `appsWithErrors === 4000` and a `TS2554` sample — so a gate
that went red for any other reason fails the run. This is "catch a type error in one of
the 4,000 apps before it ships," in under a second and a half.

## Context — turbo build+tsgo, 80.1s (not like-for-like)

The orchestrated path, `turbo run typecheck:tsgo --filter=...@demo/lib-001`, runs one tsgo
per package against built `dist` (per-package caching + graph scoping): **4,800 of 4,800
tasks** (4,400 `typecheck:tsgo` + 400 lib builds) cold in **80.1s**. It is **not**
like-for-like with the one-program gate — it also emits every lib's `dist` (tsc `^build`),
which a deploy needs and the type-error gate does not. For a universal rev there is no
scope to exploit, so the one-program gate is ~60× faster (1.32s vs 80.1s); turbo's value
here is the dist artifacts and the per-package cache on the *next* run, not the cold gate
time.

## Scope a non-universal rev — leaf, O(closure), 22.4s

When the revved lib is **not** universal, scoping is the win. The same turbo command on a
leaf lib (`...@demo/lib-400`, imported by ~1% of apps) runs only **237 of 4,800 tasks** in
**22.4s** — the graph tracks that one lib's closure, not the repo. The rule: a universal
rev → one tsgo program; a scoped rev → `turbo --filter=...<lib>` (or `--affected`).

## Lint — oxlint, 180ms

oxlint (native Rust) checks the whole 4,400-package source tree in **180ms** (0 findings)
— not on the critical path.

## What's wired, and the rough edges

- The one-program gate is typecheck-only — it reads lib **source** (`paths`→`src`), so it
  needs no build and emits nothing. If you also need `dist` (for deploy), that is a
  separate build; the turbo path produces it as part of its 80.1s.
- tsgo (TS7) is stricter than tsc about module-resolution config (it rejects `baseUrl` and
  non-relative `paths`); `tsconfig.whole.json` resolves `@demo/*` to `packages/*/src` and
  sets `declaration:false` (the base config's `declaration:true` would otherwise flag JSX
  component return types as non-portable, TS2883, under `--noEmit`).
- bun ignores pnpm `catalog:` catalogs, so the bench resolves them to concrete versions
  before installing (`workspace:*` specs are left intact — bun understands those). bun's
  own catalog format is the catalog-preserving option, not exercised here.
- In the turbo path lib `dist` is emitted by **tsc** via `^build` (tsgo emit is not wired —
  tsgo is a preview build).
