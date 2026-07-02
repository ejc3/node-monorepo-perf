// The pinned package-manager toolchain every install bench measures. One source of
// truth: install-bench.mjs and container-install-bench.mjs both import these, so the
// two datasets cannot silently describe different stacks.
export const PNPM_VERSION = "10.29.1";
export const BUN_VERSION = "1.3.14";
export const YARN_VERSION = "4.17.0";
// vite-plus (Vite+, VoidZero) — beta; both vite-plus benches (vite-task-bench,
// vite-plus-tools-bench) must probe the same version or their datasets drift
export const VITE_PLUS_VERSION = "0.2.2";
// digest-pinned: "node:22-bookworm" is a moving tag, and two runs on different pulls of
// it would compare different node/glibc substrates under the same image label
export const NODE_IMAGE =
  "docker.io/library/node@sha256:c601a46abb4d2ab80a9dc3da208d50d1122642d53f17a101926ace71e5a9bf1c";
