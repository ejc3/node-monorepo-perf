#!/usr/bin/env node
// Renders the scaling charts (SVG + 300 DPI PNG each), their README text alternatives,
// and a markdown summary from bench/results.json.
//   node scripts/chart.mjs

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  MUTED,
  TYPE,
  SERIES,
  MARGIN,
  txt,
  footer,
  logDomain,
  svgDoc,
  linScale,
  logScale,
  plotFrame,
  seriesLine,
  emitChart,
  mdTable,
  mdDetails,
  writeDocBlock,
} from "./_chartstyle.mjs";

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
// seconds to one decimal, the precision the README results table prints
const fmtSec1 = (ms) => `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
const fmtNum = (n) => (n == null ? "—" : n.toLocaleString("en-US"));

// ---- drawing (the shared v2 grammar: real axes, direct labels, the kit's type scale) ----
const W = 680;
const PAD = MARGIN;
const SOURCE = "bench/results.json";

// title + one-line lede, the header every chart here shares; returns the next free y
function header(T, title, lede) {
  T.push(txt(PAD, 30, title, { size: TYPE.title, weight: "650" }));
  if (lede) T.push(txt(PAD, 50, lede, { size: TYPE.lede, fill: MUTED }));
  return lede ? 76 : 56;
}

// round tick step (1/2/5 × 10^k) giving at most `max` intervals over [0, top]
const niceStep = (top, max = 5) => {
  const raw = top / max;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw);
};

// Horizontal bars on a LINEAR axis from zero: bar length is the value, so the
// cold-vs-warm ratio reads at its true size. Value at the bar end, label at the left.
function hBarChart({ name, title, lede, bars, xTitle, valueFmt, sources = SOURCE }) {
  const T = [];
  const top = header(T, title, lede);
  const labelW = 150;
  const x0 = PAD + labelW;
  const plotW = W - x0 - PAD - 64; // room for the value label past the longest bar
  const barH = 26;
  const gap = 14;
  const plotTop = top + 4;
  const plotH = bars.length * barH + (bars.length + 1) * gap;
  const max = Math.max(...bars.map((b) => b.value));
  const step = niceStep(max);
  const xMax = Math.ceil(max / step) * step;
  const sx = linScale(0, xMax, x0, x0 + plotW);
  const ticks = [];
  for (let t = 0; t <= xMax + 1e-9; t += step) ticks.push(t);
  T.push(
    ...plotFrame({
      x: x0,
      y: plotTop,
      w: plotW,
      h: plotH,
      sx,
      sy: () => 0,
      xTicks: ticks,
      xFmt: (t) => (t === 0 ? "0" : fmtMs(t)),
      xTitle,
      grid: "x",
    }),
  );
  bars.forEach((b, i) => {
    const by = plotTop + gap + i * (barH + gap);
    const bw = Math.max(1.5, sx(b.value) - x0);
    T.push(
      `<rect x="${x0}" y="${by}" width="${+bw.toFixed(1)}" height="${barH}" rx="2" fill="${b.color}"/>`,
    );
    T.push(
      txt(x0 + bw + 8, by + barH / 2 + 4.5, valueFmt(b.value), {
        size: TYPE.value,
        weight: "650",
      }),
    );
    T.push(txt(PAD, by + barH / 2 - 1.5, b.label, { size: TYPE.label }));
    if (b.sub) T.push(txt(PAD, by + barH / 2 + 12, b.sub, { size: TYPE.note, fill: MUTED }));
  });
  const fy = plotTop + plotH + 70;
  T.push(...footer(W, fy, sources));
  emitChart(name, svgDoc(W, fy + 14, `${title}. ${lede}`, T));
  return `${name}.svg`;
}

// Log–log scaling chart over workspace size. A named series is labeled directly at its
// last point (no legend); first and last values are printed unless `endLabels: false`.
function scaleChart({ name, title, lede, series, yTitle, sources = SOURCE }) {
  // both axes derive their domain from the plotted points, so no measured point can
  // fall outside the frame (a fixed range would draw a new scale off the canvas)
  const xs = logDomain(series.flatMap((s) => s.points.map(([px]) => px)));
  const ys = logDomain(series.flatMap((s) => s.points.map(([, py]) => py)));
  const [xDomain, xTicks, yDomain, yTicks] = [xs.domain, xs.ticks, ys.domain, ys.ticks];
  const T = [];
  const top = header(T, title, lede);
  const x0 = PAD + 44; // y tick labels sit left of the plot
  const plotTop = top + 28;
  // the right margin holds the direct series labels; a lone series needs none
  const plotW = W - x0 - PAD - (series.some((s) => s.name) ? 150 : 24);
  const plotH = 250;
  const sx = logScale(xDomain[0], xDomain[1], x0, x0 + plotW);
  const sy = logScale(yDomain[0], yDomain[1], plotTop + plotH, plotTop);
  T.push(
    ...plotFrame({
      x: x0,
      y: plotTop,
      w: plotW,
      h: plotH,
      sx,
      sy,
      xTicks,
      yTicks,
      xTitle: "workspace packages (apps + libs), log scale",
      yTitle: `${yTitle}, log scale`,
    }),
  );
  for (const s of series) {
    T.push(...seriesLine(s.points, sx, sy, s.color));
    const measured = s.points.filter(([, py]) => py != null);
    const [fx, fy] = measured[0];
    const [lx, ly] = measured[measured.length - 1];
    // endpoint values, above the line (a flat series carries its range in `sub` instead)
    if (s.endLabels !== false) {
      T.push(txt(sx(fx), sy(fy) - 9, fmtNum(fy), { size: TYPE.note, anchor: "middle" }));
      T.push(txt(sx(lx), sy(ly) - 9, fmtNum(ly), { size: TYPE.note, anchor: "middle" }));
    }
    // direct series label right of the last point (in place of a legend)
    if (s.name)
      T.push(
        txt(sx(lx) + 12, sy(ly) + 4, s.name, { size: TYPE.label, weight: "650" }),
        ...(s.sub ? [txt(sx(lx) + 12, sy(ly) + 18, s.sub, { size: TYPE.note, fill: MUTED })] : []),
      );
  }
  const fy = plotTop + plotH + 74;
  T.push(...footer(W, fy, sources));
  emitChart(name, svgDoc(W, fy + 14, `${title}. ${lede}`, T));
  return `${name}.svg`;
}

// the README text alternative for one chart (the mobile-readable form of its numbers)
const docBlock = (id, head, rows) =>
  writeDocBlock("README.md", id, mdDetails("The chart's numbers as a table", mdTable(head, rows)));

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
// recommended whole-program tsgo checking the same tree in ~1s, so the lede
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
  const scale = `${fmtNum(tcRec.apps)} apps + ${fmtNum(tcRec.libs)} libs`;
  made.push(
    hBarChart({
      name: "typecheck-cold-vs-warm",
      title: "Whole-workspace typecheck, turbo-orchestrated tsc",
      lede: `${scale}, the largest scale the sweep typechecks${tsgoNote}`,
      xTitle: "wall time",
      valueFmt: fmtSec1,
      bars: [
        {
          label: "cold",
          sub: "empty Turborepo cache",
          value: tcBig.coldMs,
          color: SERIES.repo,
        },
        {
          label: "warm",
          sub: "every task a cache hit",
          value: tcBig.warmMs,
          // still the whole workspace (a cache hit, not a scoped run): the lighter neutral
          // slate beside the REPO charcoal, never the closure cyan
          color: SERIES.neutral,
        },
      ],
    }),
  );
  docBlock(
    "typecheck-cold-vs-warm",
    ["scale", "cold", "warm (full cache hit)"],
    [[scale, fmtSec1(tcBig.coldMs), fmtSec1(tcBig.warmMs)]],
  );
}

// the x axis both scaling charts share: workspace packages, log scale
const pkgs = (r) => r.apps + r.libs;

// Chart 2: tasks a build selects — the whole workspace vs one app's closure — at every
// scale (both are measured counts). The largest row must carry a verified graph phase,
// as before; smaller rows without one leave a gap rather than a guessed point.
const g = big?.phases?.graph;
if (g && g.ok !== false && Number.isFinite(g.focusTasks) && Number.isFinite(g.totalBuildTasks)) {
  const graphOk = (r) =>
    r.phases?.graph &&
    r.phases.graph.ok !== false &&
    Number.isFinite(r.phases.graph.focusTasks) &&
    Number.isFinite(r.phases.graph.totalBuildTasks);
  const at = (key) => all.map((r) => [pkgs(r), graphOk(r) ? r.phases.graph[key] : null]);
  const closures = all.filter(graphOk).map((r) => r.phases.graph.focusTasks);
  const closureMin = Math.min(...closures);
  const closureMax = Math.max(...closures);
  made.push(
    scaleChart({
      name: "focus-vs-full",
      title: "Tasks a build selects: whole workspace vs one app's closure",
      lede: "turbo run build, unscoped vs --filter=<app>..., at each measured scale",
      yTitle: "build tasks",
      series: [
        {
          name: "whole workspace",
          sub: "grows with the repo",
          color: SERIES.repo,
          points: at("totalBuildTasks"),
        },
        {
          name: "one app's closure",
          sub: `${closureMin}–${closureMax} tasks at every scale`,
          color: SERIES.scoped,
          endLabels: false,
          points: at("focusTasks"),
        },
      ],
    }),
  );
  docBlock(
    "focus-vs-full",
    ["apps (libs)", "whole-workspace build tasks", "one app's closure"],
    all
      .filter(graphOk)
      .map((r) => [
        `${fmtNum(r.apps)} (${fmtNum(r.libs)})`,
        fmtNum(r.phases.graph.totalBuildTasks),
        `${fmtNum(r.phases.graph.focusTasks)} (${r.phases.graph.sampleApp})`,
      ]),
  );
}

// Chart 3: lockfile size vs scale (valid regardless of install method: one importer per package)
const lk = all.filter(
  (r) => r.phases?.install?.ok !== false && r.phases?.install?.lockfileLines != null,
);
if (lk.length >= 2) {
  made.push(
    scaleChart({
      name: "lockfile-vs-scale",
      title: "Lockfile size vs workspace size",
      lede: "pnpm-lock.yaml lines; one importer per workspace package",
      yTitle: "lockfile lines",
      series: [
        {
          color: SERIES.neutral,
          points: lk.map((r) => [pkgs(r), r.phases.install.lockfileLines]),
        },
      ],
    }),
  );
  docBlock(
    "lockfile-vs-scale",
    ["apps (libs)", "workspace packages", "lockfile lines"],
    lk.map((r) => [
      `${fmtNum(r.apps)} (${fmtNum(r.libs)})`,
      fmtNum(pkgs(r)),
      fmtNum(r.phases.install.lockfileLines),
    ]),
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

// remove only genuinely orphaned SVGs (renamed/removed charts) and their PNG rasters —
// never doc-linked or externally-owned ones
for (const f of readdirSync(chartsDir)) {
  if (f.endsWith(".svg") && !made.includes(f) && !canonical.has(f) && !external.has(f)) {
    rmSync(join(chartsDir, f));
    rmSync(join(chartsDir, f.replace(/\.svg$/, ".png")), { force: true });
  }
}

// ---- markdown summary ----
// The header names only what the record itself carries: the pnpm every row ran
// (asserted uniform above). results.json has no machine fields, and bench/env.json
// is the dedicated 64-core box's capture, not this 192-core record's machine — so the
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
