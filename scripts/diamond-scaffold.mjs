#!/usr/bin/env node
// Scaffolds the "semver vs workspace + diamond dependency" example under
// examples/diamond/. These packages are PUBLISHED to a registry (AWS
// CodeArtifact) and then consumed by SEMVER — the normal independently-versioned
// monorepo convention — so we can show:
//   * a real diamond: consumer → alpha → widget@1  AND  consumer → beta → widget@2
//     (pnpm keeps BOTH versions; each dependent gets its compatible API)
//   * flipping ONE lib to workspace: via root pnpm.overrides, which COLLAPSES the
//     diamond to a single version and breaks whichever dependent expected the other
//
// Packages are intentionally SELF-CONTAINED (inline tsconfig, no shared root
// config) — lesson from turbo prune: published artifacts must not depend on
// repo-root files.

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "examples", "diamond");
rmSync(ROOT, { recursive: true, force: true });

const REGISTRY = "https://ejc3-928413605543.d.codeartifact.us-west-2.amazonaws.com/npm/npm/";

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      declaration: true,
      outDir: "dist",
      rootDir: "src",
      strict: true,
      skipLibCheck: true,
    },
    include: ["src"],
  },
  null,
  2,
);

function pkg(dir, json, indexTs) {
  const d = join(ROOT, dir);
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "package.json"), JSON.stringify(json, null, 2) + "\n");
  writeFileSync(join(d, "tsconfig.json"), TSCONFIG + "\n");
  writeFileSync(join(d, "src", "index.ts"), indexTs);
}

const base = (name, version, deps) => ({
  name,
  version,
  type: "module",
  main: "dist/index.js",
  types: "dist/index.d.ts",
  exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
  files: ["dist"],
  scripts: { build: "tsc" },
  publishConfig: { registry: REGISTRY },
  ...(deps ? { dependencies: deps } : {}),
  devDependencies: { typescript: "^5.9.0" },
});

// --- the shared lib, published at two MAJOR versions with a breaking change ---
pkg(
  "registry/widget-v1",
  base("@ejc3/widget", "1.0.0"),
  `export const WIDGET_MAJOR = 1 as const;
// v1 API
export function render(label: string): string {
  return \`[widget@1] \${label}\`;
}
`,
);

pkg(
  "registry/widget-v2",
  base("@ejc3/widget", "2.0.0"),
  `export const WIDGET_MAJOR = 2 as const;
// v2 API — BREAKING: render() removed, replaced by renderBox()
export function renderBox(opts: { label: string }): string {
  return \`[widget@2] \${opts.label}\`;
}
`,
);

// --- alpha depends on widget ^1 (uses the v1 API) ---
pkg(
  "registry/alpha",
  base("@ejc3/alpha", "1.0.0", { "@ejc3/widget": "^1.0.0" }),
  `import { render, WIDGET_MAJOR } from "@ejc3/widget";
export function alpha(): string {
  return \`alpha sees widget v\${WIDGET_MAJOR} → \${render("A")}\`;
}
`,
);

// --- beta depends on widget ^2 (uses the v2 API) ---
pkg(
  "registry/beta",
  base("@ejc3/beta", "1.0.0", { "@ejc3/widget": "^2.0.0" }),
  `import { renderBox, WIDGET_MAJOR } from "@ejc3/widget";
export function beta(): string {
  return \`beta sees widget v\${WIDGET_MAJOR} → \${renderBox({ label: "B" })}\`;
}
`,
);

// --- consumer: depends on alpha + beta by SEMVER (the diamond) ---
const consumerDir = join(ROOT, "consumer");
mkdirSync(consumerDir, { recursive: true });
writeFileSync(
  join(consumerDir, "package.json"),
  JSON.stringify(
    {
      name: "@ejc3/diamond-consumer",
      version: "0.0.0",
      private: true,
      type: "module",
      scripts: { start: "node run.mjs" },
      dependencies: { "@ejc3/alpha": "^1.0.0", "@ejc3/beta": "^1.0.0" },
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(
  join(consumerDir, "run.mjs"),
  `import { alpha } from "@ejc3/alpha";
import { beta } from "@ejc3/beta";
console.log(alpha());
console.log(beta());
`,
);

// --- override workspace ROOT files (driver copies widget-v2 + consumer in) ---
const ovr = join(ROOT, "override");
mkdirSync(ovr, { recursive: true });
writeFileSync(
  join(ovr, "pnpm-workspace.yaml"),
  `packages:
  - "packages/*"
  - "consumer"
`,
);
writeFileSync(
  join(ovr, "package.json"),
  JSON.stringify(
    {
      name: "diamond-override-root",
      version: "0.0.0",
      private: true,
      // Flip the shared lib to the LOCAL workspace copy for everyone — collapses the diamond.
      pnpm: { overrides: { "@ejc3/widget": "workspace:*" } },
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(
  join(ovr, ".npmrc"),
  `# semver internal deps resolve from the registry by default (pnpm 8+).
link-workspace-packages=false
`,
);

console.log(
  JSON.stringify({
    scaffolded: "examples/diamond",
    packages: [
      "@ejc3/widget@1.0.0",
      "@ejc3/widget@2.0.0",
      "@ejc3/alpha@1.0.0",
      "@ejc3/beta@1.0.0",
      "@ejc3/diamond-consumer",
    ],
  }),
);
