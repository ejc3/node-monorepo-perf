#!/usr/bin/env node
// Renders dependency-free SVG charts + a markdown summary from bench/results.json.
//   node scripts/chart.mjs

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MUTED, ACCENT, GRID, RAMP, rgbCss, txt, svgDoc } from "./_chartstyle.mjs";

// series colors from the shared system: verdict hues off the heat ramp's anchors
// (green = the fast/cached side, red = the cold side, amber = the whole-repo side)
const C_GREEN = rgbCss(RAMP[0][1]);
const C_AMBER = rgbCss(RAMP[1][1]);
const C_RED = rgbCss(RAMP[3][1]);

const ROOT = process.cwd();
const resultsPath = join(ROOT, "bench", "results.json");
if (!existsSync(resultsPath)) {
  console.error("no bench/results.json — run `node scripts/measure.mjs` first");
  process.exit(1);
}
const records = JSON.parse(readFileSync(resultsPath, "utf8")).sort((a, b) => a.apps - b.apps);
const chartsDir = join(ROOT, "bench", "charts");
mkdirSync(chartsDir, { recursive: true });

const fmtMs = (ms) =>
  ms == null ? "—" : ms >= 1000 ? (ms / 1000).toFixed(ms >= 10000 ? 0 : 1) + "s" : ms + "ms";
const fmtBytes = (b) => {
  if (b == null) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0,
    n = b;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return n.toFixed(n >= 100 || i === 0 ? 0 : 1) + u[i];
};
const fmtNum = (n) => (n == null ? "—" : n.toLocaleString("en-US"));

// ---- generic vertical bar chart (drawn with the shared visual system) ----
function barChart({ file, title, subtitle, bars, valueFmt = fmtMs, logScale = false }) {
  const W = 760,
    H = 420,
    padL = 70,
    padR = 24,
    padT = 86,
    padB = 90;
  const plotW = W - padL - padR,
    plotH = H - padT - padB;
  const vals = bars.map((b) => b.value ?? 0);
  const maxV = Math.max(1, ...vals);
  const scale = (v) => {
    if (!logScale) return (v / maxV) * plotH;
    const lv = Math.log10(Math.max(1, v)),
      lm = Math.log10(Math.max(10, maxV));
    return (lv / lm) * plotH;
  };
  const n = bars.length;
  const gap = 18;
  const bw = Math.min(120, (plotW - gap * (n + 1)) / n);
  const T = [];
  T.push(txt(padL, 34, title, { size: 18, weight: "700" }));
  if (subtitle) T.push(txt(padL, 54, subtitle, { size: 12.5, fill: MUTED }));
  T.push(
    `<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="${GRID}"/>`,
  );
  bars.forEach((b, i) => {
    const h = Math.max(2, scale(b.value ?? 0));
    const x = padL + gap + i * (bw + gap);
    const y = padT + plotH - h;
    T.push(`<rect x="${x}" y="${y}" width="${bw}" height="${h}" rx="4" fill="${b.color}"/>`);
    T.push(
      txt(x + bw / 2, y - 8, valueFmt(b.value), { size: 13, weight: "600", anchor: "middle" }),
    );
    String(b.label)
      .split("\n")
      .forEach((ln, k) => {
        T.push(
          txt(x + bw / 2, padT + plotH + 22 + k * 16, ln, {
            size: 12,
            fill: MUTED,
            anchor: "middle",
          }),
        );
      });
  });
  writeFileSync(
    join(chartsDir, file),
    svgDoc(W, H, `${title}${subtitle ? ` — ${subtitle}` : ""}`, T),
  );
  return file;
}

// ---- line chart (metric vs scale) ----
function lineChart({ file, title, subtitle, series, xs, yFmt = fmtMs }) {
  const W = 760,
    H = 420,
    padL = 78,
    padR = 24,
    padT = 86,
    padB = 70;
  const plotW = W - padL - padR,
    plotH = H - padT - padB;
  const allY = series.flatMap((s) => s.points.map((p) => p)).filter((v) => v != null);
  const maxY = Math.max(1, ...allY);
  const maxX = Math.max(...xs);
  const sx = (x) => padL + (x / maxX) * plotW;
  const sy = (y) => padT + plotH - (y / maxY) * plotH;
  const T = [];
  T.push(txt(padL, 34, title, { size: 18, weight: "700" }));
  if (subtitle) T.push(txt(padL, 54, subtitle, { size: 12.5, fill: MUTED }));
  T.push(
    `<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="${GRID}"/>`,
  );
  T.push(`<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="${GRID}"/>`);
  xs.forEach((x) => {
    T.push(txt(sx(x), padT + plotH + 22, fmtNum(x), { size: 12, fill: MUTED, anchor: "middle" }));
  });
  series.forEach((s) => {
    // break the line at missing points instead of joining straight across the gap
    const coords = s.points.map((y, i) => (y == null ? null : `${sx(xs[i])},${sy(y)}`));
    let seg = [];
    const flush = () => {
      if (seg.length)
        T.push(
          `<polyline points="${seg.join(" ")}" fill="none" stroke="${s.color}" stroke-width="2.5"/>`,
        );
      seg = [];
    };
    for (const c of coords) {
      if (c) seg.push(c);
      else flush();
    }
    flush();
    s.points.forEach((y, i) => {
      if (y == null) return;
      T.push(`<circle cx="${sx(xs[i])}" cy="${sy(y)}" r="4" fill="${s.color}"/>`);
      const lx = Math.min(sx(xs[i]), W - padR - 26);
      T.push(txt(lx, sy(y) - 10, yFmt(y), { size: 11, anchor: "middle" }));
    });
  });
  // legend
  series.forEach((s, i) => {
    const lx = W - padR - 160,
      ly = padT + 6 + i * 20;
    T.push(`<rect x="${lx}" y="${ly - 10}" width="12" height="12" rx="3" fill="${s.color}"/>`);
    T.push(txt(lx + 18, ly, s.name, { size: 12, fill: MUTED }));
  });
  writeFileSync(
    join(chartsDir, file),
    svgDoc(W, H, `${title}${subtitle ? ` — ${subtitle}` : ""}`, T),
  );
  return file;
}

// measure.mjs appends, so a re-measured sweep can land on top of rows from an older
// toolchain (or another box). The charts and summary.md present the rows as ONE
// series, so every row in the file must name the same pnpm (`versions.pnpm`, probed
// per run). An un-versioned or differently-versioned row fails here, as does an
// empty record (nothing to chart).
const pnpmVersions = [...new Set(records.map((r) => r.versions?.pnpm ?? "(unrecorded)"))];
if (pnpmVersions.length !== 1 || pnpmVersions[0] === "(unrecorded)") {
  console.error(
    records.length
      ? `[chart] ERROR: bench/results.json rows span pnpm versions [${pnpmVersions.join(", ")}] — ` +
          `one series needs one recorded toolchain; drop the superseded rows.`
      : "[chart] ERROR: bench/results.json has no rows.",
  );
  process.exit(1);
}
const PNPM_VERSION = pnpmVersions[0];
// One sweep means one row per scale: a second row for a label (measure.mjs appended a
// re-run) is rejected rather than silently shadowing the first — which measurement is
// the record is a deliberate edit of results.json, not a side effect of row order.
const labels = records.map((r) => r.label);
const dupLabels = [...new Set(labels.filter((l, i) => labels.indexOf(l) !== i))];
if (dupLabels.length) {
  console.error(
    `[chart] ERROR: bench/results.json has more than one row for [${dupLabels.join(", ")}] — ` +
      `keep one row per scale.`,
  );
  process.exit(1);
}
const all = [...records].sort((a, b) => a.apps - b.apps);
const big = all[all.length - 1];

const made = [];

// Chart 1: typecheck cold vs warm for the largest scale that RAN the whole-workspace
// typecheck (sweep.mjs skips it at its top scale, so the largest row can carry no
// typecheck phase at all). Only chart a fully verified, warmup-isolated datapoint:
// cold+warm ran OK, the daemon warmup is confirmed (warmupOk === true), and both
// timings are finite. Pre-warmup results lack warmupOk and are confounded by daemon
// spin-up, so they're skipped. A row whose typecheck ran but is unverified is NOT
// passed over for a smaller scale: the chart is skipped (a hard failure under
// CHART_STRICT) rather than silently charting a different scale.
// The title names the mechanism (turbo-orchestrated tsc): presenting this as THE
// whole-workspace typecheck cost would mislead now that the README table shows the
// recommended whole-program tsgo checking the same tree in ~1s, so the subtitle
// carries that number when the tsgo dataset has the matching scale point.
const tcRec = [...all].reverse().find((r) => r.phases?.typecheck);
const tcBig = tcRec?.phases?.typecheck;
if (
  tcBig &&
  tcBig.coldOk === true &&
  tcBig.warmOk === true &&
  tcBig.warmupOk === true &&
  Number.isFinite(tcBig.coldMs) &&
  Number.isFinite(tcBig.warmMs)
) {
  const tsgoTablePath = join(ROOT, "bench", "tsgo-scale-table.json");
  let tsgoNote = "";
  if (existsSync(tsgoTablePath)) {
    const tsgoTable = JSON.parse(readFileSync(tsgoTablePath, "utf8"));
    const tsgoScale = tsgoTable.scales?.find((s) => s.apps === tcRec.apps && s.libs === tcRec.libs);
    if (Number.isFinite(tsgoScale?.coldMedianMs))
      tsgoNote = `; whole-program tsgo: ${fmtMs(tsgoScale.coldMedianMs)} on ${tsgoTable.cores} cores (same generator shape, no cache)`;
  }
  made.push(
    barChart({
      file: "typecheck-cold-vs-warm.svg",
      title: "Whole-workspace typecheck (turbo-orchestrated tsc): cold vs warm cache",
      subtitle: `${fmtNum(tcRec.apps)} apps + ${fmtNum(tcRec.libs)} libs — Turborepo local cache${tsgoNote}`,
      logScale: true,
      bars: [
        { label: "cold\n(first run)", value: tcBig.coldMs, color: C_RED },
        { label: "warm\n(FULL TURBO)", value: tcBig.warmMs, color: C_GREEN },
      ],
    }),
  );
}

// Chart 2: packages built — focused closure vs whole workspace (both measured counts)
const g = big?.phases?.graph;
if (g && g.ok !== false && Number.isFinite(g.focusPackages) && Number.isFinite(g.totalBuildTasks)) {
  made.push(
    barChart({
      file: "focus-vs-full.svg",
      title: "Packages built: focused closure vs whole workspace",
      subtitle: `${g.sampleApp} + closure vs whole workspace — Turborepo --filter`,
      valueFmt: fmtNum,
      bars: [
        {
          label: `focused closure\n(${g.sampleApp})`,
          value: g.focusPackages,
          color: C_GREEN,
        },
        {
          label: "whole workspace",
          value: g.totalBuildTasks,
          color: C_AMBER,
        },
      ],
    }),
  );
}

// Chart 3: lockfile size vs scale (valid regardless of install method: one importer per package)
const lk = all.filter(
  (r) => r.phases?.install?.ok !== false && r.phases?.install?.lockfileLines != null,
);
if (lk.length >= 2) {
  made.push(
    lineChart({
      file: "lockfile-vs-scale.svg",
      title: "Lockfile size vs workspace size",
      subtitle:
        "pnpm-lock.yaml lines vs total workspace packages (apps + libs, one importer each) — O(repo)",
      xs: lk.map((r) => r.apps + r.libs),
      yFmt: fmtNum,
      series: [
        {
          name: "lockfile lines",
          color: ACCENT,
          points: lk.map((r) => r.phases.install.lockfileLines),
        },
      ],
    }),
  );
}

// Charts the docs link must never be deleted just because a confounded/short
// dataset skipped one this run — that would 404 the committed docs. Derive the
// protected set from the docs themselves (matching `charts/<name>.svg`) so it
// stays in sync automatically: a newly doc-linked chart is protected, a retired
// one stops being protected.
const canonical = new Set();
for (const doc of [join(ROOT, "README.md"), join(chartsDir, "..", "summary.md")]) {
  if (!existsSync(doc)) continue;
  for (const m of readFileSync(doc, "utf8").matchAll(/charts\/([A-Za-z0-9_-]+\.svg)/g)) {
    canonical.add(m[1]);
  }
}
// Doc-linked charts produced by a SEPARATE generator, not this script's `made` set: comparison-chart.mjs
// owns tool-comparison.svg. Exempt them from the stale-warning and from deletion so a plain `make chart`
// neither false-warns about a chart it doesn't render nor removes it.
const external = new Set([
  "tool-comparison.svg",
  "checker-scale.svg",
  "cache-network.svg",
  "fleet-gate.svg",
  "fig-sliced-gate.svg",
  "fig-blast-radius.svg",
  "fig-orepo-oclosure.svg",
  "fig-save-loop.svg",
  "fig-freshness-gate.svg",
  "fig-linker-layouts.svg",
  "fig-next-pnp-node.svg",
  "fig-remote-cache.svg",
]);
// Under CHART_STRICT=1 (CI), a doc-linked chart this script owns but did not regenerate
// is a hard failure: keeping the old file would sail through the byte-gate while the
// committed data can no longer produce it. Locally it stays a warning (short/partial
// datasets are normal mid-iteration).
const strict = process.env.CHART_STRICT === "1";
for (const f of canonical) {
  if (!made.includes(f) && !external.has(f)) {
    const msg =
      `${f} was not regenerated this run (insufficient/confounded data) ` +
      `but is still linked by the docs.`;
    if (strict) {
      console.error(`[chart] ERROR (CHART_STRICT): ${msg}`);
      process.exit(1);
    }
    console.warn(`[chart] WARNING: ${msg} Keeping the existing file, which may be STALE.`);
  }
}

// remove only genuinely orphaned SVGs (renamed/removed charts) — never doc-linked or externally-owned ones
for (const f of readdirSync(chartsDir)) {
  if (f.endsWith(".svg") && !made.includes(f) && !canonical.has(f) && !external.has(f)) {
    rmSync(join(chartsDir, f));
  }
}

// ---- markdown summary ----
// The header names only what the record itself carries: the pnpm every row ran
// (asserted uniform above). results.json has no machine fields, and bench/env.json
// describes the 64-core install-family box, not necessarily this record's — so the
// machine is stated once, in the README section the header points at, instead of
// being read from a file that may describe a different box. Nothing here comes from
// the live environment, so summary.md's bytes are identical on any contributor's
// machine and in the CI byte-gate.
let md =
  `# Benchmark results\n\nGenerated from \`bench/results.json\` (pnpm ${PNPM_VERSION}, per each row's ` +
  `\`versions.pnpm\`). The record carries no machine fields; the machine is described in the ` +
  `README's [Results](../README.md#results-scaling-behavior) section.\n\n`;
md += `| scale | gen | install | lockfile | node_modules | typecheck cold | typecheck warm | focus build | full build tasks | focus pkgs | prune |\n`;
md += `|---|---|---|---|---|---|---|---|---|---|---|\n`;
for (const r of all) {
  const p = r.phases;
  md += `| **${fmtNum(r.apps)} apps / ${fmtNum(r.libs)} libs** `;
  md += `| ${!p.gen ? "—" : p.gen.ok === false ? "fail" : fmtMs(p.gen.ms)} `;
  const inst = p.install,
    gr = p.graph,
    tcr = p.typecheck;
  const installOk = inst && inst.ok !== false;
  const graphOk = gr && gr.ok !== false;
  md += `| ${!inst ? "—" : inst.ok === false ? "fail" : fmtMs(inst.ms)} `;
  md += `| ${installOk && inst.lockfileLines ? fmtNum(inst.lockfileLines) + " lines / " + fmtBytes(inst.lockfileBytes) : "—"} `;
  md += `| ${installOk && inst.nmEntries ? fmtNum(inst.nmEntries) + " entries / " + fmtBytes(inst.nmApparentBytes) : "—"} `;
  md += `| ${!tcr ? "—" : tcr.coldOk === false ? "fail" : tcr.warmupOk !== true ? "confounded" : fmtMs(tcr.coldMs)} `;
  md += `| ${!tcr || tcr.coldOk !== true ? "—" : tcr.warmOk === false ? "fail" : fmtMs(tcr.warmMs)} `;
  md += `| ${!p.focus ? "—" : p.focus.ok === false ? "fail" : fmtMs(p.focus.ms)} `;
  md += `| ${graphOk ? fmtNum(gr.totalBuildTasks) : "—"} `;
  md += `| ${graphOk ? fmtNum(gr.focusPackages) : "—"} `;
  md += `| ${!p.prune ? "—" : p.prune.ok === false ? "fail" : fmtMs(p.prune.ms)} |\n`;
}
md += `\n## Charts\n\n` + made.map((f) => `![${f}](charts/${f})`).join("\n\n") + "\n";
writeFileSync(join(ROOT, "bench", "summary.md"), md);

console.log("charts:", made.join(", "));
console.log("summary: bench/summary.md");
console.log("\n" + md);
