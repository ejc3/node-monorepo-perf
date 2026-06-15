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

import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const isSourceIgnore = (line) => /^\/?(apps|packages)\/?$/.test(line.trim());

// Representative paths that are git-ignored iff the generated source is hidden.
// Prefer a REAL generated package.json so the check matches whatever path form
// the .gitignore actually uses (`/apps/`, `apps/**`, `/apps/app-*/`, `/apps/*/`,
// …); fall back to a synthetic path when the dir hasn't been generated yet.
function sourceProbes(root) {
  return ["apps", "packages"].map((group) => {
    const gd = join(root, group);
    if (existsSync(gd)) {
      const name = readdirSync(gd).find((n) => existsSync(join(gd, n, "package.json")));
      if (name) return `${group}/${name}/package.json`;
    }
    return `${group}/__srcvis_probe__`;
  });
}

// Whether git currently ignores the generated source.
function sourceIgnored(root) {
  for (const probe of sourceProbes(root)) {
    try {
      // execFileSync (no shell) + `--` so a probe path is never interpreted as a
      // shell command or a git flag.
      execFileSync("git", ["check-ignore", "-q", "--", probe], { cwd: root, stdio: "ignore" });
      return true; // exit 0 = ignored
    } catch (e) {
      // exit 1 = not ignored (the normal "no" answer); any other status (128 =
      // not a git repo, or git missing) is a real failure — surface it rather
      // than silently treating source as visible and measuring false cache hits.
      if (e.status === 1) continue;
      throw new Error(
        `enterSourceVisible: \`git check-ignore\` failed (status ${e.status ?? "?"}); ` +
          `cannot determine whether generated source is visible to Turbo.`,
      );
    }
  }
  return false;
}

export function enterSourceVisible(root) {
  const gi = join(root, ".gitignore");
  const bak = join(root, ".gitignore.bench.bak");

  // self-heal: a prior run interrupted before restore left bak (the ORIGINAL)
  // behind and gi as the filtered copy — put the original back before proceeding.
  if (existsSync(bak)) {
    writeFileSync(gi, readFileSync(bak, "utf8"));
    rmSync(bak, { force: true });
  }

  // If the generated source isn't git-ignored, it's already visible to Turbo's
  // hashing — nothing to do.
  if (!sourceIgnored(root)) return () => {};
  if (!existsSync(gi)) {
    throw new Error(
      `enterSourceVisible: generated source is git-ignored but ${gi} is missing; ` +
        `cannot make it visible to Turbo.`,
    );
  }

  const original = readFileSync(gi, "utf8");
  writeFileSync(bak, original);
  const filtered = original
    .split("\n")
    .filter((line) => !isSourceIgnore(line))
    .join("\n");
  writeFileSync(gi, filtered);

  // Post-condition: source must now be visible. If it's STILL ignored (e.g. the
  // .gitignore expresses the source ignore in a form `isSourceIgnore` doesn't
  // recognize, like `apps/**`), our filter silently did nothing — fail loud
  // rather than let every warm-cache/edit measurement become a false cache hit.
  if (sourceIgnored(root)) {
    writeFileSync(gi, original);
    rmSync(bak, { force: true });
    throw new Error(
      `enterSourceVisible: ${gi} still ignores generated source after filtering ` +
        `(unrecognized ignore form?); refusing to run with source hidden from Turbo.`,
    );
  }

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
