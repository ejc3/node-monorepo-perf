#!/usr/bin/env node
// clean-state.mjs — the definitive worktree reset for the benches, and the startup guard they
// share. The generate-and-measure benches all (a) regenerate the gitignored apps/packages tree,
// (b) temporarily patch a TRACKED file (tsconfig.base.json, .gitignore, package.json) and
// restore it on exit via a `<file>.bench.bak`, and (c) must NOT run concurrently in the same
// worktree (they share apps/, .turbo, .gitignore and corrupt each other — see CLAUDE.md). A
// hard kill (SIGKILL) skips the restore, leaving a patched tracked file + a stray .bench.bak,
// and a killed run can leave a half-written or mixed-width generated tree. This is the one place
// that heals all of that.
//
// As a library (imported by a bench): `ensureCleanState(root)` at startup —
//   1. restores any tracked file left patched (from its *.bench.bak), then
//   2. REFUSES (throws) if another bench process is already running in this worktree,
//   so a second concurrent run can never silently corrupt the first's tree.
//
// As a CLI (run by hand / `make clean`): `node scripts/clean-state.mjs [--wipe] [--kill]` —
//   restores baks, reports stray bench processes (kills them with --kill), and with --wipe
//   removes the generated tree + all bench scratch (never node_modules, never a committed
//   bench/*.json — only *.partial.json scratch).

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  readlinkSync,
} from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// A tracked file is patched-and-restored via "<file>.bench.bak" (the bak holds the ORIGINAL).
// Restore every such file and remove the bak. A JSON target's bak is validated first (a corrupt
// bak is left in place rather than clobbering the tracked file). MUST run only when no other
// bench is active in the worktree — restoring a live run's bak would un-patch it mid-run.
export function restoreBaks(root = SELF) {
  const restored = [];
  for (const f of readdirSync(root)) {
    if (!f.endsWith(".bench.bak")) continue;
    const baseName = f.slice(0, -".bench.bak".length);
    const bakPath = join(root, f);
    let content;
    try {
      content = readFileSync(bakPath, "utf8");
    } catch {
      continue;
    }
    if (baseName.endsWith(".json")) {
      try {
        JSON.parse(content);
      } catch {
        console.warn(`[clean-state] ${f} does not parse as JSON; leaving it for manual restore`);
        continue;
      }
    }
    try {
      writeFileSync(join(root, baseName), content);
      rmSync(bakPath, { force: true });
      restored.push(baseName);
    } catch {
      /* leave the bak in place if restore fails, so it can be retried */
    }
  }
  return restored;
}

// Other bench processes running in THIS worktree (cwd === root). Matches the bench's own node
// process (node <something>-bench.mjs | generate.mjs | measure.mjs), not the shell/tee wrapper
// (comm !== node) and not this process or this CLI. Excludes the caller's own ancestor chain so
// a bench calling ensureCleanState() never flags itself.
export function strayBenchPids(root = SELF) {
  const isBenchScript = (p) => /(?:^|\/)(?:generate|measure|sweep|[a-z0-9-]+-bench)\.mjs$/.test(p);
  // ancestors of self (incl self) — never report these
  const ancestors = new Set();
  let p = process.pid;
  for (let i = 0; i < 64 && p > 1; i++) {
    ancestors.add(p);
    try {
      const st = readFileSync(`/proc/${p}/status`, "utf8");
      p = +(st.match(/PPid:\s+(\d+)/) || [])[1] || 0;
    } catch {
      break;
    }
  }
  const stray = [];
  let pids = [];
  try {
    pids = readdirSync("/proc")
      .filter((d) => /^\d+$/.test(d))
      .map(Number);
  } catch {
    return stray;
  }
  for (const pid of pids) {
    if (ancestors.has(pid)) continue;
    let argv, cwd;
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      continue;
    }
    if (!argv.length || basename(argv[0]) !== "node") continue;
    const script = argv[1] || "";
    if (basename(script) === "clean-state.mjs") continue;
    if (isBenchScript(script) && resolve(cwd) === resolve(root))
      stray.push({ pid, cmd: argv.join(" ").slice(0, 140) });
  }
  return stray;
}

// Generated tree + every bench's scratch. NEVER node_modules (reinstall cost) and NEVER a
// committed bench/*.json (data of record) — only *.partial.json scratch.
export function wipeGenerated(root = SELF) {
  const fixed = [
    "apps",
    "packages",
    "out",
    ".turbo",
    "node_modules/.cache/turbo",
    "examples/diamond",
    "examples/per-app-workspace",
    ".ci-cache",
    "tsconfig.whole.json",
    "bun.lock",
    "bun.lockb",
  ];
  const removed = [];
  for (const rel of fixed) {
    const p = join(root, rel);
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true });
      removed.push(rel);
    }
  }
  const benchDir = join(root, "bench");
  if (existsSync(benchDir)) {
    for (const f of readdirSync(benchDir)) {
      if (f.endsWith(".partial.json")) {
        rmSync(join(benchDir, f), { force: true });
        removed.push(`bench/${f}`);
      }
    }
  }
  return removed;
}

// Startup guard for a bench: self-heal any leftover patch, then refuse if another bench is
// already running in this worktree (the anti-concurrency rule, enforced rather than documented).
export function ensureCleanState(root = SELF, { wipe = false } = {}) {
  // Refuse BEFORE mutating anything: if another bench is active, restoring its live .bench.bak
  // would un-patch it mid-run. Check strays first, then self-heal only when we're alone.
  const stray = strayBenchPids(root);
  if (stray.length)
    throw new Error(
      `[clean-state] refusing to run: ${stray.length} bench process(es) already active in this worktree ` +
        `(pids ${stray.map((s) => s.pid).join(", ")}). Benches share apps/.turbo/.gitignore and corrupt each ` +
        `other — use a separate git worktree, or run \`node scripts/clean-state.mjs --kill\` to clear strays.`,
    );
  const restored = restoreBaks(root);
  if (wipe) wipeGenerated(root);
  return { restored };
}

// ---- CLI ----------------------------------------------------------------------------------
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = new Set(process.argv.slice(2));

  // Strays first: never restore baks / wipe under a LIVE run (that would corrupt it) unless --kill.
  let stray = strayBenchPids();
  if (stray.length && args.has("--kill")) {
    for (const s of stray) {
      try {
        process.kill(s.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    console.log(`killed stray bench process(es): ${stray.map((s) => s.pid).join(", ")}`);
    stray = strayBenchPids();
  }
  if (stray.length) {
    console.log(
      `STRAY bench process(es) in this worktree — refusing to clean (re-run with --kill):`,
    );
    for (const s of stray) console.log(`  ${s.pid}  ${s.cmd}`);
    process.exit(1);
  }
  console.log("no stray bench processes in this worktree");

  const restored = restoreBaks();
  console.log(
    `restored tracked files from .bench.bak: ${restored.length ? restored.join(", ") : "(none)"}`,
  );

  if (args.has("--wipe")) {
    const removed = wipeGenerated();
    console.log(
      `wiped generated tree + scratch: ${removed.length ? removed.join(", ") : "(nothing to remove)"}`,
    );
  } else {
    console.log("(pass --wipe to also remove the generated tree + bench scratch)");
  }
}
