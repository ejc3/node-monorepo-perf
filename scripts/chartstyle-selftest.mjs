#!/usr/bin/env node
// Self-test for the shared chart kit (scripts/_chartstyle.mjs): the layout and
// legibility contracts the heat charts rely on, each pinned by a check that fails if
// the contract regresses. Run in CI before the charts render (charts.yml).
//
//   node scripts/chartstyle-selftest.mjs

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MIN_TEXT,
  TYPE,
  fitSize,
  approxW,
  wrapPx,
  heatChart,
  headerBand,
  writeDocBlock,
  logDomain,
  MIN_BOX_TEXT,
} from "./_chartstyle.mjs";
import { auditSvg } from "./_svg-audit.mjs";

let n = 0;
const test = (name, fn) => {
  fn();
  n++;
  console.log(`ok ${n} - ${name}`);
};

// font sizes of every <text> in an SVG, with its content
const texts = (svg) =>
  [...svg.matchAll(/<text[^>]*font-size="([\d.]+)"[^>]*>([^<]*)<\/text>/g)].map((m) => ({
    size: +m[1],
    s: m[2],
  }));
const ranked = (text, mult) => ({ kind: "ranked", text, mult });
const base = (over = {}) => ({
  title: "Self-test chart",
  lede: "Context line: versions, cores.",
  aria: "self-test",
  sections: [
    {
      title: "Section",
      cols: [
        { label: "alpha", chip: "bun" },
        { label: "beta\ntwo lines", sub: "and a sub", chip: "pnpm" },
      ],
      rows: [{ label: "row one", cells: [ranked("1.0s", 1), ranked("2.0s", 2)] }],
      source: "bench/a.json",
    },
  ],
  ...over,
});

test("text that cannot fit at the floor throws instead of shrinking", () => {
  assert.equal(fitSize("short", 200, TYPE.value), TYPE.value);
  assert.ok(fitSize("a bit longer text", 85, TYPE.sub) >= MIN_TEXT);
  assert.throws(() => fitSize("64 entries + 0.8MB table", 102, TYPE.sub), /floor/);
  const long = base();
  long.sections[0].rows[0].cells[1] = { ...ranked("2.0s", 2), detail: "x".repeat(40) };
  assert.throws(() => heatChart(long), /floor/);
});

test("no rendered text is below the floor", () => {
  const { svg } = heatChart(base());
  for (const t of texts(svg)) assert.ok(t.size >= MIN_TEXT, `"${t.s}" at ${t.size}px`);
});

test("a long row label wraps inside the label column; three lines throw", () => {
  const c = base({ labelW: 150 });
  c.sections[0].rows[0].label = "Cold · 1,000 apps · 11,898 dep edges";
  const { svg } = heatChart(c);
  const lines = texts(svg).filter((t) => /Cold|dep edges|apps/.test(t.s));
  assert.ok(lines.length >= 2, "label wrapped");
  for (const l of lines) assert.ok(approxW(l.s, l.size) <= 150 - 14, `"${l.s}" overflows`);
  c.sections[0].rows[0].label = "word ".repeat(40);
  assert.throws(() => heatChart(c), /lines/);
});

test("column headers sit below the section rule in a band sized to the tallest header", () => {
  const cols = base().sections[0].cols;
  const band = headerBand(cols);
  assert.ok(band >= 2 * 13.5 + 12 + 8, `band ${band} too short for a two-line header with a sub`);
  const { svg } = heatChart(base());
  const rule = +svg.match(/<line x1="20" y1="([\d.]+)"/)[1];
  const firstHeader = texts(svg).find((t) => t.s === "beta");
  const y = +svg.match(/<text x="[\d.]+" y="([\d.]+)"[^>]*>beta<\/text>/)[1];
  assert.ok(
    y - firstHeader.size * 0.75 > rule + 2,
    `header cap top ${y} crosses the rule at ${rule}`,
  );
});

test("the key lists only the states the chart shows", () => {
  const plain = heatChart(base()).svg;
  assert.ok(!/not measured/.test(plain), "no — cell, no '— not measured' key");
  assert.ok(!/within 5%/.test(plain), "no near-tie, no near-tie key");
  const c = base();
  c.sections[0].rows.push({
    label: "row two",
    cells: [{ kind: "na", why: "anchor" }, ranked("1.03s", 1.03)],
  });
  const svg = heatChart(c).svg;
  assert.ok(/not measured/.test(svg) && /within 5%/.test(svg));
  const s = base();
  s.sections[0].rows[0].cells[1] = { kind: "status", main: "wedged", sub: "at cycle 13" };
  assert.throws(() => heatChart(s), /statusKey/);
  assert.ok(/crash: status only/.test(heatChart({ ...s, statusKey: "crash: status only" }).svg));
});

test("the markdown twin carries the chart's context line and the same standings", () => {
  const c = base();
  c.sections[0].rows[0].cells = [ranked("1.0s", 1), ranked("1.03s", 1.03)];
  const { svg, md } = heatChart(c);
  assert.ok(md.startsWith("Context line: versions, cores."), "lede first");
  assert.ok(/\*\*1\.0s\*\*/.test(md) && /1\.03s \(\+3%\)/.test(md));
  assert.ok(/>\+3%</.test(svg), "SVG and markdown print the same near-tie standing");
});

test("rendered cells: tints separate by multiple and every cell text clears AA", () => {
  // read the colours from a RENDERED chart (cell fills and the text drawn on them),
  // so a regression in the painters is caught, not only one in the palette constants
  const lum = ([r, g, b]) => {
    const f = (c) => ((c /= 255), c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const cr = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const c = base({ statusKey: "status" });
  c.sections[0].cols = [1, 2, 3, 4, 5].map((i) => ({ label: `c${i}` }));
  c.sections[0].rows = [
    {
      label: "every state",
      cells: [
        ranked("1.0s", 1),
        { ...ranked("2.0s", 2), detail: "detail" },
        ranked("10s", 10),
        ranked("100s", 100),
        { kind: "status", main: "wedged", sub: "at cycle 1" },
      ],
    },
  ];
  const { svg } = heatChart(c);
  const rects = [
    ...svg.matchAll(
      /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"[^>]*fill="rgba\((\d+),(\d+),(\d+),([\d.]+)\)"/g,
    ),
  ].map((m) => ({
    x: +m[1],
    y: +m[2],
    w: +m[3],
    h: +m[4],
    a: +m[8],
    bg: [+m[5], +m[6], +m[7]].map((ch) => ch * +m[8] + 255 * (1 - +m[8])),
  }));
  const cellRects = rects.filter((r) => r.w > 40); // cells, not the legend chips
  let checked = 0;
  for (const m of svg.matchAll(
    /<text x="([\d.]+)" y="([\d.]+)"[^>]*fill="(#[0-9a-f]{6})"[^>]*>([^<]*)<\/text>/g,
  )) {
    const [x, y] = [+m[1], +m[2]];
    const cell = cellRects.find((r) => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h);
    if (!cell) continue;
    const ink = [1, 3, 5].map((i) => parseInt(m[3].slice(i, i + 2), 16));
    assert.ok(
      cr(ink, cell.bg) >= 4.5,
      `"${m[4]}" (${m[3]}) on its cell: ${cr(ink, cell.bg).toFixed(2)}:1`,
    );
    checked++;
  }
  const alphas = cellRects.map((r) => r.a);
  assert.ok(checked >= 10, `checked ${checked} cell texts`);
  // the five cells' fills, in order: ×1, ×2, ×10, ×100, status (legend chips come first)
  const cells = alphas.slice(-5);
  assert.ok(
    cells[0] < cells[2] && cells[2] < cells[3],
    `tint alpha grows with the multiple: ${cells}`,
  );
});

test("pixel wrapping never exceeds its width", () => {
  const note = "word ".repeat(80) + "end";
  for (const l of wrapPx(note, TYPE.note, 300)) assert.ok(approxW(l, TYPE.note) <= 300);
});

test("writeDocBlock replaces exactly its block and refuses a doc without markers", () => {
  const dir = mkdtempSync(join(tmpdir(), "chartstyle-"));
  try {
    const doc = join(dir, "doc.md");
    writeFileSync(doc, "a\n<!-- chart-data:x -->\nold\n<!-- /chart-data:x -->\nb\n");
    writeDocBlock(doc, "x", "new");
    assert.equal(
      readFileSync(doc, "utf8"),
      "a\n<!-- chart-data:x -->\nnew\n<!-- /chart-data:x -->\nb\n",
    );
    writeFileSync(doc, "no markers\n");
    assert.throws(() => writeDocBlock(doc, "x", "new"), /markers/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checker-scale never turns a missing field into a plausible '—' (source-level)", () => {
  const src = readFileSync(new URL("./scale-chart.mjs", import.meta.url), "utf8");
  assert.ok(!/skipped\s*\?\s*null/.test(src), "an unmeasured cell must be an explicit NAR(why)");
  assert.ok(/v == null\)\s*throw new Error/.test(src), "a bare null cell throws");
});

test("tool-comparison's stated denominator names its column-compared section (README block)", () => {
  // the install-situations section compares down its column; a lede that says every
  // multiple is against "the row's fastest" makes its one-cell rows all read as fastest
  const src = readFileSync(new URL("./comparison-chart.mjs", import.meta.url), "utf8");
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const block = readme.split("<!-- chart-data:tool-comparison -->")[1].split("<!-- /chart-data")[0];
  const lede = block.split("\n").find((l) => l.startsWith("Each cell:"));
  assert.ok(lede, "the tool-comparison block opens with its 'Each cell:' context line");
  if (/compareAxis: "col"/.test(src))
    assert.ok(/column/.test(lede), `lede does not mention the column comparison: ${lede}`);
});

test("log domains derive from the data: every point inside, 1-3 bounds labelled", () => {
  for (const vals of [
    [150, 30300], // a 50:50 record next to the fleet-sized tree
    [300, 20300],
    [75, 124, 20300],
    [10185, 746255],
    [3, 2e6],
  ]) {
    const { domain, ticks } = logDomain(vals);
    for (const v of vals) assert.ok(v >= domain[0] && v <= domain[1], `${v} outside [${domain}]`);
    assert.equal(ticks[0], domain[0], "the floor is a labelled tick");
    assert.equal(ticks[ticks.length - 1], domain[1], "the ceiling is a labelled tick");
  }
  assert.throws(() => logDomain([0, 10]), /positive/);
});

// Every committed chart, in both themes: text at or above the floor (11px inside a
// figure box), every text at 4.5:1 against what is drawn behind it, every mark at 3:1
// against the page. One matrix over all generators, so a new chart cannot opt out.
// LEGACY holds charts not yet redrawn on the shared grammar; the PR that redraws one
// removes it here.
const LEGACY = new Set([
  "fig-blast-radius.svg",
  "fig-freshness-gate.svg",
  "fig-linker-layouts.svg",
  "fig-next-pnp-node.svg",
  "fig-orepo-oclosure.svg",
  "fig-remote-cache.svg",
  "fig-save-loop.svg",
  "fig-sliced-gate.svg",
  "fleet-gate.svg",
]);
const chartsDir = new URL("../bench/charts/", import.meta.url);
for (const f of readdirSync(chartsDir)
  .filter((f) => f.endsWith(".svg") && !LEGACY.has(f))
  .sort())
  test(`${f}: legible in both themes`, () => {
    const issues = auditSvg(readFileSync(new URL(f, chartsDir), "utf8"), {
      minText: MIN_TEXT,
      minBoxText: MIN_BOX_TEXT,
    });
    assert.deepEqual(issues, [], `${f}:\n  ${issues.slice(0, 12).join("\n  ")}`);
  });

test("charts.yml triggers on every module the chart scripts import", () => {
  // a module only the self-test or a generator imports (e.g. _svg-audit.mjs) must still
  // run the chart workflow when it alone changes, on push and on pull_request alike
  const wf = readFileSync(new URL("../.github/workflows/charts.yml", import.meta.url), "utf8");
  const scripts = [
    "chartstyle-selftest.mjs",
    "chart.mjs",
    "comparison-chart.mjs",
    "scale-chart.mjs",
    "net-cache-chart.mjs",
    "fleet-chart.mjs",
    "figures.mjs",
  ];
  const local = new Set();
  for (const f of scripts) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    for (const m of src.matchAll(/from "\.\/([\w.-]+\.mjs)"/g)) local.add(m[1]);
    local.add(f);
  }
  for (const f of local) {
    const n = wf.split(`- "scripts/${f}"`).length - 1;
    assert.ok(
      n >= 2,
      `scripts/${f} is in charts.yml's paths ${n} time(s); push and pull_request both need it`,
    );
  }
});

console.log(`1..${n}`);
