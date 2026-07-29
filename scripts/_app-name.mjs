// Resolve a generated app's PACKAGE NAME from its on-disk manifest. Benches
// that target one app derive its DIRECTORY (apps/app-<i>) by index — always
// valid, directories are never renamed — but the package name must come from
// disk: generate.mjs may rename it to dodge bun's truncated-name-hash false
// duplicate (oven-sh/bun#36386; `bunNameHashRenames` in the generator summary),
// and an index-reconstructed name silently misses the rename.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function appPkgFromDisk(root, appDir) {
  const manifest = join(root, "apps", appDir, "package.json");
  try {
    return JSON.parse(readFileSync(manifest, "utf8")).name;
  } catch (e) {
    throw new Error(
      `cannot resolve app package name from ${manifest} (tree not generated?): ${e.message}`,
    );
  }
}
