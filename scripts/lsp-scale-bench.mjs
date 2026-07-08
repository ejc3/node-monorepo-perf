// lsp-scale-bench — can the EDITOR layer load and watch the million-file program?
//
// tsgo-scale-bench answers the batch question (one-shot + --incremental CLI checks).
// This bench answers the resident-process question on the SAME corpus geometry: the
// two ways a developer gets continuous feedback, priced at 10k..1M modules.
//
//   LSP  — tsgo --lsp --stdio (the editor server VS Code's preview extension runs).
//          It is a PULL-diagnostics, OPEN-FILE server: it computes diagnostics for
//          files the editor opens, on request. It does NOT provide a whole-project
//          watch verdict — workspace/diagnostic ("is the project clean?") is
//          milestoned Post-7.0 upstream (microsoft/typescript-go#2169). What it
//          gives at scale is measured here: cold open (spawn → first cross-file
//          definition), the first diagnostics pull, the warm keystroke loop
//          (didChange → pull), and peak RSS. Whether the server registers real
//          file watchers (client/registerCapability for didChangeWatchedFiles) is
//          recorded as the protocol-level "does it watch" fact.
//   watch — tsgo --watch -p tsconfig (the CLI watcher, "prototype" per upstream's
//          README: rebuilds, no incremental rechecking). first build, then the
//          one-edit → "Found N errors" recheck loop: the whole-program watch a
//          CI-adjacent tmux pane actually runs.
//
// Anchors, so the numbers mean something: tsserver (the shipped JS server) runs the
// same LSP-shaped probes via its own protocol up to TSSERVER_ANCHOR_MAX, and
// tsc --watch (which HAS affected-files incremental rechecking, TS 3.8 semantics)
// anchors the watch rows up to the same cutoff — the one whole-project warm
// rechecker that exists today sits on the slow checker; that contrast is the point.
//
// GATES per scale (untimed): the program must be exactly N src files — batch (tsgo
// --listFiles count; tsc --listFiles on anchored points) AND in-session (every
// timed tsserver session must report the corpus tsconfig with exactly N src files
// via projectInfo(needFileNameList); a tsgo session fails on any pushed TS5xxx
// config diagnostic, and its cold def must land in the exact imported module file).
// A seeded type error must surface through each channel before its timed rows
// count — LSP: didOpen with seeded TEXT (an editor overlay, no disk write) must
// pull a TS2322; watch: a seeded edit must flip "Found 0 errors" to a nonzero count
// and back on restore. The warm squiggle rows are themselves asserted transitions
// (edit → TS2322 reported, restore → clean), so a server that no-ops didChange
// cannot produce a timed number.
//
// A server/watcher killed by KILL/SEGV/ABRT/BUS, or hitting the 1h ceiling on a
// load-bearing request, is that row's RECORDED outcome ("dies at N" is the answer —
// this is a capacity probe). Everything else hard-fails with the output tail:
// INT/TERM/HUP (interrupted, not a measurement), plain nonzero exits, JSON-RPC /
// protocol errors, spawn failures, warm-request timeouts — a rejected flag or a
// config error must never mint a capacity row. A type error on the clean corpus
// is a scaffold bug, never data. Per-checker isolation: one checker's death never
// robs another's rows.
//
// Self-contained and non-destructive: corpus under LSP_SCALE_WORK (default
// /mnt/fcvm-btrfs/lsp-scale-bench — separate from tsgo-scale-bench's dir so the two
// never share state), removed on exit unless LSP_SCALE_KEEP=1. Core-bound: refuses
// on a loaded box unless LSP_SCALE_ALLOW_BUSY=1 (an active tsgo-scale sweep trips
// this). Corpus geometry mirrors tsgo-scale-bench module-for-module so rows are
// comparable across the two benches.

import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  appendFileSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { median, loadGuard, load1Now, benchOutput } from "./_pm-bench-lib.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POINTS = (process.env.LSP_SCALE_POINTS || "10000 100000 250000 500000 1000000")
  .trim()
  .split(/\s+/)
  .map(Number);
const CANONICAL_POINTS = "10000 100000 250000 500000 1000000";
const SAMPLES = Number(process.env.LSP_SCALE_SAMPLES || 3); // warm ops + recheck samples
const COLD_SAMPLES = Number(process.env.LSP_COLD_SAMPLES || 2); // fresh-server cold opens
const LAYERS = Number(process.env.LSP_SCALE_LAYERS || 100);
const TSSERVER_ANCHOR_MAX = Number(process.env.TSSERVER_ANCHOR_MAX || 100000);
const WORK = process.env.LSP_SCALE_WORK || "/mnt/fcvm-btrfs/lsp-scale-bench";
const PER_DIR = 1000;
const LOAD_TIMEOUT_MS = 3_600_000; // load-bearing requests (init, first def/diag, first build, edit→recheck rows)
const REQ_TIMEOUT_MS = 120_000; // warm cached-state requests (def/completion/hover)

class BenchFailure extends Error {}
const fail = (m) => {
  throw new BenchFailure(`FAIL: ${m}`);
};
process.on("uncaughtException", (e) => {
  console.error(`\n${e instanceof BenchFailure ? e.message : e.stack || e}`);
  process.exit(1);
});
if (!Number.isInteger(SAMPLES) || SAMPLES < 1) fail("LSP_SCALE_SAMPLES must be an integer >= 1");
if (!Number.isInteger(COLD_SAMPLES) || COLD_SAMPLES < 1)
  fail("LSP_COLD_SAMPLES must be an integer >= 1");
if (!Number.isInteger(LAYERS) || LAYERS < 2) fail("LSP_SCALE_LAYERS must be an integer >= 2");
if (POINTS.some((n) => !Number.isInteger(n) || n < LAYERS * 3))
  fail(`every point must be >= 3*LAYERS (${LAYERS * 3}) for the layered geometry`);
if (POINTS.some((n, i) => i > 0 && n <= POINTS[i - 1]))
  fail("LSP_SCALE_POINTS must be strictly increasing (the corpus grows incrementally)");
const envInfo = loadGuard("LSP_SCALE_ALLOW_BUSY");

const DIR = join(WORK, "corpus");
const LOCK = join(WORK, "bench.lock");
const STATE = join(WORK, "corpus-state.json");
mkdirSync(WORK, { recursive: true });

// same atomic-lock + adoption discipline as tsgo-scale-bench: two concurrent
// invocations would share (and mutually rmSync) the corpus
let lockOwned = false;
const acquireLock = () => {
  try {
    writeFileSync(LOCK, String(process.pid), { flag: "wx" });
    lockOwned = true;
    return true;
  } catch {
    return false;
  }
};
if (!acquireLock()) {
  const pid = Number(readFileSync(LOCK, "utf8").trim());
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    // stale lock from a dead process
  }
  if (alive) fail(`another lsp-scale-bench (pid ${pid}) is running in ${WORK}`);
  rmSync(LOCK, { force: true });
  if (!acquireLock()) fail(`lost the lock race for ${WORK}`);
}

let generated = 0;
if (existsSync(STATE)) {
  try {
    const st = JSON.parse(readFileSync(STATE, "utf8"));
    if (st.layers === LAYERS && st.perDir === PER_DIR && Number.isInteger(st.generated))
      generated = st.generated;
  } catch {
    // unreadable marker — treat as absent
  }
}
if (generated > POINTS[0]) generated = 0;
if (generated === 0) rmSync(DIR, { recursive: true, force: true });
mkdirSync(join(DIR, "src"), { recursive: true });

// every live child this run spawned; killed on exit so a failed run never strands a
// 50GB server or a watcher holding the corpus
const liveKids = new Set();
process.on("exit", () => {
  if (!lockOwned) return;
  for (const p of liveKids) {
    try {
      p.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  rmSync(LOCK, { force: true });
  if (process.env.LSP_SCALE_KEEP === "1") return;
  rmSync(DIR, { recursive: true, force: true });
  rmSync(STATE, { force: true });
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

// ---- toolchain (same resolution as tsgo-scale-bench: the timed process IS the checker) ----
const tsgoShim = join(REPO, "node_modules", ".bin", "tsgo");
const TSC = join(REPO, "node_modules", ".bin", "tsc");
const TSSERVER = join(REPO, "node_modules", "typescript", "lib", "tsserver.js");
if (!existsSync(tsgoShim) || !existsSync(TSC) || !existsSync(TSSERVER))
  fail("tsgo/tsc/tsserver not found — run `pnpm install` at the repo root first");
const nativeProbe = spawnSync(
  "node",
  [
    "-e",
    `const { realpathSync } = require("node:fs");
const { dirname, join } = require("node:path");
const wrapper = dirname(realpathSync(require.resolve("@typescript/native-preview/package.json")));
const platformPkg = require.resolve("@typescript/native-preview-linux-arm64/package.json", { paths: [wrapper] });
process.stdout.write(join(dirname(platformPkg), "lib", "tsgo"));`,
  ],
  { cwd: REPO, encoding: "utf8" },
);
const TSGO =
  nativeProbe.status === 0 && existsSync(nativeProbe.stdout.trim())
    ? nativeProbe.stdout.trim()
    : tsgoShim;
const tsgoInvocation = TSGO === tsgoShim ? ".bin shim" : "native binary (direct)";
if (spawnSync(TSGO, ["--version"], { encoding: "utf8" }).status !== 0)
  fail(`resolved tsgo does not run: ${TSGO}`);

// node-based tools (tsserver, tsc --watch) get the same recorded 64GB ceiling the
// batch bench gives tsc, so node's default heap never masquerades as a limit
const NODE_HEAP = "--max-old-space-size=65536";
const nodeEnv = { ...process.env, NODE_OPTIONS: NODE_HEAP };

// ---- corpus (mirrors tsgo-scale-bench module-for-module, TS dialect only) -----------------
const shard = (i) => String(Math.floor(i / PER_DIR)).padStart(4, "0");
const importsOf = (i) => {
  if (i % LAYERS === 0) return [];
  return [i - 1, i - 1 - LAYERS, i - 1 - 2 * LAYERS].filter((j) => j >= 0);
};
const relPath = (from, to) =>
  shard(from) === shard(to) ? `./m${to}.js` : `../${shard(to)}/m${to}.js`;
const moduleSrc = (i) => {
  const imports = importsOf(i);
  const importLines = imports
    .map((j) => `import { v${j}, type T${j} } from "${relPath(i, j)}";`)
    .join("\n");
  const useSum = imports.map((j) => `v${j}`).join(" + ") || "0";
  return `${importLines}
export interface T${i} { id: number; tag: string; deps: readonly number[]; }
export function make${i}(id: number): T${i} { return { id, tag: "m${i}", deps: [${imports.join(", ")}] }; }
export function fold${i}(xs: readonly T${i}[]): number { return xs.reduce((a, b) => a + b.id, 0) + ${useSum}; }
export const v${i}: number = ${i} + ${useSum};
`;
};
function growCorpus(n) {
  if (n < generated) return 0;
  const t0 = process.hrtime.bigint();
  for (let i = generated; i < n; i++) {
    if (i % PER_DIR === 0) mkdirSync(join(DIR, "src", shard(i)), { recursive: true });
    writeFileSync(join(DIR, "src", shard(i), `m${i}.ts`), moduleSrc(i));
  }
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  generated = n;
  writeFileSync(STATE, JSON.stringify({ generated, layers: LAYERS, perDir: PER_DIR }) + "\n");
  return ms;
}
const CFG = join(DIR, "tsconfig.json");
writeFileSync(
  CFG,
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "nodenext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ["src"],
    },
    null,
    2,
  ),
);

// the LSP-opened module: mid-corpus, not layer 0 (has imports to resolve AND importers)
const targetIndexFor = (n) => {
  let i = Math.floor(n / 2);
  if (i % LAYERS === 0) i += 1;
  return i;
};
const modPath = (i) => join(DIR, "src", shard(i), `m${i}.ts`);

// ---- shared probe geometry -----------------------------------------------------------------
// definition probe: the target module's v{j} usage in its `export const v{i} = ...` line,
// which must resolve to the EXACT file src/<shard(j)>/m{j}.ts (an unresolved import
// resolves to the import line itself — the bug a "non-empty locations" check misses)
const pickTarget = (n) => {
  const i = targetIndexFor(n);
  const file = modPath(i);
  const text = readFileSync(file, "utf8");
  const j = importsOf(i)[0];
  const lines = text.split("\n");
  const line0 = lines.findIndex((l) => l.startsWith(`export const v${i}`));
  if (line0 === -1) fail(`no export const v${i} line in ${file}`);
  const col0 = lines[line0].indexOf(`v${j}`);
  if (col0 === -1) fail(`no v${j} usage on the export line of ${file}`);
  const expectedDefFile = modPath(j);
  return { i, j, file, text, line0, col0, expectedDefFile };
};
const seededText = (t) =>
  t.text.replace(`export const v${t.i}: number =`, `export const v${t.i}: string =`);

const CORES = envInfo.cores;
const nowMs = () => Number(process.hrtime.bigint() / 1_000_000n);

// peak RSS of a process tree (VmHWM sum), sampled continuously for the child's lifetime
const rssTreeKB = (rootPid) => {
  const status = (pid) => {
    try {
      return readFileSync(`/proc/${pid}/status`, "utf8");
    } catch {
      return "";
    }
  };
  let pids = [];
  try {
    pids = readdirSync("/proc")
      .filter((d) => /^\d+$/.test(d))
      .map(Number);
  } catch {
    return null;
  }
  const kids = new Map();
  for (const pid of pids) {
    const m = status(pid).match(/PPid:\s+(\d+)/);
    if (m) {
      const pp = +m[1];
      if (!kids.has(pp)) kids.set(pp, []);
      kids.get(pp).push(pid);
    }
  }
  const tree = [];
  const walk = (pid) => {
    tree.push(pid);
    for (const k of kids.get(pid) || []) walk(k);
  };
  walk(rootPid);
  let total = 0;
  let any = false;
  for (const pid of tree) {
    const m = status(pid).match(/VmHWM:\s+(\d+)\s+kB/);
    if (m) {
      total += +m[1];
      any = true;
    }
  }
  return any ? total : null;
};
const startRssSampler = (pid) => {
  let max = 0;
  const tick = () => {
    const k = rssTreeKB(pid);
    if (k) max = Math.max(max, k);
  };
  tick();
  const t = setInterval(tick, 200);
  if (t.unref) t.unref();
  return {
    stop: () => {
      tick();
      clearInterval(t);
      return max;
    },
  };
};

// KILL/SEGV/ABRT/BUS = capacity outcome; a load-bearing (1h) timeout is the only
// other recorded outcome. INT/TERM/HUP is an interrupt, and everything else — a
// plain nonzero exit (a rejected flag, a config error), a JSON-RPC/protocol error,
// a spawn failure, a warm-request timeout — is a harness/toolchain fault: hard-fail
// with the output tail, never a "dies at N" row.
const CAPACITY_SIGNALS = new Set(["SIGKILL", "SIGSEGV", "SIGABRT", "SIGBUS"]);
const classifyDeath = (label, n, e, tail) => {
  if (e.signal && CAPACITY_SIGNALS.has(e.signal))
    return {
      killed: true,
      exit: null,
      signal: e.signal,
      timedOut: false,
      stderrTail: (tail || "").slice(-300),
    };
  if (e.signal) fail(`${label} killed by ${e.signal} at n=${n} — interrupted, not a measurement`);
  if (e.timedOut && e.loadBearing)
    return {
      killed: true,
      exit: null,
      signal: null,
      timedOut: true,
      stderrTail: (tail || "").slice(-300),
    };
  fail(`${label} at n=${n}: ${e.message}\n--- output tail ---\n${(tail || "").slice(-1200)}`);
};

// byte-accurate Content-Length framing (shared by the LSP and tsserver drivers)
function makeFramer(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const he = buf.indexOf("\r\n\r\n");
      if (he === -1) break;
      const m = buf
        .slice(0, he)
        .toString("ascii")
        .match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        buf = buf.slice(he + 4);
        continue;
      }
      const len = +m[1];
      const start = he + 4;
      if (buf.length < start + len) break;
      const body = buf.slice(start, start + len).toString("utf8");
      buf = buf.slice(start + len);
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      onMessage(msg);
    }
  };
}

// ---- tsgo LSP driver -----------------------------------------------------------------------
// one session object per fresh server; every load-bearing reply is verified, and a dead
// process turns pending requests into a rejection carrying (code, signal) for classification
function startTsgoLsp() {
  const proc = spawn(TSGO, ["--lsp", "--stdio"], { cwd: DIR, stdio: ["pipe", "pipe", "pipe"] });
  liveKids.add(proc);
  const rss = startRssSampler(proc.pid);
  let id = 0;
  const waiters = new Map();
  let stderr = "";
  let dead = null; // {code, signal}
  let watchRegistration = null; // method the server registered file watchers under, if any
  const pushedDiagCodes = []; // pushed publishDiagnostics codes (tsgo pushes TS5xxx config errors here)
  proc.on("error", (e) => {
    dead = { code: null, signal: null, err: e.message };
    for (const { reject } of waiters.values()) reject(Object.assign(new Error(e.message), dead));
    waiters.clear();
  });
  proc.on("exit", (code, signal) => {
    dead = { code, signal };
    for (const { reject } of waiters.values())
      reject(Object.assign(new Error(`tsgo lsp exited code=${code} signal=${signal}`), dead));
    waiters.clear();
  });
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  const sendRaw = (obj) => {
    const s = JSON.stringify(obj);
    proc.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
  };
  proc.stdout.on(
    "data",
    makeFramer((msg) => {
      if (msg.id !== undefined && msg.method) {
        if (msg.method === "client/registerCapability") {
          for (const r of msg.params?.registrations || [])
            if (r.method === "workspace/didChangeWatchedFiles") watchRegistration = r.method;
        }
        const result =
          msg.method === "workspace/configuration"
            ? (msg.params?.items || []).map(() => ({}))
            : null;
        sendRaw({ jsonrpc: "2.0", id: msg.id, result });
      } else if (msg.id !== undefined && waiters.has(msg.id)) {
        const { resolve } = waiters.get(msg.id);
        waiters.delete(msg.id);
        resolve(msg);
      } else if (msg.method === "textDocument/publishDiagnostics") {
        // tsgo does not push diagnostics for the opened FILE (those come from the pull
        // request) but it DOES push config/project errors (TS5xxx on the tsconfig) —
        // dropping them would let a session that fell back to an inferred project pass
        // every other guard on this corpus's relative imports
        for (const d of msg.params?.diagnostics || []) pushedDiagCodes.push(Number(d.code));
      }
    }),
  );
  const request = (method, params, timeoutMs = REQ_TIMEOUT_MS) =>
    new Promise((resolvePromise, reject) => {
      if (dead) return reject(Object.assign(new Error(`tsgo lsp: process already dead`), dead));
      const myId = ++id;
      const timer = setTimeout(() => {
        waiters.delete(myId);
        reject(
          Object.assign(new Error(`tsgo lsp ${method} timed out after ${timeoutMs}ms`), {
            timedOut: true,
            loadBearing: timeoutMs >= LOAD_TIMEOUT_MS,
          }),
        );
      }, timeoutMs);
      waiters.set(myId, {
        resolve: (msg) => {
          clearTimeout(timer);
          if (msg.error)
            reject(
              new Error(`tsgo lsp ${method} error: ${JSON.stringify(msg.error).slice(0, 200)}`),
            );
          else resolvePromise(msg.result);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      sendRaw({ jsonrpc: "2.0", id: myId, method, params });
    });
  const notify = (method, params) => sendRaw({ jsonrpc: "2.0", method, params });
  const kill = () => {
    const peak = rss.stop();
    liveKids.delete(proc);
    try {
      proc.stdin.end();
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
    return peak;
  };
  return {
    proc,
    request,
    notify,
    kill,
    getDead: () => dead,
    getStderr: () => stderr,
    getWatchRegistration: () => watchRegistration,
    getPushedDiagCodes: () => pushedDiagCodes,
  };
}

async function lspInitAndOpen(s, target, openText) {
  const rootUri = pathToFileURL(DIR).href;
  const uri = pathToFileURL(target.file).href;
  const tInit = nowMs();
  await s.request(
    "initialize",
    {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "corpus" }],
      capabilities: {
        textDocument: {
          hover: {},
          definition: {},
          completion: {},
          diagnostic: { dynamicRegistration: false },
        },
        workspace: { didChangeWatchedFiles: { dynamicRegistration: true } },
      },
    },
    LOAD_TIMEOUT_MS,
  );
  const initMs = nowMs() - tInit;
  s.notify("initialized", {});
  s.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "typescript", version: 1, text: openText },
  });
  return { initMs, uri };
}

const locUri = (d) => (d ? d.uri || d.targetUri : null);
const defResolvesTo = (defResult, expectedFile) => {
  const locs = Array.isArray(defResult) ? defResult : defResult ? [defResult] : [];
  if (!locs.length || !locUri(locs[0])) return null;
  return fileURLToPath(locUri(locs[0]));
};

async function pullFullDiag(s, uri, timeoutMs) {
  const report = await s.request("textDocument/diagnostic", { textDocument: { uri } }, timeoutMs);
  if (!report || report.kind !== "full" || !Array.isArray(report.items))
    fail(`tsgo lsp: textDocument/diagnostic did not return a FULL report — guard would be vacuous`);
  // any pushed TS5xxx means the session rejected/missed the corpus tsconfig — its
  // rows would be measuring a different (inferred) program
  const cfgErrs = s.getPushedDiagCodes().filter((c) => Number.isFinite(c) && c >= 5000 && c < 6000);
  if (cfgErrs.length)
    fail(
      `tsgo lsp pushed config errors TS${[...new Set(cfgErrs)].join(", TS")} — the session did not load the corpus tsconfig`,
    );
  // gate on ERROR severity (LSP severity 1) only: the language server also serves
  // hint/suggestion items batch --noEmit never emits — editor affordances, not type
  // errors; counting them would fail the clean gate on a clean corpus
  pullFullDiag.lastItems = report.items.map((i) => ({
    code: Number(i.code),
    severity: i.severity ?? 1,
    message: String(i.message || "").slice(0, 90),
  }));
  return pullFullDiag.lastItems
    .filter((i) => i.severity === 1)
    .map((i) => i.code)
    .filter((c) => Number.isFinite(c));
}

// the whole tsgo-LSP block for one scale point; any server death/timeout inside is
// classified and RECORDED (a capacity probe), never a bench failure
async function benchTsgoLsp(n) {
  const target = pickTarget(n);
  const position = { line: target.line0, character: target.col0 };
  // positive control: a seeded error in the OPEN BUFFER (editor overlay, no disk write)
  // must pull TS2322 — proves the pull channel actually type-checks before rows count
  {
    const s = startTsgoLsp();
    try {
      const { uri } = await lspInitAndOpen(s, target, seededText(target));
      const codes = await pullFullDiag(s, uri, LOAD_TIMEOUT_MS);
      if (!codes.includes(2322))
        fail(
          `tsgo lsp positive control: seeded TS2322 not pulled at n=${n} (got ${codes.slice(0, 6)})`,
        );
    } catch (e) {
      if (e instanceof BenchFailure) throw e;
      s.kill();
      return { gate: classifyDeath("tsgo lsp (control)", n, e, s.getStderr()) };
    }
    s.kill();
  }

  // cold opens: a fresh server per sample; coldOpen = spawn → first cross-file def
  const colds = [];
  let lastServer = null;
  let lastUri = null;
  for (let k = 0; k < COLD_SAMPLES; k++) {
    const s = startTsgoLsp();
    try {
      const t0 = nowMs();
      const { initMs, uri } = await lspInitAndOpen(s, target, target.text);
      const def = await s.request(
        "textDocument/definition",
        { textDocument: { uri }, position },
        LOAD_TIMEOUT_MS,
      );
      const coldOpenMs = nowMs() - t0;
      const got = defResolvesTo(def, target.expectedDefFile);
      if (got !== target.expectedDefFile)
        fail(`tsgo lsp cold def resolved to ${got}, expected ${target.expectedDefFile} at n=${n}`);
      const tDiag = nowMs();
      const codes = await pullFullDiag(s, uri, LOAD_TIMEOUT_MS);
      const firstDiagMs = nowMs() - tDiag;
      if (codes.length)
        fail(
          `tsgo lsp pulled ${codes.length} error diagnostics on the clean corpus at n=${n}: ${JSON.stringify(pullFullDiag.lastItems.slice(0, 4))}`,
        );
      colds.push({ coldOpenMs, initMs, firstDiagMs });
      if (k === COLD_SAMPLES - 1) {
        lastServer = s;
        lastUri = uri;
      } else s.kill();
    } catch (e) {
      if (e instanceof BenchFailure) throw e;
      const peak = s.kill();
      return {
        cold: {
          ...classifyDeath("tsgo lsp (cold open)", n, e, s.getStderr()),
          peakRssMB: peak ? Math.round(peak / 1024) : null,
        },
      };
    }
  }

  // warm keystroke loop on the last server: def / completion / hover, the valid-edit
  // didChange → pull row, and the HEADLINE squiggle transitions — didChange to the
  // seeded TS2322 must pull red (errorAppearsMs), the restore must pull clean
  // (errorClearsMs). The transitions are asserted recomputes: a server that ignores
  // didChange or serves a stale report cannot pass them.
  const s = lastServer;
  const warm = { def: [], comp: [], hov: [], change: [], errAppear: [], errClear: [] };
  let compItems = 0;
  let version = 1;
  const changeTo = (text) =>
    s.notify("textDocument/didChange", {
      textDocument: { uri: lastUri, version: ++version },
      contentChanges: [{ text }],
    });
  try {
    await s.request("textDocument/hover", { textDocument: { uri: lastUri }, position });
    for (let k = 0; k < SAMPLES; k++) {
      let t = nowMs();
      const d = await s.request("textDocument/definition", {
        textDocument: { uri: lastUri },
        position,
      });
      warm.def.push(nowMs() - t);
      if (defResolvesTo(d, target.expectedDefFile) !== target.expectedDefFile)
        fail(`tsgo lsp warm definition lost its target at n=${n}`);
      t = nowMs();
      const h = await s.request("textDocument/hover", { textDocument: { uri: lastUri }, position });
      warm.hov.push(nowMs() - t);
      const hc =
        h && h.contents
          ? typeof h.contents === "string"
            ? h.contents
            : h.contents.value || ""
          : "";
      if (!hc.includes(`v${target.j}`))
        fail(`tsgo lsp warm hover does not name v${target.j} at n=${n}`);
      // valid-edit row: append a const to the open buffer, pull fresh diagnostics.
      // The edit→recheck rows are load-bearing (the recompute IS the measurement):
      // past the 1h ceiling they are a recorded outcome, not a harness fault
      t = nowMs();
      changeTo(target.text + `const __lsp_probe_${k} = ${k};\n`);
      const codes = await pullFullDiag(s, lastUri, LOAD_TIMEOUT_MS);
      warm.change.push(nowMs() - t);
      if (codes.length)
        fail(
          `tsgo lsp didChange loop pulled error diagnostics on valid edit at n=${n}: ${JSON.stringify(pullFullDiag.lastItems.slice(0, 4))}`,
        );
      // squiggle transitions: the pulled report must FLIP with the edit, both ways
      t = nowMs();
      changeTo(seededText(target));
      const errCodes = await pullFullDiag(s, lastUri, LOAD_TIMEOUT_MS);
      warm.errAppear.push(nowMs() - t);
      if (!errCodes.includes(2322))
        fail(
          `tsgo lsp seeded didChange did not pull TS2322 at n=${n} (got ${errCodes.slice(0, 6)})`,
        );
      t = nowMs();
      changeTo(target.text);
      const clearCodes = await pullFullDiag(s, lastUri, LOAD_TIMEOUT_MS);
      warm.errClear.push(nowMs() - t);
      if (clearCodes.length)
        fail(
          `tsgo lsp restore didChange did not pull clean at n=${n} (got ${clearCodes.slice(0, 6)})`,
        );
    }
    // completion LAST: it is the one probe with a known superlinear blowup, so a
    // timeout is that PROBE's recorded outcome (the server is killed right after
    // either way — a still-grinding completion can pollute no other row)
    try {
      for (let k = 0; k < SAMPLES; k++) {
        const t = nowMs();
        const c = await s.request("textDocument/completion", {
          textDocument: { uri: lastUri },
          position,
        });
        warm.comp.push(nowMs() - t);
        const items = Array.isArray(c) ? c : c && c.items ? c.items : [];
        compItems = items.length;
        if (compItems === 0)
          fail(
            `tsgo lsp completion returned 0 items at n=${n} — a vacuous probe cannot post a time`,
          );
      }
    } catch (ce) {
      if (!ce || ce.timedOut !== true) throw ce;
      warm.compTimedOut = true;
    }
  } catch (e) {
    if (e instanceof BenchFailure) throw e;
    const peak = s.kill();
    return {
      cold: summarizeColds(colds),
      warmLoop: classifyDeath("tsgo lsp (warm loop)", n, e, s.getStderr()),
      peakRssMB: peak ? Math.round(peak / 1024) : null,
    };
  }
  const watchRegistration = s.getWatchRegistration();
  const peak = s.kill();
  return {
    cold: summarizeColds(colds),
    warm: {
      defMs: median(warm.def),
      completionMs: warm.compTimedOut
        ? { timedOut: true, ceilingMs: REQ_TIMEOUT_MS }
        : median(warm.comp),
      hoverMs: median(warm.hov),
      didChangePullMs: median(warm.change),
      errorAppearsMs: median(warm.errAppear),
      errorClearsMs: median(warm.errClear),
      samples: SAMPLES,
      completionItems: compItems,
    },
    peakRssMB: peak ? Math.round(peak / 1024) : null,
    watchRegistration:
      watchRegistration || "none (server did not register workspace/didChangeWatchedFiles)",
  };
}
const summarizeColds = (colds) =>
  colds.length
    ? {
        coldOpenMs: median(colds.map((c) => c.coldOpenMs)),
        initMs: median(colds.map((c) => c.initMs)),
        firstDiagMs: median(colds.map((c) => c.firstDiagMs)),
        samples: colds.length,
      }
    : { unavailable: "no cold sample completed" };

// ---- tsserver anchor driver ----------------------------------------------------------------
// the shipped JS server, same probes through its own protocol; anchored ≤ TSSERVER_ANCHOR_MAX
function startTsserver() {
  const proc = spawn("node", [TSSERVER], {
    cwd: DIR,
    stdio: ["pipe", "pipe", "pipe"],
    env: nodeEnv,
  });
  liveKids.add(proc);
  const rss = startRssSampler(proc.pid);
  let seq = 0;
  const waiters = new Map();
  let stderr = "";
  let dead = null;
  proc.on("error", (e) => {
    dead = { code: null, signal: null, err: e.message };
    for (const { reject } of waiters.values()) reject(Object.assign(new Error(e.message), dead));
    waiters.clear();
  });
  proc.on("exit", (code, signal) => {
    dead = { code, signal };
    for (const { reject } of waiters.values())
      reject(Object.assign(new Error(`tsserver exited code=${code} signal=${signal}`), dead));
    waiters.clear();
  });
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  proc.stdout.on(
    "data",
    makeFramer((msg) => {
      if (msg.type === "response" && waiters.has(msg.request_seq)) {
        const { resolve } = waiters.get(msg.request_seq);
        waiters.delete(msg.request_seq);
        resolve(msg);
      }
    }),
  );
  const request = (command, args, timeoutMs = REQ_TIMEOUT_MS) =>
    new Promise((resolvePromise, reject) => {
      if (dead) return reject(Object.assign(new Error(`tsserver: process already dead`), dead));
      const mySeq = ++seq;
      const timer = setTimeout(() => {
        waiters.delete(mySeq);
        reject(
          Object.assign(new Error(`tsserver ${command} timed out after ${timeoutMs}ms`), {
            timedOut: true,
            loadBearing: timeoutMs >= LOAD_TIMEOUT_MS,
          }),
        );
      }, timeoutMs);
      waiters.set(mySeq, {
        resolve: (msg) => {
          clearTimeout(timer);
          if (!msg.success)
            reject(new Error(`tsserver ${command}: ${msg.message || "unsuccessful"}`));
          else resolvePromise(msg.body);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      proc.stdin.write(
        JSON.stringify({ seq: mySeq, type: "request", command, arguments: args }) + "\n",
      );
    });
  const notify = (command, args) =>
    proc.stdin.write(
      JSON.stringify({ seq: ++seq, type: "request", command, arguments: args }) + "\n",
    );
  const kill = () => {
    const peak = rss.stop();
    liveKids.delete(proc);
    try {
      proc.stdin.end();
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
    return peak;
  };
  return { proc, request, notify, kill, getDead: () => dead, getStderr: () => stderr };
}

async function benchTsserver(n) {
  const target = pickTarget(n);
  const line1 = target.line0 + 1; // tsserver positions are 1-based
  const col1 = target.col0 + 1;
  // the in-buffer seeded-edit range: the ": number =" annotation on the export line;
  // "number" and "string" are the same length, so the replace range is identical both ways
  const annIdx = target.text.split("\n")[target.line0].indexOf(": number =");
  if (annIdx === -1) fail(`no ": number =" annotation on the export line of ${target.file}`);
  // positive control: seed the error ON DISK (tsserver reads files), open, sync-diag
  const original = target.text;
  writeFileSync(target.file, seededText(target));
  try {
    const s = startTsserver();
    try {
      s.notify("open", { file: target.file });
      const diags = await s.request(
        "semanticDiagnosticsSync",
        { file: target.file },
        LOAD_TIMEOUT_MS,
      );
      if (!(diags || []).some((d) => d.code === 2322))
        fail(`tsserver positive control: seeded TS2322 not reported at n=${n}`);
    } catch (e) {
      if (e instanceof BenchFailure) throw e;
      s.kill();
      return { gate: classifyDeath("tsserver (control)", n, e, s.getStderr()) };
    } finally {
      s.kill();
    }
  } finally {
    writeFileSync(target.file, original);
  }

  const colds = [];
  let lastServer = null;
  let sessionProjectFiles = null;
  for (let k = 0; k < COLD_SAMPLES; k++) {
    const s = startTsserver();
    try {
      const t0 = nowMs();
      s.notify("open", { file: target.file });
      const def = await s.request(
        "definition",
        { file: target.file, line: line1, offset: col1 },
        LOAD_TIMEOUT_MS,
      );
      const coldOpenMs = nowMs() - t0;
      const got = def && def.length ? def[0].file : null;
      if (got !== target.expectedDefFile)
        fail(`tsserver cold def resolved to ${got}, expected ${target.expectedDefFile} at n=${n}`);
      const tDiag = nowMs();
      const diags = await s.request(
        "semanticDiagnosticsSync",
        { file: target.file },
        LOAD_TIMEOUT_MS,
      );
      const firstDiagMs = nowMs() - tDiag;
      if ((diags || []).length)
        fail(`tsserver reported ${diags.length} diagnostics on the clean corpus at n=${n}`);
      // in-session program proof (untimed): THIS session's loaded project must be the
      // corpus tsconfig with exactly n src files — the batch --listFiles gate proves
      // the config, not that the measured server loaded it; on relative imports an
      // inferred-project fallback would pass the def/diag guards
      const pi = await s.request(
        "projectInfo",
        { file: target.file, needFileNameList: true },
        LOAD_TIMEOUT_MS,
      );
      if (!pi || resolve(pi.configFileName || "") !== CFG)
        fail(`tsserver session project is ${pi && pi.configFileName}, expected ${CFG} at n=${n}`);
      sessionProjectFiles = (pi.fileNames || []).filter((f) =>
        /\/src\/\d{4}\/m\d+\.ts$/.test(f),
      ).length;
      if (sessionProjectFiles !== n)
        fail(`tsserver session project has ${sessionProjectFiles} src files, expected ${n}`);
      colds.push({ coldOpenMs, initMs: null, firstDiagMs });
      if (k === COLD_SAMPLES - 1) lastServer = s;
      else s.kill();
    } catch (e) {
      if (e instanceof BenchFailure) throw e;
      const peak = s.kill();
      return {
        cold: {
          ...classifyDeath("tsserver (cold open)", n, e, s.getStderr()),
          peakRssMB: peak ? Math.round(peak / 1024) : null,
        },
      };
    }
  }

  // warm loop: the same probe set as the tsgo-LSP session through tsserver's own
  // protocol — def / completions / quickinfo, the valid-edit change → sync re-check
  // row, and the squiggle transitions (seeded edit must go red, restore must clear)
  const s = lastServer;
  const warm = { def: [], comp: [], hov: [], change: [], errAppear: [], errClear: [] };
  let compItems = 0;
  let endLine1 = target.text.split("\n").length; // 1-based line of the buffer's trailing empty line
  const typeEdit = (to) =>
    s.notify("change", {
      file: target.file,
      line: line1,
      offset: annIdx + 3,
      endLine: line1,
      endOffset: annIdx + 9,
      insertString: to,
    });
  try {
    for (let k = 0; k < SAMPLES; k++) {
      let t = nowMs();
      const d = await s.request("definition", { file: target.file, line: line1, offset: col1 });
      warm.def.push(nowMs() - t);
      if (!(d && d.length && d[0].file === target.expectedDefFile))
        fail(`tsserver warm definition lost its target at n=${n}`);
      t = nowMs();
      const h = await s.request("quickinfo", { file: target.file, line: line1, offset: col1 });
      warm.hov.push(nowMs() - t);
      if (!(h && String(h.displayString || "").includes(`v${target.j}`)))
        fail(`tsserver warm quickinfo does not name v${target.j} at n=${n}`);
      // valid-edit row: insert a probe const at the end of the buffer, sync re-check.
      // The edit→recheck rows are load-bearing (the recompute IS the measurement):
      // past the 1h ceiling they are a recorded outcome, not a harness fault
      t = nowMs();
      s.notify("change", {
        file: target.file,
        line: endLine1,
        offset: 1,
        endLine: endLine1,
        endOffset: 1,
        insertString: `const __tss_probe_${k} = ${k};\n`,
      });
      endLine1 += 1;
      const dv = await s.request("semanticDiagnosticsSync", { file: target.file }, LOAD_TIMEOUT_MS);
      warm.change.push(nowMs() - t);
      if ((dv || []).length)
        fail(`tsserver change loop reported diagnostics on a valid edit at n=${n}`);
      // squiggle transitions: the sync re-check must FLIP with the edit, both ways
      t = nowMs();
      typeEdit("string");
      const de = await s.request("semanticDiagnosticsSync", { file: target.file }, LOAD_TIMEOUT_MS);
      warm.errAppear.push(nowMs() - t);
      if (!(de || []).some((d2) => d2.code === 2322))
        fail(`tsserver seeded change did not surface TS2322 at n=${n}`);
      t = nowMs();
      typeEdit("number");
      const dr = await s.request("semanticDiagnosticsSync", { file: target.file }, LOAD_TIMEOUT_MS);
      warm.errClear.push(nowMs() - t);
      if ((dr || []).length) fail(`tsserver change restore did not go clean at n=${n}`);
    }
    // completion LAST, symmetric with the tsgo driver: a timeout is the probe's
    // recorded outcome, and the session is torn down right after either way
    try {
      for (let k = 0; k < SAMPLES; k++) {
        const t = nowMs();
        // completionInfo, not the legacy `completions` command: on TS 6 the legacy
        // command returns success with an EMPTY array — a 15ms no-op that would post
        // as a fast completion (caught by the item-count control below)
        const c = await s.request("completionInfo", {
          file: target.file,
          line: line1,
          offset: col1,
        });
        warm.comp.push(nowMs() - t);
        compItems = (c && c.entries ? c.entries : []).length;
        if (compItems === 0)
          fail(
            `tsserver completionInfo returned 0 entries at n=${n} — a vacuous probe cannot post a time`,
          );
      }
    } catch (ce) {
      if (!ce || ce.timedOut !== true) throw ce;
      warm.compTimedOut = true;
    }
  } catch (e) {
    if (e instanceof BenchFailure) throw e;
    const peak = s.kill();
    return {
      cold: summarizeColds(colds),
      warmLoop: classifyDeath("tsserver (warm loop)", n, e, s.getStderr()),
      peakRssMB: peak ? Math.round(peak / 1024) : null,
    };
  }
  const peak = s.kill();
  return {
    cold: summarizeColds(colds),
    warm: {
      defMs: median(warm.def),
      completionMs: warm.compTimedOut
        ? { timedOut: true, ceilingMs: REQ_TIMEOUT_MS }
        : median(warm.comp),
      hoverMs: median(warm.hov),
      didChangeCheckMs: median(warm.change),
      errorAppearsMs: median(warm.errAppear),
      errorClearsMs: median(warm.errClear),
      samples: SAMPLES,
      completionItems: compItems,
    },
    sessionProjectFiles,
    peakRssMB: peak ? Math.round(peak / 1024) : null,
  };
}

// ---- watch drivers ---------------------------------------------------------------------------
// both watchers speak tsc's watch banner: "Found N errors. Watching for file changes."
// --preserveWatchOutput keeps the stream append-only (no screen clears to parse around)
const FOUND_RE = /Found (\d+) errors?\. Watching for file changes\./g;

function startWatcher(cmdLabel, bin, args, env) {
  const proc = spawn(bin, args, { cwd: DIR, stdio: ["ignore", "pipe", "pipe"], env });
  liveKids.add(proc);
  const rss = startRssSampler(proc.pid);
  let out = "";
  let seen = 0; // count of Found-banners already consumed
  let stderr = "";
  let dead = null;
  const pending = [];
  const drain = () => {
    FOUND_RE.lastIndex = 0;
    const all = [...out.matchAll(FOUND_RE)];
    while (pending.length && all.length > seen) {
      const m = all[seen++];
      const { resolve, timer } = pending.shift();
      clearTimeout(timer);
      resolve(Number(m[1]));
    }
  };
  proc.stdout.on("data", (d) => {
    out += d.toString();
    drain();
  });
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  proc.on("exit", (code, signal) => {
    dead = { code, signal };
    for (const { reject, timer } of pending) {
      clearTimeout(timer);
      reject(Object.assign(new Error(`${cmdLabel} exited code=${code} signal=${signal}`), dead));
    }
    pending.length = 0;
  });
  // resolves with the error count of the NEXT Found-banner after this call
  const nextFound = (timeoutMs) =>
    new Promise((resolve, reject) => {
      if (dead) return reject(Object.assign(new Error(`${cmdLabel}: watcher already dead`), dead));
      const timer = setTimeout(() => {
        const i = pending.findIndex((p) => p.timer === timer);
        if (i !== -1) pending.splice(i, 1);
        reject(
          Object.assign(new Error(`${cmdLabel}: no completion banner in ${timeoutMs}ms`), {
            timedOut: true,
            loadBearing: timeoutMs >= LOAD_TIMEOUT_MS,
          }),
        );
      }, timeoutMs);
      pending.push({ resolve, reject, timer });
      drain();
    });
  const kill = () => {
    const peak = rss.stop();
    liveKids.delete(proc);
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
    return peak;
  };
  return {
    proc,
    nextFound,
    kill,
    getDead: () => dead,
    getStderr: () => stderr,
    getOut: () => out,
    getSeen: () => seen,
  };
}

// one watcher session per checker per point: first build, seeded-error control cycle,
// then SAMPLES one-edit rechecks (each a fresh probe const appended to the target
// module, restored at the end). The recheck-vs-firstBuild ratio is the finding: tsc
// --watch rechecks affected files (TS 3.8), tsgo --watch is a rebuild prototype.
async function benchWatch(label, bin, args, env, n) {
  const target = pickTarget(n);
  const original = target.text;
  const w = startWatcher(label, bin, args, env);
  const restore = () => writeFileSync(target.file, original);
  try {
    const t0 = nowMs();
    const firstCount = await w.nextFound(LOAD_TIMEOUT_MS);
    const firstBuildMs = nowMs() - t0;
    if (firstCount !== 0)
      fail(`${label} first build found ${firstCount} errors on the clean corpus at n=${n}`);

    // positive control INSIDE the session: seeded error must flip the banner nonzero, restore flips back
    writeFileSync(target.file, seededText(target));
    const seededCount = await w.nextFound(LOAD_TIMEOUT_MS);
    restore();
    const restoredCount = await w.nextFound(LOAD_TIMEOUT_MS);
    if (seededCount < 1) fail(`${label} watch control: seeded error not reported at n=${n}`);
    if (restoredCount !== 0) fail(`${label} watch control: restore did not go clean at n=${n}`);

    const rechecks = [];
    for (let k = 0; k < SAMPLES; k++) {
      writeFileSync(target.file, original + `const __watch_probe_${k} = ${k};\n`);
      const t = nowMs();
      const count = await w.nextFound(LOAD_TIMEOUT_MS);
      rechecks.push(nowMs() - t);
      if (count !== 0)
        fail(`${label} recheck sample ${k} found ${count} errors on a valid edit at n=${n}`);
    }
    restore();
    await w.nextFound(LOAD_TIMEOUT_MS); // consume the restore's recheck before killing
    // banner reconciliation: a watcher that recompiles twice for one write leaves a
    // surplus banner that resolves the NEXT wait instantly and corrupts
    // oneEditRecheckMs — every banner produced must be one the protocol consumed.
    // The settle window lets a trailing duplicate of the final restore surface first.
    await new Promise((r) => setTimeout(r, 2000));
    FOUND_RE.lastIndex = 0;
    const produced = [...w.getOut().matchAll(FOUND_RE)].length;
    const consumed = w.getSeen(); // 4 + SAMPLES: first build, seeded, restore, rechecks, final restore
    if (consumed !== 4 + SAMPLES || produced !== consumed)
      fail(
        `${label} banner accounting at n=${n}: produced ${produced}, consumed ${consumed}, ` +
          `expected ${4 + SAMPLES} — a duplicate recompile would misattribute the recheck timings`,
      );
    const peak = w.kill();
    return {
      firstBuildMs,
      oneEditRecheckMs: median(rechecks),
      recheckSamples: SAMPLES,
      peakRssMB: peak ? Math.round(peak / 1024) : null,
    };
  } catch (e) {
    restore();
    if (e instanceof BenchFailure) {
      w.kill();
      throw e;
    }
    const peak = w.kill();
    return {
      ...classifyDeath(label, n, e, w.getStderr()),
      phase: "watch",
      outTail: w.getOut().slice(-300),
      peakRssMB: peak ? Math.round(peak / 1024) : null,
    };
  }
}

// ---- program completeness gate (batch --listFiles, same strength as tsgo-scale-bench) -------
const listFilesCount = (bin, isNode) => {
  const r = isNode
    ? spawnSync(bin, ["-p", CFG, "--listFiles"], {
        cwd: DIR,
        encoding: "utf8",
        maxBuffer: 1 << 30,
        env: nodeEnv,
      })
    : spawnSync(bin, ["-p", CFG, "--listFiles"], {
        cwd: DIR,
        encoding: "utf8",
        maxBuffer: 1 << 30,
      });
  if (r.status !== 0 && r.status !== 2)
    fail(`--listFiles probe exited ${r.status} (signal ${r.signal})`);
  return ((r.stdout || "").match(/\/src\/\d{4}\/m\d+\.ts$/gm) || []).length;
};

// ---- versions + sweep -------------------------------------------------------------------------
const tsgoVersion = spawnSync(TSGO, ["--version"], { encoding: "utf8" }).stdout.trim();
const tscVersion = spawnSync(TSC, ["--version"], { encoding: "utf8" }).stdout.trim();

const results = [];
const isCanonical =
  POINTS.join(" ") === CANONICAL_POINTS &&
  SAMPLES === 3 &&
  COLD_SAMPLES === 2 &&
  LAYERS === 100 &&
  TSSERVER_ANCHOR_MAX === 100000 &&
  WORK === "/mnt/fcvm-btrfs/lsp-scale-bench";
// record protection (benchOutput): per-point progress only ever writes the gitignored
// partial; the canonical file is written on COMPLETION of a canonical sweep, which
// removes the partial — a mid-sweep death can never truncate the data of record
const output = benchOutput(
  REPO,
  "bench/lsp-scale-bench.partial.json",
  isCanonical ? "bench/lsp-scale-bench.json" : "bench/lsp-scale-bench.partial.json",
);

const meta = () => ({
  generatedAt: new Date().toISOString(),
  points: POINTS,
  samples: SAMPLES,
  coldSamples: COLD_SAMPLES,
  layers: LAYERS,
  tsserverAnchorMax: TSSERVER_ANCHOR_MAX,
  cores: CORES,
  preRunLoadAvg1: envInfo.preRunLoadAvg1,
  tsgoVersion,
  tsgoInvocation,
  tscVersion,
  nodeHeap: NODE_HEAP,
  corpusShape: `layered, depth fixed at ${LAYERS} — mirrors bench/tsgo-scale-bench.json module-for-module (TS dialect), so rows are comparable across the two benches`,
  lspMechanicNote:
    "tsgo --lsp is a PULL-diagnostics OPEN-FILE server: diagnostics are computed per open buffer on request; there is no whole-project verdict over LSP — workspace/diagnostic is milestoned Post-7.0 upstream (microsoft/typescript-go#2169; PR #4486 closed unmerged 2026-07-02). The headline squiggle rows are the asserted transitions errorAppearsMs/errorClearsMs (didChange to a seeded TS2322 must pull red, the restore must pull clean — timed recomputes, so a no-op or stale report cannot post a number); didChangePullMs is the valid-edit path. tsserver runs the same three rows through its own channel (change → semanticDiagnosticsSync, recorded as didChangeCheckMs + the same transition keys).",
  sessionProgramNote:
    "program size is gated in-session, not only in batch: every timed tsserver session must report the corpus tsconfig with exactly n src files via projectInfo(needFileNameList); a tsgo session fails on any pushed TS5xxx config diagnostic and its cold def must resolve into the exact imported module file.",
  watchMechanicNote:
    "tsgo --watch is upstream's 'prototype' (rebuilds, no incremental rechecking); tsc --watch re-checks the changed file + transitive dependents on a warm program (TS 3.8 semantics). oneEditRecheckMs includes the watcher's own change-detection latency — that is the developer-visible number. Watch rows parse the 'Found N errors. Watching for file changes.' banner under --preserveWatchOutput.",
  anchorNote: `tsserver and tsc --watch stop at ${TSSERVER_ANCHOR_MAX} (the JS substrate's anchor cutoff, matching tsgo-scale-bench's TSC_ANCHOR_MAX default); tsgo rows run the full sweep`,
});
const persist = () => output.persist({ meta: meta(), results });

for (const n of POINTS) {
  console.log(`\n== ${n.toLocaleString("en-US")} modules ==`);
  const genMs = growCorpus(n);
  console.log(`  corpus at ${n.toLocaleString("en-US")} modules (+${genMs}ms generation)`);
  const rec = { modules: n, genMs, loadAvg1: load1Now() };

  // completeness gate: the program must be exactly n src files before anything is timed
  const tsgoCount = listFilesCount(TSGO, false);
  if (tsgoCount !== n) fail(`tsgo program has ${tsgoCount} src files at n=${n}`);

  // per-driver isolation: one driver's assert/gate failure is ITS recorded outcome —
  // the other drivers' curves at this and later points must survive it
  const driver = async (label, fn) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof BenchFailure) {
        console.log(
          `  ${label} FAILED at ${n.toLocaleString("en-US")}: ${e.message.slice(0, 200)}`,
        );
        return { failed: e.message.slice(0, 600) };
      }
      throw e;
    }
  };
  rec.tsgoLsp = await driver("tsgo lsp", () => benchTsgoLsp(n));
  show("tsgo lsp", rec.tsgoLsp);

  if (n <= TSSERVER_ANCHOR_MAX) {
    const tscCount = listFilesCount(TSC, true);
    if (tscCount !== n) fail(`tsc program has ${tscCount} src files at n=${n}`);
    rec.tsserver = await driver("tsserver", () => benchTsserver(n));
    show("tsserver", rec.tsserver);
  } else rec.tsserver = { skipped: `anchor cutoff (> ${TSSERVER_ANCHOR_MAX})` };

  rec.tsgoWatch = await driver("tsgo --watch", () =>
    benchWatch(
      "tsgo --watch",
      TSGO,
      ["--watch", "-p", CFG, "--preserveWatchOutput"],
      process.env,
      n,
    ),
  );
  show("tsgo --watch", rec.tsgoWatch);

  if (n <= TSSERVER_ANCHOR_MAX) {
    rec.tscWatch = await driver("tsc --watch", () =>
      benchWatch("tsc --watch", TSC, ["--watch", "-p", CFG, "--preserveWatchOutput"], nodeEnv, n),
    );
    show("tsc --watch", rec.tscWatch);
  } else rec.tscWatch = { skipped: `anchor cutoff (> ${TSSERVER_ANCHOR_MAX})` };

  results.push(rec);
  persist();
}

function show(label, r) {
  if (r.failed) return; // the driver() wrapper already printed the failure
  if (r.skipped) return console.log(`  ${label}: skipped (${r.skipped})`);
  if (r.gate) return console.log(`  ${label}: DIED IN GATE ${JSON.stringify(r.gate)}`);
  if (r.killed || r.cold?.killed)
    return console.log(`  ${label}: DIED ${JSON.stringify(r.cold || r)}`);
  if (r.firstBuildMs !== undefined)
    return console.log(
      `  ${label}: first build ${r.firstBuildMs}ms, one-edit recheck ${r.oneEditRecheckMs}ms, peak RSS ${r.peakRssMB}MB`,
    );
  const c = r.cold || {};
  const w = r.warm || {};
  const edit = w.didChangePullMs ?? w.didChangeCheckMs;
  console.log(
    `  ${label}: cold open ${c.coldOpenMs}ms (first diag ${c.firstDiagMs}ms), warm def ${w.defMs}ms / completion ${typeof w.completionMs === "number" ? `${w.completionMs}ms` : `TIMED OUT >${(w.completionMs?.ceilingMs ?? 0) / 1000}s`} / hover ${w.hoverMs}ms${edit !== undefined ? ` / edit→recheck ${edit}ms` : ""}${w.errorAppearsMs !== undefined ? `, squiggle appear ${w.errorAppearsMs}ms / clear ${w.errorClearsMs}ms` : ""}, peak RSS ${r.peakRssMB}MB${r.watchRegistration ? `, watch registration: ${r.watchRegistration}` : ""}`,
  );
  if (r.warmLoop) console.log(`  ${label}: warm loop DIED ${JSON.stringify(r.warmLoop)}`);
}

output.promote({ meta: meta(), results });
console.log(
  `\n--- bench/lsp-scale-bench${isCanonical ? "" : ".partial"}.json written${isCanonical ? "" : " (non-canonical → partial)"} ---`,
);
