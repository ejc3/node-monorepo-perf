// The install-speed text in bench/wave-rollout-bench.json — `speedContext` and the speed
// sentence of `claim` — derived from the measured cells of bench/install-bench.json and
// bench/container-install-bench.json. wave-rollout-bench.mjs measures rollout mechanics,
// not install speed, so its record quotes the install benches; a sentence typed into the
// script outlives the box and toolchain it was written on, so the text is computed here
// instead. wave-rollout-bench.mjs writes `installSpeedContext()` and
// `claimSpeedSentence()` into the record, and comparison-chart.mjs (run in CI) asserts
// the committed record equals the derivation (`assertWaveRolloutSpeedText`), so a change
// to either install record without re-deriving this one fails the chart gate.
//
//   node scripts/_install-speed-context.mjs --write   re-derive those two texts in the
//                                                     committed record, nothing else
//   node scripts/_install-speed-context.mjs           print the derivation
//
// The derivation functions are pure over the two record objects; a missing or
// non-numeric field throws. Which tool is faster, and by how much, is read from the
// cells: no direction is assumed, equal cells are reported as tied, and the wording of
// a margin follows the charts' one near-tie rule (scripts/_chartstyle.mjs), so the
// record and tool-comparison.svg describe the same cell the same way.

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { fmtMult, isFastest, isNearTie, nearTiePct } from "./_chartstyle.mjs";

export const INSTALL_SPEED_SOURCES = [
  "bench/install-bench.json",
  "bench/container-install-bench.json",
];

const need = (v, what) => {
  if (v === undefined || v === null) throw new Error(`install-speed context: missing ${what}`);
  return v;
};
const num = (v, what) => {
  if (typeof need(v, what) !== "number" || !Number.isFinite(v) || v <= 0)
    throw new Error(`install-speed context: ${what} is not a positive number`);
  return v;
};

// A tool version is interpolated into the claim's speed sentence, which is found again
// by its closing ". " — so a version must be one whitespace-free token.
const version = (v, what) => {
  if (typeof need(v, what) !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(v))
    throw new Error(`install-speed context: ${what} is not a single version token`);
  return v;
};

// integer-millisecond rounding (605ms prints 0.61s, not 0.60s): two decimals under 1s
// and one above for the single-sample install cells, two decimals throughout for the
// container medians (their cells differ in the second decimal)
const secs = (ms) =>
  ms < 1000
    ? `${(Math.round(ms / 10) / 100).toFixed(2)}s`
    : `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
const secs2 = (ms) => `${(Math.round(ms / 10) / 100).toFixed(2)}s`;
const apps = (n) => n.toLocaleString("en-US");
const list = (xs) =>
  xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

// A cell against the fastest cell of its comparison, in the charts' vocabulary: tied
// (equal), "+N% vs fastest" within the near-tie band, "×N slower" beyond it.
const tied = (ms, fastestMs) => isFastest(ms / fastestMs);
const behind = (ms, fastestMs) => {
  const mult = ms / fastestMs;
  if (isFastest(mult)) throw new Error("install-speed context: behind() called on a tied cell");
  return isNearTie(mult) ? nearTiePct(mult) : `${fmtMult(mult)} slower`;
};

const HEAD_TO_HEAD = [
  ["bun", "bun"],
  ["pnpmIsolated", "pnpm-isolated"],
  ["pnpmHoisted", "pnpm-hoisted"],
];
const ALL_CONFIGS = ["pnpmIsolated", "pnpmHoisted", "bun", "yarnNm", "yarnPnp"];

// One two-sided comparison: the faster and slower side, or a tie.
const pair = (a, b) => {
  const [fast, slow] = a.ms <= b.ms ? [a, b] : [b, a];
  return { fast, slow, tie: tied(slow.ms, fast.ms) };
};

// Per scale and install state: the three head-to-head cells, which of them are the
// fastest (more than one on a tie), every other cell's distance from the fastest, and
// whether bun is the slowest (or tied slowest) of every measured configuration.
export function installSpeedSummary(install, container) {
  const scales = need(install.scales, "install-bench scales");
  if (!Array.isArray(scales) || !scales.length)
    throw new Error("install-speed context: install-bench has no scales");
  const state = (s, key) => {
    const cell = (k) => num(s[k]?.[key], `install-bench ${s.apps}:${s.libs} ${k}.${key}`);
    const cells = HEAD_TO_HEAD.map(([k, label]) => ({ k, label, ms: cell(k) }));
    const minMs = Math.min(...cells.map((c) => c.ms));
    const fastest = cells.filter((c) => tied(c.ms, minMs));
    const rest = cells.filter((c) => !fastest.includes(c));
    const bun = cells[0];
    const fasterPnpm = cells.slice(1).reduce((a, b) => (b.ms < a.ms ? b : a));
    const all = ALL_CONFIGS.map(cell);
    const maxAll = Math.max(...all);
    return {
      cells,
      minMs,
      fastest,
      rest,
      bunFastest: fastest.includes(bun),
      // how the claim sentence states this point: bun's distance from the fastest, the
      // faster pnpm linker's distance from bun when bun alone is fastest, or a tie
      margin: !fastest.includes(bun)
        ? `bun ${behind(bun.ms, minMs)}`
        : fastest.length > 1
          ? "tied"
          : `the faster pnpm linker ${behind(fasterPnpm.ms, bun.ms)}`,
      bunSlowestOfAll: bun.ms === maxAll,
      slowestTied: all.filter((ms) => ms === maxAll).length > 1,
    };
  };
  const perScale = scales.map((s) => ({
    apps: num(s.apps, "install-bench scale apps"),
    cold: state(s, "coldMs"),
    warm: state(s, "warmMs"),
  }));
  const tc = need(install.trulyCold, "install-bench trulyCold");
  const tools = need(container.tools, "container-install-bench tools");
  const variant = (v) =>
    pair(
      {
        label: "bun",
        ms: num(tools.bun?.[v]?.medianMs, `container-install-bench bun.${v}.medianMs`),
      },
      {
        label: "pnpm",
        ms: num(tools.pnpm?.[v]?.medianMs, `container-install-bench pnpm.${v}.medianMs`),
      },
    );
  return {
    pnpmVersion: version(install.pnpmVersion, "install-bench pnpmVersion"),
    bunVersion: version(install.bunVersion, "install-bench bunVersion"),
    perScale,
    ceilingApps: Math.max(...perScale.map((p) => p.apps)),
    trulyCold: {
      apps: num(tc.apps, "install-bench trulyCold.apps"),
      ...pair(
        { label: "bun", ms: num(tc.bunMs, "install-bench trulyCold.bunMs") },
        {
          label: "pnpm-hoisted",
          ms: num(tc.pnpmHoistedMs, "install-bench trulyCold.pnpmHoistedMs"),
        },
      ),
    },
    container: {
      apps: num(container.scale?.apps, "container-install-bench scale.apps"),
      samples: num(container.samplesPerCell, "container-install-bench samplesPerCell"),
      pnpmVersion: version(container.versions?.pnpm, "container-install-bench versions.pnpm"),
      bunVersion: version(container.versions?.bun, "container-install-bench versions.bun"),
      fresh: variant("freshRunner"),
      cacheRestored: variant("cacheRestored"),
    },
  };
}

const fastestLabel = (st) =>
  st.fastest.length === st.cells.length
    ? "all three tied"
    : st.fastest.length > 1
      ? `${list(st.fastest.map((c) => c.label))} tied fastest`
      : `${st.fastest[0].label} fastest`;
const stateLine = (p, st) =>
  `${apps(p.apps)} apps ${st.cells.map((c) => secs(c.ms)).join(" / ")} — ` +
  [fastestLabel(st), ...st.rest.map((c) => `${c.label} ${behind(c.ms, st.minMs)}`)].join(", ") +
  (st.bunSlowestOfAll
    ? ` (bun is the ${st.slowestTied ? "tied slowest" : "slowest"} of the ${ALL_CONFIGS.length} ` +
      `measured configurations, both yarn linkers included)`
    : "");
const pairLine = (pr, fmt) =>
  pr.tie
    ? `${pr.fast.label} and ${pr.slow.label} tied at ${fmt(pr.fast.ms)}`
    : `${pr.fast.label} ${fmt(pr.fast.ms)} vs ${pr.slow.label} ${fmt(pr.slow.ms)} ` +
      `(${pr.slow.label} ${behind(pr.slow.ms, pr.fast.ms)})`;

// The record's `speedContext` object.
export function installSpeedContext(install, container) {
  const s = installSpeedSummary(install, container);
  const order = HEAD_TO_HEAD.map(([, label]) => label).join(" / ");
  return {
    source: INSTALL_SPEED_SOURCES.join(", "),
    note:
      `Derived from the cited records by scripts/_install-speed-context.mjs; which tool is faster depends on ` +
      `the scale and the install state, and every direction is stated (bench/install-bench.json: pnpm ` +
      `${s.pnpmVersion}, bun ${s.bunVersion}, single-sample cells; "fastest" is among the three listed ` +
      `configurations). ` +
      `COLD install (no lockfile, fresh node_modules, warm store), ${order}: ` +
      `${s.perScale.map((p) => stateLine(p, p.cold)).join("; ")}. ` +
      `WARM (lockfile + store, node_modules removed), same order: ` +
      `${s.perScale.map((p) => stateLine(p, p.warm)).join("; ")}. ` +
      `TRULY-COLD (fresh store + metadata, network) at ${apps(s.trulyCold.apps)} apps: ${pairLine(s.trulyCold, secs)}. ` +
      `CI-runner frozen install in a fresh container (bench/container-install-bench.json: pnpm ` +
      `${s.container.pnpmVersion}, bun ${s.container.bunVersion}, ${apps(s.container.apps)} apps, medians of ` +
      `${s.container.samples}): fresh runner ${pairLine(s.container.fresh, secs2)}; ` +
      `cache-restored ${pairLine(s.container.cacheRestored, secs2)}. ` +
      `Measured ceiling ${apps(s.ceilingApps)} apps.`,
  };
}

// The speed sentence of the record's `claim`: the cold winner per scale (scales grouped
// by winner), the truly-cold pair, and the fresh-container pair, each labelled with its
// own record's tool versions. It opens with CLAIM_SPEED_LEAD and ends at its first ". "
// (no cell renders one and a version is validated as a single token), which is how the
// sentence is found again.
export const CLAIM_SPEED_LEAD = "Install speed, derived from ";
export function claimSpeedSentence(install, container) {
  const s = installSpeedSummary(install, container);
  const groups = [];
  for (const p of s.perScale) {
    const label = list(p.cold.fastest.map((c) => c.label));
    const g = groups.find((x) => x.label === label);
    if (g) g.points.push(p);
    else groups.push({ label, points: [p] });
  }
  const cold = groups
    .map(
      (g) =>
        `${g.label} at ${list(g.points.map((p) => apps(p.apps)))} apps ` +
        `(${list(g.points.map((p) => p.cold.margin))})`,
    )
    .join(", ");
  return (
    `${CLAIM_SPEED_LEAD}${INSTALL_SPEED_SOURCES.join(" + ")} (see speedContext): of bun ${s.bunVersion} ` +
    `and the two pnpm ${s.pnpmVersion} linkers the fastest cold install is ${cold}; truly-cold at ` +
    `${apps(s.trulyCold.apps)} apps ${pairLine(s.trulyCold, secs)}; on the fresh CI frozen container ` +
    `(bun ${s.container.bunVersion}, pnpm ${s.container.pnpmVersion}) ` +
    `${pairLine(s.container.fresh, secs2)}. `
  );
}

export function loadInstallSpeedRecords(repoRoot) {
  const [install, container] = INSTALL_SPEED_SOURCES.map((p) =>
    JSON.parse(readFileSync(join(repoRoot, p), "utf8")),
  );
  return { install, container };
}

// The one speed sentence a claim carries: exactly one CLAIM_SPEED_LEAD, up to and
// including its closing ". ".
export function locateClaimSpeedSentence(claim) {
  const start = claim.indexOf(CLAIM_SPEED_LEAD);
  const end = start < 0 ? -1 : claim.indexOf(". ", start);
  if (start < 0 || end < 0 || claim.indexOf(CLAIM_SPEED_LEAD, start + 1) >= 0)
    throw new Error(
      `bench/wave-rollout-bench.json \`claim\` does not carry exactly one "${CLAIM_SPEED_LEAD}…" sentence`,
    );
  return { start, end: end + 2, sentence: claim.slice(start, end + 2) };
}

const REDERIVE = "re-derive it with `node scripts/_install-speed-context.mjs --write`";

// The committed wave-rollout record must carry exactly the text these records derive:
// the whole `speedContext` object, and the claim's one speed sentence.
export function assertWaveRolloutSpeedText(waveRecord, install, container) {
  const have = need(waveRecord.speedContext, "wave-rollout-bench speedContext");
  if (!isDeepStrictEqual(have, installSpeedContext(install, container)))
    throw new Error(
      "bench/wave-rollout-bench.json `speedContext` is not what scripts/_install-speed-context.mjs " +
        `derives from ${INSTALL_SPEED_SOURCES.join(" + ")} — ${REDERIVE}`,
    );
  const claim = String(need(waveRecord.claim, "wave-rollout-bench claim"));
  if (locateClaimSpeedSentence(claim).sentence !== claimSpeedSentence(install, container))
    throw new Error(
      "bench/wave-rollout-bench.json `claim` does not carry the speed sentence " +
        `scripts/_install-speed-context.mjs derives from ${INSTALL_SPEED_SOURCES.join(" + ")} — ${REDERIVE}`,
    );
}

// --write: replace the two derived texts in the committed record and nothing else. The
// record is re-serialized the way wave-rollout-bench.mjs writes it, so the write first
// proves that serialization reproduces the file byte for byte. The main-module test
// compares real paths, so the CLI also runs when the checkout is reached via a symlink.
const SELF = fileURLToPath(import.meta.url);
const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(SELF);
  } catch {
    return false;
  }
})();
if (isMain) {
  const repo = resolve(dirname(SELF), "..");
  const { install, container } = loadInstallSpeedRecords(repo);
  const context = installSpeedContext(install, container);
  const sentence = claimSpeedSentence(install, container);
  if (!process.argv.includes("--write")) {
    console.log(JSON.stringify({ speedContext: context, claimSpeedSentence: sentence }, null, 2));
  } else {
    const path = join(repo, "bench/wave-rollout-bench.json");
    const raw = readFileSync(path, "utf8");
    const rec = JSON.parse(raw);
    if (JSON.stringify(rec, null, 2) !== raw)
      throw new Error(`${path} does not round-trip byte-identically; refusing to rewrite it`);
    const claim = String(need(rec.claim, "wave-rollout-bench claim"));
    const at = locateClaimSpeedSentence(claim);
    rec.claim = claim.slice(0, at.start) + sentence + claim.slice(at.end);
    rec.speedContext = context;
    const out = JSON.stringify(rec, null, 2);
    if (out === raw) console.log("bench/wave-rollout-bench.json already carries the derived text");
    else {
      writeFileSync(path, out);
      console.log(
        "bench/wave-rollout-bench.json: speedContext + the claim's speed sentence re-derived",
      );
    }
  }
}
