// Make the GENERATED workspace source visible to Turbo's input hashing during a
// benchmark, the way a real monorepo behaves: source is tracked (hashed), build
// outputs and deps are ignored.
//
// This repo's .gitignore ignores BOTH the generated source (/apps/, /packages/)
// AND build outputs/deps (.next, dist, *.tsbuildinfo, node_modules, .turbo, ...).
// Turbo respects .gitignore for hashing, so as-is it would hash NEITHER — making
// warm-cache/graph numbers understate reality and (if the whole file were removed)
// letting build outputs re-enter the hash and self-invalidate `next build`.
//
// enterSourceVisible() rewrites .gitignore to drop ONLY the /apps/ and /packages/
// lines, keeping every build-output/dep ignore. It returns a restore() that puts
// the original back; it also restores on SIGINT/SIGTERM and self-heals a prior
// interrupted run. Call restore() in a finally.

import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const isSourceIgnore = (line) => /^\/?(apps|packages)\/?$/.test(line.trim());

export function enterSourceVisible(root) {
  const gi = join(root, ".gitignore");
  const bak = join(root, ".gitignore.bench.bak");

  // self-heal: a prior run interrupted before restore left bak (the ORIGINAL)
  // behind and gi as the filtered copy — put the original back before proceeding.
  if (existsSync(bak)) {
    writeFileSync(gi, readFileSync(bak, "utf8"));
    rmSync(bak, { force: true });
  }
  if (!existsSync(gi)) return () => {};

  const original = readFileSync(gi, "utf8");
  writeFileSync(bak, original);
  const filtered = original
    .split("\n")
    .filter((line) => !isSourceIgnore(line))
    .join("\n");
  writeFileSync(gi, filtered);

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      if (existsSync(bak)) {
        writeFileSync(gi, readFileSync(bak, "utf8"));
        rmSync(bak, { force: true });
      }
    } catch {
      // best-effort restore; never throw from cleanup
    }
  };
  process.on("exit", restore); // normal completion or uncaught throw
  process.on("SIGINT", () => {
    restore();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    restore();
    process.exit(143);
  });
  return restore;
}
