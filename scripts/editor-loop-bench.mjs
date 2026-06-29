// editor-loop-bench.mjs — the EDITOR inner loop: tsserver vs tsgo's native LSP, across scale.
//
// Fills the one daily cost the build benches don't capture (LIMITS §5 "Editor / language
// server", gap "tsserver/IDE project-load time + RSS at scale"): when a developer opens the
// monorepo in an editor, what does the language server cost to come alive and to answer the
// keystroke-loop requests (go-to-definition, completion, hover) — and does that cost track the
// whole repo (O(repo)) or just the opened app's dependency closure (O(closure))?
//
// Two servers, head-to-head, on the generated workspace at each scale:
//   - tsserver  — `node typescript/lib/tsserver.js`, the classic server VS Code ships today
//                 (its own Content-Length-framed command protocol).
//   - tsgo LSP  — `tsgo --lsp --stdio`, the native-preview language server (LSP JSON-RPC).
//
// Cross-package resolution is to SOURCE. The generated libs publish their types from `dist`
// (built by `tsc`), which an editor session does not build, so out of the box every `@demo/*`
// import is unresolved (TS2307) — a broken editor, not a measurement. This bench instead
// configures the workspace the way a monorepo gets instant cross-package navigation WITHOUT a
// build step: it maps `@demo/*` to `packages/*/src` via tsconfig `paths` (the "internal
// packages → source" / Just-in-Time setup, the same mapping optimal-gate-bench uses). Opening
// one app then pulls its real dependency-closure SOURCE into the server — the heavy case
// LIMITS §5 describes (real cross-package IntelliSense + memory), not declaration stubs. The
// mapping uses a relative specifier and no `baseUrl` (tsgo removed `baseUrl`), so both servers
// load the same config without option/config errors.
//
// Per server, per scale, opening ONE app's `page.tsx` (which imports several libs):
//   - coldOpenMs       — the like-for-like "felt cold open": time from process spawn to the
//                        FIRST definition response, INCLUDING runtime/handshake startup, so the
//                        two servers are measured from the same logical point. tsserver has no
//                        separate handshake (open is dispatched right after spawn, the def reply
//                        waits for the project to load), so its spawn→def IS coldOpenMs. tsgo
//                        does an LSP `initialize` handshake first, so its spawn→def is
//                        initMs + (didOpen→def); that sum is the comparable coldOpenMs, and the
//                        post-handshake didOpen→def is also recorded (coldOpenPostInitMs) for
//                        context. Median of EDITOR_COLD_SAMPLES fresh-process runs.
//   - loadMs           — tsserver's projectLoadingFinish signal, median (context; tsgo has none).
//   - peakRssMB        — VmHWM of the server process tree, sampled CONTINUOUSLY (setInterval) for
//                        the process lifetime; reported as the max observed across cold samples.
//   - warm def/completion/hover — median of EDITOR_SAMPLES repeats after a warm-up of each op.
//                        Completion is NOT a like-for-like latency race (the servers return
//                        different completion-set sizes at the same position; item counts are
//                        recorded), so its latency is reported with its item count, not as a
//                        winner (completionComparable:false).
//   - closure          — tsserver's loaded project file list (authoritative): the project
//                        tsconfig, its total file count, and the SORTED list of distinct libs
//                        reachable from the opened app. This IS the closure the editor loads.
//
// Two sweeps establish O(closure) from both sides (CLAUDE.md fairness: a positive control, not
// just a negative one):
//   - APPS sweep   (libs fixed, app count growing; opens a FIXED app index so its dependency
//                   closure is byte-identical, asserted): cost flat as the repo grows ⇒ NOT
//                   O(repo). appDeps(i) depends only on i and the lib graph, not the app count.
//   - CLOSURE sweep (app count fixed, libs growing so the opened app's closure grows): cost
//                   RISES with the closure ⇒ the cost IS the closure (O(closure)). This is the
//                   positive control that upgrades "not O(repo)" to "O(closure)".
//
// Discipline (per CLAUDE.md "Measurement methodology"):
//   - Cold is cold: a fresh server process per cold sample; the FIRST request after open pays
//     the full project load. EDITOR_COLD_SAMPLES runs, true median. A run with fewer than 3
//     cold samples / 3 warm samples, or non-default scales, is a SMOKE run — it is written to
//     editor-loop-bench.partial.json and never overwrites the canonical dataset.
//   - Never let a failure read as success: the cold definition must resolve to the EXACT
//     expected lib source file (packages/<imported lib>/src/index.ts — an UNRESOLVED import
//     resolves to the import statement itself, the bug a naive "0 locations" check misses); the
//     opened file must have ZERO fatal diagnostics (cannot-find-module / no-exported-member /
//     any config error), fetched via each server's REAL diagnostics channel and asserted to
//     have actually arrived (tsserver semanticDiagnosticsSync; tsgo is a PULL-diagnostics
//     server, so its diagnostics come from a textDocument/diagnostic request — relying on a
//     publishDiagnostics push would be vacuous because tsgo does not push for the opened file);
//     and every warm hover must return content that names the symbol. Any of these throws.
//     Residual non-fatal diagnostic codes (e.g. TS7026 JSX-intrinsic) are recorded, not hidden.
//   - Like-for-like: same workspace, same target file, same probe positions, same request set
//     for both servers; coldOpen is the same spawn→first-definition window both sides.
//   - Deps present: `pnpm install` per scale so the editor session has node_modules as it would
//     in real life (the `@demo/*` closure resolves via tsconfig paths, independent of install).
//   - Load-guarded: tsgo is parallel, so the box must be quiet (refuse if 1-min loadavg >
//     cores/2 unless EDITOR_ALLOW_BUSY=1); cores + per-scale loadavg recorded.
//
// Destructive: regenerates the (gitignored) apps/packages tree, runs `pnpm install` per scale,
// and patches the tracked tsconfig.base.json (paths→src). It restores tsconfig.base.json on
// finally and on a normal/SIGINT/SIGTERM exit, and writes a validated .bench.bak so a hard kill
// (SIGKILL) self-heals on the next run. Run it in a linked git worktree. Writes
// bench/editor-loop-bench.json. Writeup in LIMITS.md ("Editor / language server, measured").

import { spawn, spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import { ensureCleanState } from "./clean-state.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (m) => {
  throw new Error(`[editor-loop] ${m}`);
};

// ---- knobs --------------------------------------------------------------------------------
// APPS sweep: libs FIXED, apps growing — the opened app's closure is identical, only the repo
// grows (the O(repo) negative control). CLOSURE sweep: apps FIXED, libs growing — the closure
// grows (the O(closure) positive control).
const DEFAULT_APPS_SCALES = "500:300 2000:300 4000:300";
const DEFAULT_CLOSURE_SCALES = "2000:100 2000:200 2000:300";
const RAW_APPS_SCALES = (process.env.EDITOR_APPS_SCALES || DEFAULT_APPS_SCALES).trim();
const RAW_CLOSURE_SCALES = (process.env.EDITOR_CLOSURE_SCALES || DEFAULT_CLOSURE_SCALES).trim();
const parseScales = (raw) =>
  raw.split(/\s+/).map((s) => {
    const [apps, libs] = s.split(":").map(Number);
    if (!apps || !libs) fail(`bad scale "${s}" (want apps:libs)`);
    return { apps, libs, label: `${apps}:${libs}` };
  });
const APPS_SCALES = parseScales(RAW_APPS_SCALES);
const CLOSURE_SCALES = parseScales(RAW_CLOSURE_SCALES);
// Measure the union once (dedup by label), then build both sweep views from it.
const ALL_SCALES = [];
const seenLabel = new Set();
for (const sc of [...APPS_SCALES, ...CLOSURE_SCALES]) {
  if (!seenLabel.has(sc.label)) {
    seenLabel.add(sc.label);
    ALL_SCALES.push(sc);
  }
}
const MODULES = +(process.env.EDITOR_MODULES || 8);
const SAMPLES = +(process.env.EDITOR_SAMPLES || 5); // warm latency samples per op
const COLD_SAMPLES = +(process.env.EDITOR_COLD_SAMPLES || 3); // fresh-process cold-open samples
const TARGET_INDEX = +(process.env.EDITOR_TARGET_INDEX || 100); // fixed app index => fixed closure
const LOAD_TIMEOUT_MS = +(process.env.EDITOR_LOAD_TIMEOUT_MS || 240000); // for load-bearing requests
const REQ_TIMEOUT_MS = +(process.env.EDITOR_REQ_TIMEOUT_MS || 60000); // for warm requests

// A run that is not the full default matrix (fewer samples or different scales) is a smoke run
// and must not be recorded as the dataset of record.
// Generator-affecting env vars the bench does NOT pass explicitly (so generate.mjs would read
// them from the environment) — their presence means a non-canonical tree.
const GEN_ENV = ["APP_DEPS", "LIB_DEPS", "LAYERS", "UNIVERSAL", "FRAMEWORK", "SKEW", "VERSIONED"];
const IS_SMOKE =
  COLD_SAMPLES < 3 ||
  SAMPLES < 3 ||
  MODULES !== 8 ||
  TARGET_INDEX !== 100 ||
  RAW_APPS_SCALES !== DEFAULT_APPS_SCALES ||
  RAW_CLOSURE_SCALES !== DEFAULT_CLOSURE_SCALES ||
  GEN_ENV.some((k) => process.env[k] != null);

const TSSERVER = resolve(REPO, "node_modules/typescript/lib/tsserver.js");
const TSGO = resolve(REPO, "node_modules/.bin/tsgo");
const BASE_TSCONFIG = resolve(REPO, "tsconfig.base.json");
const BASE_BAK = BASE_TSCONFIG + ".bench.bak";

// A diagnostic that means the editor session is broken (so a number under it is meaningless):
// cannot-find-module, no-exported-member / not-a-module, or any compiler-option/config error
// (the TS5xxx family — e.g. tsgo rejecting a removed option). Everything else (e.g. TS7026
// JSX-intrinsic, unrelated to cross-package resolution) is recorded but tolerated.
const isFatalDiag = (c) =>
  c === 2307 || c === 2305 || c === 2306 || c === 2613 || c === 2614 || (c >= 5000 && c < 6000);

// ---- helpers ------------------------------------------------------------------------------
const median = (xs) => {
  if (!xs.length) fail("median of empty");
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const rel = (p) => p.replace(REPO + "/", "");
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28, ...opts });
  if (r.status !== 0)
    fail(`${cmd} ${args.join(" ")} exited ${r.status}: ${(r.stderr || "").trim().slice(-400)}`);
  return r.stdout || "";
};

// Peak RSS (kB) of a process tree: VmHWM of pid + all descendants, read from /proc.
const rssTreeKB = (rootPid) => {
  const status = (pid) => {
    try {
      return readFileSync(`/proc/${pid}/status`, "utf8");
    } catch {
      return "";
    }
  };
  const kids = new Map();
  let pids = [];
  try {
    pids = readdirSync("/proc")
      .filter((d) => /^\d+$/.test(d))
      .map(Number);
  } catch {
    return null;
  }
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

// Continuously sample a process tree's peak RSS for its whole lifetime (so the cold-load spike
// and any transient child are caught, not just the moments around requests).
const startRssSampler = (pid) => {
  let max = 0;
  const tick = () => {
    const k = rssTreeKB(pid);
    if (k) max = Math.max(max, k);
  };
  tick();
  const t = setInterval(tick, 150);
  if (t.unref) t.unref();
  return {
    stop: () => {
      tick();
      clearInterval(t);
      return max;
    },
  };
};

// Byte-accurate Content-Length framing (Content-Length is a BYTE count, so parse on a Buffer):
// pulls complete framed JSON messages out of an accumulating buffer. Used by both drivers.
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

// Pick the target page at a FIXED index (so its dependency closure is identical across the APPS
// sweep), plus the imported symbol/module, the usage probe position, and the EXACT lib source
// file the import must resolve to (the precise guard target).
const pickTarget = (index) => {
  const apps = readdirSync(join(REPO, "apps"))
    .filter((d) => d.startsWith("app-"))
    .sort();
  if (apps.length <= index)
    fail(`need > ${index} apps to pick a fixed target index (have ${apps.length})`);
  const app = apps[index];
  const file = join(REPO, "apps", app, "app", "page.tsx");
  if (!existsSync(file)) fail(`target ${file} missing`);
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const importLine = lines.findIndex((l) => /^import\s*\{\s*\w+.*from\s*"@demo\//.test(l));
  if (importLine === -1) fail(`no @demo import in ${file}`);
  const sym = lines[importLine].match(/import\s*\{\s*(\w+)/)[1];
  const mod = lines[importLine].match(/from\s*"(@demo\/[^"]+)"/)[1];
  const expectedDefFile = `packages/${mod.replace("@demo/", "")}/src/index.ts`;
  let usage = null;
  for (let i = importLine + 1; i < lines.length; i++) {
    if (!lines[i].startsWith("import") && lines[i].includes(sym)) {
      usage = { line0: i, col0: lines[i].indexOf(sym) };
      break;
    }
  }
  if (!usage) fail(`no usage of ${sym} in ${file}`);
  return { app, file, text, sym, mod, expectedDefFile, usage };
};

// ---- tsserver driver (one fresh process = one cold sample) --------------------------------
async function runTsserver(target) {
  const proc = spawn("node", [TSSERVER], { cwd: REPO, stdio: ["pipe", "pipe", "pipe"] });
  const rss = startRssSampler(proc.pid);
  let seq = 0;
  const waiters = new Map(); // request_seq -> {resolve, reject}
  const configDiagCodes = []; // codes from configFileDiag events (tsconfig/project config errors)
  let onLoad = null;
  let loadAt = null;
  let stderr = "";
  let dead = null;
  const die = (why) => {
    if (dead) return;
    dead = why;
    for (const { reject } of waiters.values())
      reject(new Error(`tsserver ${why} (stderr: ${stderr.slice(-200)})`));
    waiters.clear();
  };
  proc.on("error", (e) => die(`spawn error: ${e.message}`));
  proc.on("exit", (code, signal) => die(`exited code=${code} signal=${signal}`));
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  proc.stdout.on(
    "data",
    makeFramer((msg) => {
      if (msg.type === "event" && msg.event === "projectLoadingFinish" && onLoad) {
        loadAt = Date.now();
        onLoad();
        onLoad = null;
      }
      if (msg.type === "event" && msg.event === "configFileDiag") {
        // tsconfig/project config errors (e.g. a bad option) arrive here, not in the opened
        // file's semanticDiagnosticsSync — collect them so a config regression is caught too.
        for (const d of msg.body?.diagnostics || []) configDiagCodes.push(Number(d.code));
      }
      if (msg.type === "response" && waiters.has(msg.request_seq)) {
        const { resolve } = waiters.get(msg.request_seq);
        waiters.delete(msg.request_seq);
        resolve(msg);
      }
    }),
  );
  const request = (command, args, timeoutMs = REQ_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      if (dead) return reject(new Error(`tsserver ${command}: process ${dead}`));
      const mySeq = ++seq;
      const timer = setTimeout(() => {
        waiters.delete(mySeq);
        reject(
          new Error(
            `tsserver ${command} timed out after ${timeoutMs}ms (stderr: ${stderr.slice(-200)})`,
          ),
        );
      }, timeoutMs);
      waiters.set(mySeq, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
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
  const notify = (command, args) => {
    seq++;
    proc.stdin.write(JSON.stringify({ seq, type: "request", command, arguments: args }) + "\n");
  };

  const { file } = target;
  const line = target.usage.line0 + 1; // tsserver is 1-based
  const offset = target.usage.col0 + 1;
  const loadPromise = new Promise((res) => (onLoad = res));

  // cold open: open + first definition; the response blocks until the project loads (the load-
  // bearing request, so it gets the long LOAD_TIMEOUT). tOpen is right after spawn, so
  // coldOpenMs is the spawn→first-def "felt" time including node + TS-library startup.
  notify("open", { file });
  const tOpen = Date.now();
  const firstDef = await request("definitionAndBoundSpan", { file, line, offset }, LOAD_TIMEOUT_MS);
  const coldOpenMs = Date.now() - tOpen;
  await Promise.race([loadPromise, new Promise((r) => setTimeout(r, 1000))]);
  const loadMs = loadAt ? loadAt - tOpen : null;
  const defs =
    firstDef.success && firstDef.body && firstDef.body.definitions ? firstDef.body.definitions : [];
  const defTarget = defs.length ? rel(defs[0].file) : null;

  // diagnostics on the opened file (the response itself must succeed — no vacuous empty pass)
  const diag = await request("semanticDiagnosticsSync", { file });
  if (!diag.success || !Array.isArray(diag.body))
    fail(`tsserver: semanticDiagnosticsSync did not return diagnostics (success=${diag.success})`);
  const diagCodes = [...diag.body.map((d) => Number(d.code)), ...configDiagCodes].filter((c) =>
    Number.isFinite(c),
  );

  // warm up each op once (the cold open only warmed definition), then time SAMPLES repeats.
  await request("completionInfo", { file, line, offset, includeExternalModuleExports: false });
  await request("quickinfo", { file, line, offset });
  const warm = { def: [], comp: [], hov: [] };
  let compItems = 0;
  let hoverNonNull = 0;
  let hoverSample = "";
  for (let i = 0; i < SAMPLES; i++) {
    let t = Date.now();
    const d = await request("definitionAndBoundSpan", { file, line, offset });
    warm.def.push(Date.now() - t);
    if (!(d.body && d.body.definitions && d.body.definitions.length))
      fail("tsserver warm definition lost its target");
    t = Date.now();
    const c = await request("completionInfo", {
      file,
      line,
      offset,
      includeExternalModuleExports: false,
    });
    warm.comp.push(Date.now() - t);
    compItems = c.body && c.body.entries ? c.body.entries.length : compItems;
    t = Date.now();
    const q = await request("quickinfo", { file, line, offset });
    warm.hov.push(Date.now() - t);
    if (q.body && q.body.displayString) {
      hoverNonNull++;
      hoverSample = q.body.displayString;
    }
  }

  // authoritative closure: the loaded project's file list
  const pi = await request("projectInfo", { file, needFileNameList: true });
  const project = pi.body && pi.body.configFileName ? rel(pi.body.configFileName) : null;
  const files = (pi.body && pi.body.fileNames ? pi.body.fileNames : []).map(rel);
  const closureLibList = [
    ...new Set(files.map((f) => (f.match(/^packages\/(lib-\d+)\//) || [])[1]).filter(Boolean)),
  ].sort();

  const maxRssKb = rss.stop();
  proc.stdin.end();
  proc.kill("SIGKILL");
  return {
    coldOpenMs,
    loadMs,
    maxRssKb,
    defTarget,
    diagCodes,
    diagSource: "semanticDiagnosticsSync",
    hoverSample,
    project,
    projectFiles: files.length,
    closureLibList,
    warm,
    compItems,
    hoverNonNull,
  };
}

// ---- tsgo LSP driver (one fresh process = one cold sample) --------------------------------
async function runTsgo(target) {
  const proc = spawn(TSGO, ["--lsp", "--stdio"], { cwd: REPO, stdio: ["pipe", "pipe", "pipe"] });
  const rss = startRssSampler(proc.pid);
  let id = 0;
  const waiters = new Map(); // id -> {resolve, reject}
  const pushedDiagCodes = []; // codes from any pushed publishDiagnostics (e.g. tsconfig config errors)
  let stderr = "";
  let dead = null;
  const die = (why) => {
    if (dead) return;
    dead = why;
    for (const { reject } of waiters.values())
      reject(new Error(`tsgo ${why} (stderr: ${stderr.slice(-200)})`));
    waiters.clear();
  };
  proc.on("error", (e) => die(`spawn error: ${e.message}`));
  proc.on("exit", (code, signal) => die(`exited code=${code} signal=${signal}`));
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  const sendRaw = (obj) => {
    const s = JSON.stringify(obj);
    proc.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
  };
  proc.stdout.on(
    "data",
    makeFramer((msg) => {
      if (msg.id !== undefined && msg.method) {
        // server -> client request: answer so the server isn't blocked. workspace/configuration
        // expects an array (one entry per requested item); everything else gets null.
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
        // tsgo does NOT push diagnostics for the opened FILE (those come from the pull request
        // below), but it DOES push config/project errors (e.g. a rejected tsconfig option, TS5xxx)
        // for the tsconfig uri. Collect those so a config regression is still caught.
        for (const d of msg.params?.diagnostics || []) pushedDiagCodes.push(Number(d.code));
      }
    }),
  );
  const request = (method, params, timeoutMs = REQ_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      if (dead) return reject(new Error(`tsgo ${method}: process ${dead}`));
      const myId = ++id;
      const timer = setTimeout(() => {
        waiters.delete(myId);
        reject(
          new Error(
            `tsgo ${method} timed out after ${timeoutMs}ms (stderr: ${stderr.slice(-200)})`,
          ),
        );
      }, timeoutMs);
      waiters.set(myId, {
        resolve: (msg) => {
          clearTimeout(timer);
          if (msg.error)
            reject(new Error(`tsgo ${method} error: ${JSON.stringify(msg.error).slice(0, 200)}`));
          else resolve(msg.result);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      sendRaw({ jsonrpc: "2.0", id: myId, method, params });
    });
  const notify = (method, params) => sendRaw({ jsonrpc: "2.0", method, params });

  const rootUri = pathToFileURL(REPO).href;
  const uri = pathToFileURL(target.file).href;
  const position = { line: target.usage.line0, character: target.usage.col0 }; // 0-based
  const docParams = { textDocument: { uri }, position };
  const locUri = (d) => (d ? d.uri || d.targetUri : null); // Location or LocationLink

  // initialize (a handshake; its time is folded back into the comparable coldOpenMs below). The
  // pull-diagnostics capability is advertised so textDocument/diagnostic is available.
  const tInit = Date.now();
  await request(
    "initialize",
    {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "root" }],
      capabilities: {
        textDocument: {
          hover: {},
          definition: {},
          completion: {},
          diagnostic: { dynamicRegistration: false },
        },
      },
    },
    LOAD_TIMEOUT_MS,
  );
  const initMs = Date.now() - tInit;
  notify("initialized", {});

  // cold open: didOpen + first definition (the load-bearing request, long timeout).
  notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "typescriptreact", version: 1, text: target.text },
  });
  const tOpen = Date.now();
  const firstDef = await request("textDocument/definition", docParams, LOAD_TIMEOUT_MS);
  const coldOpenPostInitMs = Date.now() - tOpen;
  // comparable cold open = spawn→first-def, symmetric with tsserver (includes binary startup,
  // which for tsgo lands inside initMs).
  const coldOpenMs = initMs + coldOpenPostInitMs;
  const defLocs = Array.isArray(firstDef) ? firstDef : firstDef ? [firstDef] : [];
  const defTarget =
    defLocs.length && locUri(defLocs[0]) ? rel(fileURLToPath(locUri(defLocs[0]))) : null;

  // PULL diagnostics for the opened FILE (tsgo implements LSP 3.17 pull diagnostics; it does NOT
  // push file diagnostics, so a publishDiagnostics-based check would be vacuous). Require a FULL
  // report (a first "unchanged" reply carries no items — vacuous), coerce codes to numbers (LSP
  // codes may be strings), and UNION in any pushed config/project codes (TS5xxx on the tsconfig,
  // which tsgo pushes rather than returning in the file report) so a config regression is caught.
  const report = await request(
    "textDocument/diagnostic",
    { textDocument: { uri } },
    LOAD_TIMEOUT_MS,
  );
  if (!report || report.kind !== "full" || !Array.isArray(report.items))
    fail(
      `tsgo: textDocument/diagnostic did not return a FULL report (${JSON.stringify(report).slice(0, 120)}) — guard would be vacuous`,
    );
  const diagCodes = [...report.items.map((i) => Number(i.code)), ...pushedDiagCodes].filter((c) =>
    Number.isFinite(c),
  );

  // warm up each op once, then time SAMPLES repeats.
  await request("textDocument/completion", docParams);
  await request("textDocument/hover", docParams);
  const warm = { def: [], comp: [], hov: [] };
  let compItems = 0;
  let hoverNonNull = 0;
  let hoverSample = "";
  for (let i = 0; i < SAMPLES; i++) {
    let t = Date.now();
    const d = await request("textDocument/definition", docParams);
    warm.def.push(Date.now() - t);
    if (!(Array.isArray(d) ? d.length : d)) fail("tsgo warm definition lost its target");
    t = Date.now();
    const c = await request("textDocument/completion", docParams);
    warm.comp.push(Date.now() - t);
    const items = Array.isArray(c) ? c : c && c.items ? c.items : [];
    compItems = items.length;
    t = Date.now();
    const h = await request("textDocument/hover", docParams);
    warm.hov.push(Date.now() - t);
    const hc =
      h && h.contents
        ? typeof h.contents === "string"
          ? h.contents
          : h.contents.value || JSON.stringify(h.contents)
        : "";
    if (hc) {
      hoverNonNull++;
      hoverSample = hc;
    }
  }

  const maxRssKb = rss.stop();
  proc.stdin.end();
  proc.kill("SIGKILL");
  return {
    coldOpenMs,
    coldOpenPostInitMs,
    initMs,
    maxRssKb,
    defTarget,
    diagCodes,
    diagSource: "textDocument/diagnostic (pull)",
    hoverSample,
    warm,
    compItems,
    hoverNonNull,
  };
}

// Run COLD_SAMPLES fresh processes; assert resolution is real on every run; aggregate.
async function measureServer(name, runOnce, target) {
  const runs = [];
  for (let i = 0; i < COLD_SAMPLES; i++) runs.push(await runOnce(target));
  for (const [i, r] of runs.entries()) {
    if (r.defTarget !== target.expectedDefFile)
      fail(
        `${name}: cold definition of ${target.sym} resolved to ${r.defTarget}, expected ${target.expectedDefFile} ` +
          `(run ${i}) — cross-package resolution is broken or imprecise; refusing to record a meaningless number.`,
      );
    const fatal = r.diagCodes.filter(isFatalDiag);
    if (fatal.length)
      fail(
        `${name}: opened file has fatal diagnostics ${[...new Set(fatal)].join(", ")} (run ${i}) — broken editor session.`,
      );
    if (r.hoverNonNull !== SAMPLES)
      fail(
        `${name}: ${SAMPLES - r.hoverNonNull}/${SAMPLES} warm hovers returned no content (run ${i}) — not a like-for-like hover.`,
      );
    if (!r.hoverSample.includes(target.sym))
      fail(
        `${name}: hover content "${r.hoverSample.slice(0, 60)}" does not name ${target.sym} (run ${i}) — hover not meaningful.`,
      );
    if (!(r.maxRssKb > 0))
      fail(`${name}: peak RSS not captured (run ${i}) — /proc sampling failed.`);
    if (!(r.compItems > 0))
      fail(
        `${name}: completion returned ${r.compItems} items (run ${i}) — degenerate completion, latency would be meaningless.`,
      );
  }
  const first = runs[0];
  const pool = (sel) => runs.flatMap(sel);
  const residual = [...new Set(pool((r) => r.diagCodes))].sort((a, b) => a - b);
  const out = {
    server: name,
    coldOpenMs: Math.round(median(runs.map((r) => r.coldOpenMs))),
    coldOpenSamples: runs.map((r) => r.coldOpenMs),
    peakRssMB: +(Math.max(...runs.map((r) => r.maxRssKb)) / 1024).toFixed(1),
    peakRssSamplesMB: runs.map((r) => +(r.maxRssKb / 1024).toFixed(1)),
    warmDefMs: Math.round(median(pool((r) => r.warm.def))),
    warmCompletionMs: Math.round(median(pool((r) => r.warm.comp))),
    warmHoverMs: Math.round(median(pool((r) => r.warm.hov))),
    completionItems: first.compItems,
    completionComparable: false,
    defTarget: first.defTarget,
    diagSource: first.diagSource,
    residualDiagCodes: residual,
    hoverSample: first.hoverSample,
  };
  if (first.initMs !== undefined) {
    out.initMs = Math.round(median(runs.map((r) => r.initMs)));
    out.coldOpenPostInitMs = Math.round(median(runs.map((r) => r.coldOpenPostInitMs)));
  }
  if (first.loadMs !== undefined) {
    const lm = runs.map((r) => r.loadMs).filter((x) => x != null);
    out.loadMs = lm.length ? Math.round(median(lm)) : null;
    out.project = first.project;
    out.projectFiles = first.projectFiles;
    out.closureLibList = first.closureLibList;
    out.distinctLibsInClosure = first.closureLibList.length;
  }
  return out;
}

// ---- driver -------------------------------------------------------------------------------
const ver = (cmd, args) => {
  try {
    return spawnSync(cmd, args, { cwd: REPO, encoding: "utf8" }).stdout.trim().split("\n")[0];
  } catch {
    return null;
  }
};

// Patch tsconfig.base.json so `@demo/*` resolves to lib SOURCE (the build-free, instant-nav
// editor setup): a relative specifier, no baseUrl (tsgo removed baseUrl). Writes a validated
// .bench.bak of the original (atomically) so a hard kill self-heals next run; restores on
// finally + normal/SIGINT/SIGTERM.
function patchBaseTsconfig() {
  if (existsSync(BASE_BAK)) {
    // a prior run was hard-killed before restore: the bak holds the ORIGINAL. Use it only if it
    // parses as the expected tsconfig; otherwise refuse rather than clobber the tracked file.
    const baktext = readFileSync(BASE_BAK, "utf8");
    try {
      JSON.parse(baktext);
    } catch {
      fail(
        `stale ${BASE_BAK} does not parse as JSON; restore tsconfig.base.json by hand before re-running.`,
      );
    }
    writeFileSync(BASE_TSCONFIG, baktext);
    rmSync(BASE_BAK, { force: true });
  }
  const original = readFileSync(BASE_TSCONFIG, "utf8");
  JSON.parse(original); // must be valid before we touch it
  const tmp = BASE_BAK + ".tmp";
  writeFileSync(tmp, original);
  renameSync(tmp, BASE_BAK); // atomic backup
  const j = JSON.parse(original);
  j.compilerOptions = j.compilerOptions || {};
  delete j.compilerOptions.baseUrl; // tsgo removed baseUrl (TS5102); relative paths don't need it
  j.compilerOptions.paths = {
    ...(j.compilerOptions.paths || {}),
    "@demo/*": ["./packages/*/src/index.ts"],
  };
  writeFileSync(BASE_TSCONFIG, JSON.stringify(j, null, 2) + "\n");
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      if (existsSync(BASE_BAK)) {
        writeFileSync(BASE_TSCONFIG, readFileSync(BASE_BAK, "utf8"));
        rmSync(BASE_BAK, { force: true });
      }
    } catch {
      /* best-effort */
    }
  };
  process.on("exit", restore);
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

const CORES = os.cpus().length;
const loadGuard = (whenLabel) => {
  const la = os.loadavg()[0];
  if (la > CORES / 2 && process.env.EDITOR_ALLOW_BUSY !== "1")
    fail(
      `box too busy ${whenLabel}: 1-min loadavg ${la.toFixed(2)} > cores/2 (${CORES / 2}). Set EDITOR_ALLOW_BUSY=1 to override.`,
    );
  return +la.toFixed(2);
};

async function main() {
  if (!existsSync(TSSERVER)) fail(`tsserver not found at ${TSSERVER} (pnpm install root deps)`);
  if (!existsSync(TSGO)) fail(`tsgo not found at ${TSGO} (pnpm install root deps)`);

  // Self-heal any tracked file a prior killed run left patched, and REFUSE if another bench is
  // already running in this worktree (benches share apps/.turbo/.gitignore and corrupt each other).
  ensureCleanState(REPO);

  const preRunLoadAvg1 = loadGuard("at startup");
  const restoreBase = patchBaseTsconfig();
  const out = {
    about:
      "Editor inner loop: tsserver vs tsgo's native LSP, across workspace scale, resolving @demo/* to lib SOURCE via tsconfig paths (the build-free 'internal packages -> source' setup). coldOpenMs = spawn -> first definition response, startup-inclusive for both (tsgo folds its initialize handshake in), median of EDITOR_COLD_SAMPLES fresh processes. warm* = median of EDITOR_SAMPLES repeats after a warm-up. peakRssMB = max VmHWM of the server process tree, sampled continuously. Two sweeps: APPS (libs fixed, apps growing, closure identical) shows cost flat = NOT O(repo); CLOSURE (apps fixed, libs growing, closure growing) shows cost rises with the closure = O(closure).",
    config: {
      resolution:
        "@demo/* -> ./packages/*/src/index.ts via tsconfig paths (relative, no baseUrl; build-free source nav)",
      targetAppIndex: TARGET_INDEX,
      coldSamples: COLD_SAMPLES,
      smoke: IS_SMOKE,
      coldOpenMetric:
        "spawn -> first-def, startup-inclusive for both servers (tsgo = initMs + didOpen->def); coldOpenPostInitMs is tsgo's post-handshake portion for context",
      diagnostics:
        "tsserver: semanticDiagnosticsSync (sync, asserted present). tsgo: textDocument/diagnostic pull (asserted a valid report arrived) — tsgo does not push publishDiagnostics for the opened file, so a push-based check would be vacuous.",
      guard:
        "cold def must resolve to the EXACT expected packages/<lib>/src/index.ts; opened file must have 0 fatal diagnostics (2305/2306/2307/2613/2614/TS5xxx config); every warm hover must name the symbol; peak RSS must be captured. completionComparable=false: the servers return different completion-set sizes at the same position, so completion latency is reported with its item count, not as a winner.",
    },
    env: {
      cores: CORES,
      preRunLoadAvg1,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    },
    versions: {
      typescript:
        ver(resolve(REPO, "node_modules/.bin/tsc"), ["--version"]) ||
        ver("node", [TSSERVER, "--version"]),
      tsgo: ver(TSGO, ["--version"]),
    },
    samplesPerOp: SAMPLES,
    modules: MODULES,
    appsScales: APPS_SCALES.map((s) => s.label),
    closureScales: CLOSURE_SCALES.map((s) => s.label),
    scales: [],
  };

  try {
    const byLabel = {};
    for (const sc of ALL_SCALES) {
      console.log(`\n## scale ${sc.label} — generate + install`);
      sh("node", [
        "scripts/generate.mjs",
        "--apps",
        String(sc.apps),
        "--libs",
        String(sc.libs),
        "--modules",
        String(MODULES),
        "--clean",
      ]);
      sh("pnpm", ["install", "--ignore-scripts"], { stdio: ["ignore", "ignore", "pipe"] });
      const scaleLoadAvg1 = loadGuard(`before scale ${sc.label}`);
      const target = pickTarget(TARGET_INDEX);
      console.log(
        `   target: apps/${target.app}/app/page.tsx  symbol=${target.sym} (${target.mod})  pos=${target.usage.line0 + 1}:${target.usage.col0 + 1}`,
      );

      console.log("   tsserver…");
      const tsserver = await measureServer("tsserver", runTsserver, target);
      console.log(
        `     coldOpen=${tsserver.coldOpenMs}ms load=${tsserver.loadMs}ms RSS=${tsserver.peakRssMB}MB closure=${tsserver.distinctLibsInClosure} libs / ${tsserver.projectFiles} files`,
      );

      console.log("   tsgo LSP…");
      const tsgo = await measureServer("tsgo-lsp", runTsgo, target);
      console.log(
        `     coldOpen=${tsgo.coldOpenMs}ms (init ${tsgo.initMs} + postInit ${tsgo.coldOpenPostInitMs}) RSS=${tsgo.peakRssMB}MB`,
      );

      const rec = {
        label: sc.label,
        apps: sc.apps,
        libs: sc.libs,
        scaleLoadAvg1,
        target: `apps/${target.app}/app/page.tsx`,
        symbol: target.sym,
        importedModule: target.mod,
        closureLibs: tsserver.distinctLibsInClosure,
        closureFiles: tsserver.projectFiles,
        closureLibList: tsserver.closureLibList,
        tsserver,
        tsgo,
        coldOpenSpeedup: +(tsserver.coldOpenMs / tsgo.coldOpenMs).toFixed(1),
        rssRatio:
          tsserver.peakRssMB && tsgo.peakRssMB
            ? +(tsserver.peakRssMB / tsgo.peakRssMB).toFixed(1)
            : null,
      };
      byLabel[sc.label] = rec;
      out.scales.push(rec);
    }

    const view = (scales) => scales.map((s) => byLabel[s.label]).filter(Boolean);
    const appsView = view(APPS_SCALES);
    const closureView = view(CLOSURE_SCALES);

    // APPS sweep (negative control): the closure must be IDENTICAL across it (same lib list AND
    // file count), and cost must grow SUBLINEARLY in app count (< app growth) — i.e. not O(repo).
    if (appsView.length >= 2) {
      const refList = JSON.stringify(appsView[0].closureLibList);
      const refFiles = appsView[0].closureFiles;
      for (const s of appsView.slice(1)) {
        if (JSON.stringify(s.closureLibList) !== refList || s.closureFiles !== refFiles)
          fail(
            `APPS sweep: closure not held fixed (${appsView[0].label} vs ${s.label}) — O(repo) control invalid.`,
          );
      }
      const a = appsView[0];
      const b = appsView[appsView.length - 1];
      const appGrowth = +(b.apps / a.apps).toFixed(1);
      const g = (x, y) => +(y / x).toFixed(2);
      const v = {
        appGrowth,
        span: `${a.label} -> ${b.label}`,
        closureLibs: a.closureLibs,
        closureFiles: a.closureFiles,
        tsserver: {
          coldOpenGrowth: g(a.tsserver.coldOpenMs, b.tsserver.coldOpenMs),
          rssGrowth: g(a.tsserver.peakRssMB, b.tsserver.peakRssMB),
        },
        tsgo: {
          coldOpenGrowth: g(a.tsgo.coldOpenMs, b.tsgo.coldOpenMs),
          rssGrowth: g(a.tsgo.peakRssMB, b.tsgo.peakRssMB),
        },
        note: `apps grew ${appGrowth}x with the opened app's closure fixed at ${a.closureLibs} libs / ${a.closureFiles} files. Cold-open/RSS growth << app growth ⇒ the editor loop tracks the closure, not the repo (not O(repo)).`,
      };
      // a growth >= app growth would be O(repo) — fail rather than record a thesis-breaking dataset
      for (const [srv, gr] of [
        ["tsserver", v.tsserver],
        ["tsgo", v.tsgo],
      ]) {
        if (gr.coldOpenGrowth >= appGrowth)
          fail(
            `APPS sweep: ${srv} cold-open grew ${gr.coldOpenGrowth}x vs ${appGrowth}x apps — looks O(repo), not O(closure).`,
          );
      }
      out.appsSweepVerdict = v;
    }

    // CLOSURE sweep (positive control): apps fixed, libs growing. HARD-assert only the
    // measurement-validity invariant — libs grew, so the closure MUST grow (else the sweep is
    // mis-configured). Whether the cost ROSE with the closure is the scientific result: it is
    // RECORDED (cold-open + RSS, smallest vs largest closure) rather than hard-failing the run on
    // single-sample timing noise. The doc claims O(closure) positively only when these held.
    if (closureView.length >= 2) {
      const sorted = [...closureView].sort((a, b) => a.closureFiles - b.closureFiles);
      const small = sorted[0];
      const big = sorted[sorted.length - 1];
      if (!(big.closureFiles > small.closureFiles))
        fail(
          `CLOSURE sweep: closure did not grow with libs (${small.label}=${small.closureFiles} vs ${big.label}=${big.closureFiles} files) — sweep mis-configured.`,
        );
      const coldOpenRoseWithClosure = big.tsserver.coldOpenMs > small.tsserver.coldOpenMs;
      const rssRoseWithClosure = big.tsserver.peakRssMB > small.tsserver.peakRssMB;
      out.closureSweepVerdict = {
        appsFixed: small.apps,
        closureFilesSpan: [small.closureFiles, big.closureFiles],
        coldOpenRoseWithClosure,
        rssRoseWithClosure,
        points: sorted.map((s) => ({
          label: s.label,
          closureLibs: s.closureLibs,
          closureFiles: s.closureFiles,
          tsserverColdOpenMs: s.tsserver.coldOpenMs,
          tsserverRssMB: s.tsserver.peakRssMB,
          tsgoColdOpenMs: s.tsgo.coldOpenMs,
          tsgoRssMB: s.tsgo.peakRssMB,
        })),
        note: `at ${small.apps} apps, the closure grew ${small.closureFiles} -> ${big.closureFiles} files; tsserver cold-open ${small.tsserver.coldOpenMs} -> ${big.tsserver.coldOpenMs}ms (rose=${coldOpenRoseWithClosure}), peak RSS ${small.tsserver.peakRssMB} -> ${big.tsserver.peakRssMB}MB (rose=${rssRoseWithClosure}). Where cost rises with the closure, the editor loop is O(closure), not merely not-O(repo).`,
      };
      if (!coldOpenRoseWithClosure)
        console.log(
          `   [note] closure positive control: tsserver cold-open did not rise across ${small.label}->${big.label} (closure spread ${small.closureFiles}->${big.closureFiles} files may be within timing noise at this scale)`,
        );
    }

    mkdirSync(join(REPO, "bench"), { recursive: true });
    const outFile = IS_SMOKE ? "editor-loop-bench.partial.json" : "editor-loop-bench.json";
    writeFileSync(join(REPO, "bench", outFile), JSON.stringify(out, null, 2) + "\n");
    console.log(
      `\nwrote bench/${outFile} (${out.scales.length} configs${IS_SMOKE ? ", SMOKE — not the dataset of record" : ""})`,
    );
  } finally {
    restoreBase();
  }
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
