// The pinned package-manager toolchain every install bench measures. One source of
// truth: install-bench.mjs and container-install-bench.mjs both import these, so the
// two datasets cannot silently describe different stacks.
export const PNPM_VERSION = "12.8.1"; // the Rust CLI (pnpm 12), pinned since 2026-09-30
// The JS implementation this repo previously pinned (pnpm 11 remains the maintained
// TS line upstream), kept as pnpm12-bench's baseline leg — the rewrite comparison
// needs a stable JS anchor after the main pin moved to 12.
export const PNPM10_VERSION = "10.29.1";
export const BUN_VERSION = "1.3.14";
// yarn 4.17.0's builtin PnP typescript compat patch cannot patch the native
// typescript@7 (it lstat's lib/_tsc.js, which TS7 does not ship), so a PnP install
// with typescript@7 fails there; 4.18.1 installs it. pnp-compat-bench measures both
// sides (its yarnTypescriptPatch control).
export const YARN_VERSION = "4.18.1";
// The yarn release pnp-compat-bench's negative control installs with: the last one
// whose builtin typescript patch fails on typescript@7.
export const YARN_PRE_TS7_PATCH_VERSION = "4.17.0";
// The older node the Next-under-PnP benches re-run their PnP trees under (the
// control that scopes the PnP config-load crash to the node version). Tarballs are
// fetched from nodejs.org and verified against these SHA-256 digests (from that
// release's SHASUMS256.txt) before anything is executed.
export const CONTROL_NODE = {
  version: "22.22.0",
  sha256: {
    arm64: "1bf1eb9ee63ffc4e5d324c0b9b62cf4a289f44332dfef9607cea1a0d9596ba6f",
    x64: "9aa8e9d2298ab68c600bd6fb86a6c13bce11a4eca1ba9b39d79fa021755d7c37",
  },
};
// vite-plus (Vite+, VoidZero) — beta; both vite-plus benches (vite-task-bench,
// vite-plus-tools-bench) must probe the same version or their datasets drift
export const VITE_PLUS_VERSION = "0.2.2";
// digest-pinned: "node:22-bookworm" is a moving tag, and two runs on different pulls of
// it would compare different node/glibc substrates under the same image label
export const NODE_IMAGE =
  "docker.io/library/node@sha256:c601a46abb4d2ab80a9dc3da208d50d1122642d53f17a101926ace71e5a9bf1c";
