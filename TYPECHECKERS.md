# Faster type-checking

Each package runs `tsc --noEmit`, fanned out and cached by Turborepo. Whole-repo type-checking is O(repo), so the first lever is checking less (`turbo --affected`); the second is making each check cheaper.

## Measured: tsc vs tsgo

`scripts/typecheck-bench.mjs` generates N cross-referencing modules in one program and times `--noEmit` for tsc and for tsgo (the TypeScript native Go port, shipped as `@typescript/native-preview`).

| modules | tsc | tsgo | speedup |
|---|---|---|---|
| 3,000 | 3,116ms | 257ms | 12.1x |

Consistent with Microsoft's ~10x claim. tsgo is a drop-in `tsgo --noEmit` and fits the existing per-package Turborepo task.

Caveat: as of 2026-06 tsgo is beta (only `7.0.0-dev.*` nightlies, no GA). TypeScript 7.0 removes `baseUrl`, `moduleResolution: node10`, and `target: es5`, and has no compiler/LSP plugin API yet. Pin a nightly and keep tsc as a CI fallback.

## Ranked levers

1. tsgo (`@typescript/native-preview`): ~10x per check, drop-in. Beta, so pin a nightly and keep a fallback.
2. Cheap, stable config: `skipLibCheck: true`; `incremental: true` with an explicit `tsBuildInfoFile` added to Turborepo `outputs`; `"types": []` then list only what each package needs; `turbo --affected` so CI checks changed packages only.
3. Do not adopt TypeScript project references with Turborepo. Turborepo recommends against them (a second config plus a second cache layer), and `composite` forces `.d.ts` emit on every package, making each task heavier than `--noEmit`.

Honorable mention: `isolatedDeclarations` (TS 5.5) enables parallel `.d.ts` emit. Relevant only where declarations are emitted (the library builds here do; the app `--noEmit` checks do not).

Not type checkers: swc, esbuild, oxc, and Biome transpile or lint; they do not do semantic type-checking. stc is archived; ezno is experimental. tsc and tsgo are the complete options.

Sources: [TypeScript native port](https://devblogs.microsoft.com/typescript/typescript-native-port/), [TS 7 beta](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0-beta/), [Turborepo TS guide](https://turborepo.dev/docs/guides/tools/typescript), [Performance wiki](https://github.com/microsoft/TypeScript/wiki/Performance).
