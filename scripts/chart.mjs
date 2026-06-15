#!/usr/bin/env node
// Renders dependency-free SVG charts + a markdown summary from bench/results.json.
//   node scripts/chart.mjs

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const resultsPath = join(ROOT, "bench", "results.json");
if (!existsSync(resultsPath)) {
  console.error("no bench/results.json — run `node scripts/measure.mjs` first");
  process.exit(1);
}
const records = JSON.parse(readFileSync(resultsPath, "utf8")).sort((a, b) => a.apps - b.apps);
const chartsDir = join(ROOT, "bench", "charts");
mkdirSync(chartsDir, { recursive: true });

const fmtMs = (ms) => (ms == null ? "—" : ms >= 1000 ? (ms / 1000).toFixed(ms >= 10000 ? 0 : 1) + "s" : ms + "ms");
const fmtBytes = (b) => {
  if (b == null) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 100 || i === 0 ? 0 : 1) + u[i];
};
const fmtNum = (n) => (n == null ? "—" : n.toLocaleString("en-US"));

// ---- generic vertical bar chart ----
function barChart({ file, title, subtitle, bars, valueFmt = fmtMs, logScale = false }) {
  const W = 760, H = 420, padL = 70, padR = 24, padT = 70, padB = 90;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const vals = bars.map((b) => b.value ?? 0);
  const maxV = Math.max(1, ...vals);
  const scale = (v) => {
    if (!logScale) return (v / maxV) * plotH;
    const lv = Math.log10(Math.max(1, v)), lm = Math.log10(Math.max(10, maxV));
    return (lv / lm) * plotH;
  };
  const n = bars.length;
  const gap = 18;
  const bw = Math.min(120, (plotW - gap * (n + 1)) / n);
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="ui-sans-serif,system-ui,sans-serif">
<rect width="${W}" height="${H}" fill="#0b0f17"/>
<text x="${padL}" y="34" fill="#e6edf3" font-size="20" font-weight="700">${title}</text>
${subtitle ? `<text x="${padL}" y="54" fill="#7d8590" font-size="13">${subtitle}</text>` : ""}
<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="#30363d"/>`;
  bars.forEach((b, i) => {
    const h = Math.max(2, scale(b.value ?? 0));
    const x = padL + gap + i * (bw + gap);
    const y = padT + plotH - h;
    svg += `<rect x="${x}" y="${y}" width="${bw}" height="${h}" rx="4" fill="${b.color || "#3b82f6"}"/>`;
    svg += `<text x="${x + bw / 2}" y="${y - 8}" fill="#e6edf3" font-size="13" font-weight="600" text-anchor="middle">${valueFmt(b.value)}</text>`;
    const lines = String(b.label).split("\n");
    lines.forEach((ln, k) => {
      svg += `<text x="${x + bw / 2}" y="${padT + plotH + 22 + k * 16}" fill="#9da7b3" font-size="12" text-anchor="middle">${ln}</text>`;
    });
  });
  svg += `</svg>`;
  writeFileSync(join(chartsDir, file), svg);
  return file;
}

// ---- line chart (metric vs scale) ----
function lineChart({ file, title, subtitle, series, xs, yFmt = fmtMs }) {
  const W = 760, H = 420, padL = 78, padR = 24, padT = 70, padB = 70;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const allY = series.flatMap((s) => s.points.map((p) => p)).filter((v) => v != null);
  const maxY = Math.max(1, ...allY);
  const maxX = Math.max(...xs);
  const sx = (x) => padL + (x / maxX) * plotW;
  const sy = (y) => padT + plotH - (y / maxY) * plotH;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="ui-sans-serif,system-ui,sans-serif">
<rect width="${W}" height="${H}" fill="#0b0f17"/>
<text x="${padL}" y="34" fill="#e6edf3" font-size="20" font-weight="700">${title}</text>
${subtitle ? `<text x="${padL}" y="54" fill="#7d8590" font-size="13">${subtitle}</text>` : ""}
<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="#30363d"/>
<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#30363d"/>`;
  xs.forEach((x) => {
    svg += `<text x="${sx(x)}" y="${padT + plotH + 22}" fill="#9da7b3" font-size="12" text-anchor="middle">${fmtNum(x)}</text>`;
  });
  series.forEach((s) => {
    const pts = s.points.map((y, i) => (y == null ? null : `${sx(xs[i])},${sy(y)}`)).filter(Boolean);
    svg += `<polyline points="${pts.join(" ")}" fill="none" stroke="${s.color}" stroke-width="2.5"/>`;
    s.points.forEach((y, i) => {
      if (y == null) return;
      svg += `<circle cx="${sx(xs[i])}" cy="${sy(y)}" r="4" fill="${s.color}"/>`;
      svg += `<text x="${sx(xs[i])}" y="${sy(y) - 10}" fill="#e6edf3" font-size="11" text-anchor="middle">${yFmt(y)}</text>`;
    });
  });
  // legend
  series.forEach((s, i) => {
    const lx = W - padR - 160, ly = padT + 6 + i * 20;
    svg += `<rect x="${lx}" y="${ly - 10}" width="12" height="12" fill="${s.color}"/><text x="${lx + 18}" y="${ly}" fill="#c9d1d9" font-size="12">${s.name}</text>`;
  });
  svg += `</svg>`;
  writeFileSync(join(chartsDir, file), svg);
  return file;
}

const byLabel = new Map();
for (const r of records) byLabel.set(r.label, r); // last write wins
const all = [...byLabel.values()].sort((a, b) => a.apps - b.apps);
const big = all[all.length - 1];

const made = [];

// Chart 1: typecheck cold vs warm for the largest scale
if (big?.phases?.typecheck) {
  made.push(barChart({
    file: "typecheck-cold-vs-warm.svg",
    title: "Whole-workspace typecheck: cold vs warm cache",
    subtitle: `${fmtNum(big.apps)} apps + ${fmtNum(big.libs)} libs — Turborepo local cache`,
    logScale: true,
    bars: [
      { label: "cold\n(first run)", value: big.phases.typecheck.coldMs, color: "#ef4444" },
      { label: "warm\n(FULL TURBO)", value: big.phases.typecheck.warmMs, color: "#22c55e" },
    ],
  }));
}

// Chart 2: focus build vs (estimated) full build at largest scale
if (big?.phases?.focus && big?.phases?.graph) {
  const focusMs = big.phases.focus.ms;
  const g = big.phases.graph;
  // crude full estimate: focus ms scaled by total/focus task ratio (lower bound, ignores parallelism gains)
  const ratio = g.totalBuildTasks && g.focusPackages ? g.totalBuildTasks / g.focusPackages : null;
  const est = ratio ? Math.round(focusMs * ratio) : null;
  made.push(barChart({
    file: "focus-vs-full.svg",
    title: "Task-time focus: build one app vs build everything",
    subtitle: `focus = ${fmtNum(g.focusPackages)} pkgs (${g.sampleApp} + closure) vs ${fmtNum(g.totalBuildTasks)} total`,
    bars: [
      { label: `focus build\n(${fmtNum(g.focusPackages)} pkgs)`, value: focusMs, color: "#22c55e" },
      { label: `full build\n(~est, ${fmtNum(g.totalBuildTasks)} pkgs)`, value: est, color: "#f59e0b" },
    ],
  }));
}

// Chart 3: install time vs scale
const scaled = all.filter((r) => r.phases?.install?.ms != null);
if (scaled.length >= 2) {
  made.push(lineChart({
    file: "install-vs-scale.svg",
    title: "pnpm install time vs workspace size",
    subtitle: "wall-clock, warm store",
    xs: scaled.map((r) => r.apps),
    series: [{ name: "pnpm install", color: "#3b82f6", points: scaled.map((r) => r.phases.install.ms) }],
  }));
}

// Chart 4: footprint (node_modules entries + lockfile lines) vs scale
const fs = all.filter((r) => r.phases?.install?.nmEntries != null);
if (fs.length >= 2) {
  made.push(lineChart({
    file: "footprint-vs-scale.svg",
    title: "Filesystem footprint vs workspace size",
    subtitle: "node_modules entries (inodes) and lockfile lines",
    xs: fs.map((r) => r.apps),
    yFmt: fmtNum,
    series: [
      { name: "node_modules entries", color: "#a855f7", points: fs.map((r) => r.phases.install.nmEntries) },
      { name: "lockfile lines", color: "#06b6d4", points: fs.map((r) => r.phases.install.lockfileLines) },
    ],
  }));
}

// ---- markdown summary ----
let md = `# Benchmark results\n\nMachine: ${process.platform}, generated from \`bench/results.json\`.\n\n`;
md += `| scale | gen | install | lockfile | node_modules | typecheck cold | typecheck warm | focus build | full build tasks | focus pkgs | prune |\n`;
md += `|---|---|---|---|---|---|---|---|---|---|---|\n`;
for (const r of all) {
  const p = r.phases;
  md += `| **${fmtNum(r.apps)} apps / ${fmtNum(r.libs)} libs** `;
  md += `| ${fmtMs(p.gen?.ms)} `;
  md += `| ${fmtMs(p.install?.ms)} `;
  md += `| ${p.install?.lockfileLines ? fmtNum(p.install.lockfileLines) + " lines / " + fmtBytes(p.install.lockfileBytes) : "—"} `;
  md += `| ${p.install?.nmEntries ? fmtNum(p.install.nmEntries) + " entries / " + fmtBytes(p.install.nmDiskBytes) : "—"} `;
  md += `| ${fmtMs(p.typecheck?.coldMs)} `;
  md += `| ${fmtMs(p.typecheck?.warmMs)} `;
  md += `| ${fmtMs(p.focus?.ms)} `;
  md += `| ${fmtNum(p.graph?.totalBuildTasks)} `;
  md += `| ${fmtNum(p.graph?.focusPackages)} `;
  md += `| ${fmtMs(p.prune?.ms)} |\n`;
}
md += `\n## Charts\n\n` + made.map((f) => `![${f}](charts/${f})`).join("\n\n") + "\n";
writeFileSync(join(ROOT, "bench", "summary.md"), md);

console.log("charts:", made.join(", "));
console.log("summary: bench/summary.md");
console.log("\n" + md);
