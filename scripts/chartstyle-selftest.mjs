#!/usr/bin/env node
// Self-test for the shared chart kit (scripts/_chartstyle.mjs): the layout and
// legibility contracts the heat charts rely on, each pinned by a check that fails if
// the contract regresses. Run in CI before the charts render (charts.yml).
//
//   node scripts/chartstyle-selftest.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  logScale,
  MIN_BOX_TEXT,
  labelBaseline,
  LABEL_GAP,
  FIG,
} from "./_chartstyle.mjs";
import * as svgAudit from "./_svg-audit.mjs";
import { textWidth } from "./_text-width.mjs";

const { auditSvg } = svgAudit;

// every test runs and reports; a failure is listed and the run exits 1 at the end, so one
// regression does not hide the next (the committed-chart sweep names every failing chart)
let n = 0;
const failed = [];
const test = (name, fn) => {
  n++;
  try {
    fn();
    console.log(`ok ${n} - ${name}`);
  } catch (e) {
    failed.push(`${n} - ${name}`);
    console.log(`not ok ${n} - ${name}\n  ${String(e.message).split("\n").join("\n  ")}`);
  }
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

test("a value label clears a vertical neighbour segment with a finite baseline", () => {
  // two points on one screen x (equal workspace totals) make a vertical segment; the
  // interpolation along it must not divide by zero and emit y="NaN"
  for (const [pts, i] of [
    [
      [
        [100, 80],
        [100, 40],
      ],
      0,
    ],
    [
      [
        [100, 40],
        [100, 80],
      ],
      1,
    ],
    [
      [
        [60, 90],
        [100, 80],
        [100, 40],
      ],
      1,
    ],
  ]) {
    const y = labelBaseline(pts, i, "12.3s", TYPE.note);
    assert.ok(Number.isFinite(y), `baseline ${y} for ${JSON.stringify(pts)} at ${i}`);
    const bottom = y + 0.21 * TYPE.note;
    const [cx, cy] = pts[i];
    for (const j of [i - 1, i + 1]) {
      const p = pts[j];
      if (!p || p[0] !== cx) continue;
      const top = Math.min(cy, p[1]) - 2.25 / 2;
      assert.ok(
        bottom <= top - LABEL_GAP,
        `label bottom ${bottom} not clear of the segment top ${top}`,
      );
    }
  }
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
  // a single row on a stop must not collapse the domain (zero span → NaN coordinates)
  for (const one of [[300], [1000], [300, 300], [746255]]) {
    const { domain } = logDomain(one);
    assert.ok(domain[0] < one[0] && one[0] < domain[1], `singleton ${one} → [${domain}]`);
    const at = logScale(domain[0], domain[1], 0, 100)(one[0]);
    assert.ok(Number.isFinite(at), `singleton ${one} maps to ${at}`);
  }
});

// The audit's mark check, on hand-written SVGs: what a reader sees (the colour composited
// over the theme's page) is what is held to 3:1, and only a rect with text written in it is
// exempt as a text-framing box.
const miniSvg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">` +
  `<rect width="400" height="200" fill="#ffffff"/>${body}</svg>`;
const auditMini = (body) =>
  auditSvg(miniSvg(body), { minText: MIN_TEXT, minBoxText: MIN_BOX_TEXT });
const text = (x, y, s) => `<text x="${x}" y="${y}" font-size="13" fill="#1c2330">${s}</text>`;
test("the audit composites translucent marks over the page and holds them to 3:1", () => {
  // a translucent near-white bar on white
  assert.ok(
    auditMini(`<rect x="20" y="20" width="200" height="12" fill="rgba(240,240,240,0.5)"/>`).some(
      (i) => /rect fill/.test(i),
    ),
    "rgba near-white bar passed",
  );
  // a pale stroke made paler by stroke-opacity (its opaque colour alone would pass)
  assert.deepEqual(
    auditMini(`<polyline points="20,20 200,20" fill="none" stroke="#3a4656"/>`),
    [],
    "control: the opaque series colour passes",
  );
  // opacity attributes are outside the allowlist (no generator writes one): the audit
  // refuses them rather than modelling them
  for (const mark of [
    `<polyline points="20,20 200,20" fill="none" stroke="#3a4656" stroke-opacity="0.1"/>`,
    `<line x1="20" y1="20" x2="200" y2="20" stroke="#aaaaaa" stroke-opacity="0.5"/>`,
    `<g opacity="0.3"><polyline points="20,20 200,20" fill="none" stroke="#3a4656"/></g>`,
    `<circle cx="50" cy="50" r="4" fill="#3a4656" opacity="0.15"/>`,
  ])
    assert.throws(() => auditMini(mark), /unsupported/, `translucent mark accepted: ${mark}`);
  // exemptions: GRID hairlines, a hollow dot's page-coloured centre, stripes of 3px or less
  assert.deepEqual(
    auditMini(
      `<line x1="20" y1="20" x2="200" y2="20" stroke="#e4e8ec"/>` +
        `<circle cx="50" cy="50" r="4" fill="#ffffff" stroke="#3a4656"/>` +
        `<rect x="20" y="60" width="200" height="2" fill="#eeeeee"/>` +
        `<rect x="20" y="70" width="3" height="40" fill="#eeeeee"/>`,
    ),
    [],
  );
});

test("text opacity is outside the allowlist: refused, not modelled", () => {
  const t = `<text x="20" y="30" font-size="13" fill="#1c2330">label</text>`;
  assert.deepEqual(auditMini(t), [], "control: plain ink passes");
  for (const wrapped of [
    `<g opacity="0.2">${t}</g>`,
    `<g><text x="20" y="30" font-size="13" fill="#1c2330" opacity="0.2">label</text></g>`,
  ])
    assert.throws(() => auditMini(wrapped), /unsupported attribute/, wrapped);
});

test("the audit exempts a legend swatch only when its label sits beside it", () => {
  const swatch = `<rect x="20" y="20" width="20" height="12" rx="2" fill="rgba(31,138,77,0.16)"/>`;
  const label = (x, y) => `<text x="${x}" y="${y}" font-size="13" fill="#1c2330">fastest</text>`;
  // the legend shape: 20x12 tint, label 5px to its right, baseline inside the rect
  assert.deepEqual(auditMini(swatch + label(45, 30)), []);
  // the same rect with its label 40px away is a bare tint
  assert.ok(auditMini(swatch + label(80, 30)).length > 0, "far label exempted the swatch");
  // a label on a different line does not label it
  assert.ok(auditMini(swatch + label(45, 60)).length > 0, "off-line label exempted the swatch");
  // a label with no ink (spaces only) carries nothing: the swatch is a bare tint
  assert.ok(
    auditMini(swatch + `<text x="45" y="30" font-size="13" fill="#1c2330">   </text>`).some((i) =>
      /rect fill/.test(i),
    ),
    "a blank label exempted the swatch",
  );
  // a larger rect is a bar, label or not
  assert.ok(
    auditMini(
      `<rect x="20" y="20" width="60" height="40" fill="rgba(31,138,77,0.16)"/>${label(85, 40)}`,
    ).length > 0,
    "60x40 rect exempted by a label beside it",
  );
});

test("the audit exempts a rect only if text is written inside it", () => {
  // a bordered bar with nothing in it: fill and stroke are both marks
  const bar = auditMini(
    `<rect x="20" y="20" width="200" height="20" fill="#dddddd" stroke="#bbbbbb"/>`,
  );
  assert.ok(
    bar.some((i) => /rect fill/.test(i)),
    "bordered bar fill skipped",
  );
  assert.ok(
    bar.some((i) => /rect stroke/.test(i)),
    "bordered bar stroke skipped",
  );
  // a text beside the bar (anchor outside it) does not frame it
  assert.ok(
    auditMini(
      `<rect x="20" y="20" width="200" height="20" fill="#dddddd" stroke="#bbbbbb"/>${text(230, 34, "label")}`,
    ).length > 0,
    "a label next to the bar exempted it",
  );
  // a heat cell or figure box: the same rects with text anchored inside are exempt
  assert.deepEqual(
    auditMini(
      `<rect x="20" y="20" width="200" height="30" fill="rgba(31,138,77,0.16)"/>${text(30, 40, "1.2s")}` +
        `<rect x="20" y="60" width="200" height="30" fill="#dddddd" stroke="#bbbbbb"/>${text(30, 80, "box")}`,
    ),
    [],
  );
});

test("the figures share the heat and line charts' type scale", () => {
  assert.equal(FIG.title, TYPE.title);
  assert.equal(FIG.lede, TYPE.lede);
  assert.equal(FIG.value, TYPE.value);
  assert.equal(FIG.note, TYPE.note);
  assert.equal(FIG.body, MIN_BOX_TEXT, "figure box text sits at the box-text floor");
  assert.ok(FIG.edge >= MIN_TEXT);
});

// A figure box is a bordered rect: a text is inside one when any rect painted under it
// that holds its glyph box has a painted stroke (width above 0, a colour of alpha above
// 0), whatever the rect's size. A 20px chip is a box; an unbordered tint (a heat cell) is
// not.
test("text in any bordered frame is held to the figure-box floor, a 20px chip included", () => {
  const small = (x, y, s) => `<text x="${x}" y="${y}" font-size="9.5" fill="#1c2330">${s}</text>`;
  const boxed = (body) => auditMini(body).filter((i) => /inside a figure box/.test(i));
  for (const body of [
    // a package chip: 20px tall, bordered
    `<rect x="20" y="20" width="60" height="20" rx="4" fill="#ffffff" stroke="#b9cdec" stroke-width="1"/>${small(28, 33.5, "react")}`,
    // a narrow chip
    `<rect x="20" y="20" width="36" height="16" fill="#ffffff" stroke="#b9cdec"/>${small(24, 31, "next")}`,
    // an unbordered tint inside a bordered box: still inside the box
    `<rect x="10" y="10" width="200" height="80" fill="#eef3fb" stroke="#b9cdec"/>` +
      `<rect x="20" y="20" width="100" height="20" fill="#dde6f3"/>${small(26, 33.5, "nested")}`,
  ])
    assert.equal(boxed(body).length, 1, `9.5px text in a bordered frame passed: ${body}`);
  // controls: an unbordered heat cell, a border of width 0 or alpha 0, the page
  for (const body of [
    `<rect x="20" y="20" width="60" height="20" fill="#eef3fb"/>${small(28, 33.5, "cell")}`,
    `<rect x="20" y="20" width="60" height="20" fill="#eef3fb" stroke="#b9cdec" stroke-width="0"/>${small(28, 33.5, "cell")}`,
    `<rect x="20" y="20" width="60" height="20" fill="#eef3fb" stroke="rgba(185,205,236,0)"/>${small(28, 33.5, "cell")}`,
    small(28, 33.5, "page"),
  ])
    assert.deepEqual(boxed(body), [], body);
  // at the floor a chip passes
  assert.deepEqual(
    boxed(
      `<rect x="20" y="20" width="60" height="20" rx="4" fill="#ffffff" stroke="#b9cdec"/>` +
        `<text x="28" y="34" font-size="11" fill="#1c2330">react</text>`,
    ),
    [],
  );
});

// The overlap check reads whether paint exists from the light theme. That is exact only
// because no dark rule can make light-transparent paint visible: the one light paint of
// alpha 0 is an rgba() value, and a dark selector on an rgba() value is unsupported.
test("a dark rule cannot select an rgba() value (the overlap check's light-theme paint test relies on it)", () => {
  const doc = (rule) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">` +
    `<style>@media (prefers-color-scheme: dark){${rule}}</style>` +
    `<rect width="400" height="200" fill="#ffffff"/>` +
    `<rect x="10" y="52" width="200" height="2" fill="rgba(0,0,0,0)"/></svg>`;
  assert.throws(
    () =>
      auditSvg(doc(`rect[fill="rgba(0,0,0,0)"]{fill:#e2e7ec}`), {
        minText: MIN_TEXT,
        minBoxText: MIN_BOX_TEXT,
      }),
    /unsupported dark rule selector/,
  );
});

// Every committed chart, in both themes: text at or above the floor (11px inside a
// figure box), every text at 4.5:1 against what is drawn behind it, every mark at 3:1
// against the page. One matrix over all generators, so a new chart cannot opt out.
// Every chart is on the shared grammar; a chart added later joins the matrix as is.
const LEGACY = new Set();
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
    "route-planner-figures.mjs",
  ];
  // every local module reachable from the chart scripts, through imports of imports
  const local = new Set();
  const queue = [...scripts];
  while (queue.length) {
    const f = queue.shift();
    if (local.has(f)) continue;
    local.add(f);
    const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    for (const m of src.matchAll(/from "\.\/([\w.-]+\.mjs)"/g)) queue.push(m[1]);
  }
  for (const f of local) {
    const n = wf.split(`- "scripts/${f}"`).length - 1;
    assert.ok(
      n >= 2,
      `scripts/${f} is in charts.yml's paths ${n} time(s); push and pull_request both need it`,
    );
  }
});

test("the audit checks arrow and edge paths: a faint path stroke and a faint arrowhead fill are flagged, a GRID hairline path is not", () => {
  const faint = "#f4f4f4"; // ~1.1:1 on white
  const wrap = (body) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60" viewBox="0 0 200 60"><rect width="200" height="60" fill="#ffffff"/>${body}</svg>`;
  const audit = (body) => auditSvg(wrap(body), { minText: MIN_TEXT, minBoxText: MIN_BOX_TEXT });
  const edge = audit(`<path d="M10 20L90 20" fill="none" stroke="${faint}"/>`);
  assert.ok(
    edge.some((i) => i.includes("path stroke")),
    `a faint edge path escaped the mark check: ${edge}`,
  );
  const head = audit(`<path d="M100 20L94 17L94 23z" fill="${faint}"/>`);
  assert.ok(
    head.some((i) => i.includes("path fill")),
    `a faint arrowhead escaped the mark check: ${head}`,
  );
  const hair = audit(`<path d="M0 50L200 50" fill="none" stroke="#e4e8ec"/>`);
  assert.deepEqual(hair, [], "a GRID-coloured hairline path is decoration, not a mark");
});

// Placement: every check places an element through the accumulated translate() of its
// groups, so a text or rect inside a translated group is checked where it is drawn.
const ink = (x, y, s, fill) => `<text x="${x}" y="${y}" font-size="13" fill="${fill}">${s}</text>`;
test("the contrast check uses a translated text's backdrop", () => {
  const dark = `<rect x="200" y="40" width="160" height="40" fill="#1c2330"/>`;
  // white ink at x=20, translated to x=220: over the dark rect, readable
  assert.deepEqual(
    auditMini(dark + `<g transform="translate(200 0)">${ink(20, 64, "on dark", "#ffffff")}</g>`),
    [],
  );
  // dark ink translated onto the dark rect: unreadable, whatever its untranslated spot shows
  assert.ok(
    auditMini(
      dark + `<g transform="translate(200 0)">${ink(20, 64, "dark on dark", "#1c2330")}</g>`,
    ).some((i) => /dark on dark/.test(i) && /4\.5:1/.test(i)),
    "dark ink over the translated dark backdrop passed",
  );
  // nested groups add up: translate(150) + translate(50) lands at x=220
  assert.deepEqual(
    auditMini(
      dark +
        `<g transform="translate(150 0)"><g transform="translate(50,0)">${ink(20, 64, "nested", "#ffffff")}</g></g>`,
    ),
    [],
  );
});
test("the framing exemption uses a translated text's glyph box", () => {
  // a bar from x=100: a text translated into it frames it, so its faint fill is exempt
  const bar = `<rect x="100" y="40" width="200" height="40" fill="#f2f2f2"/>`;
  assert.deepEqual(
    auditMini(bar + `<g transform="translate(100 0)">${ink(20, 64, "framed", "#1c2330")}</g>`),
    [],
  );
  // a text translated out of the bar does not frame it, though its own x (120) lies inside
  assert.ok(
    auditMini(
      bar + `<g transform="translate(300 0)">${ink(120, 64, "beside", "#1c2330")}</g>`,
    ).some((i) => /rect fill/.test(i)),
    "a text translated away from the bar exempted it",
  );
  // a rect inside a translated group is framed where it is drawn (100..200), not at its
  // own coordinates (0..100)
  assert.deepEqual(
    auditMini(
      `<g transform="translate(100 0)"><rect x="0" y="40" width="100" height="40" fill="#f2f2f2"/></g>` +
        ink(120, 64, "framed", "#1c2330"),
    ),
    [],
  );
});
test("only an opaque rect covering the whole canvas from 0,0 is the page", () => {
  const page = (rect) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">` +
    `${rect}${ink(20, 60, "dark text", "#1c2330")}</svg>`;
  const audit = (rect) => auditSvg(page(rect), { minText: MIN_TEXT, minBoxText: MIN_BOX_TEXT });
  // the full canvas: the page
  assert.deepEqual(audit(`<rect width="400" height="200" fill="#ffffff"/>`), []);
  for (const rect of [
    `<rect width="400" height="1" fill="#ffffff"/>`, // a 1px strip
    `<rect width="400" fill="#ffffff"/>`, // no height
    `<rect width="400" height="0" fill="#ffffff"/>`,
    `<rect y="5" width="400" height="200" fill="#ffffff"/>`, // not from the origin
    `<g transform="translate(0 5)"><rect width="400" height="200" fill="#ffffff"/></g>`,
    `<rect width="400" height="200" fill="none"/>`, // transparent
    `<rect width="400" height="200" fill="rgba(255,255,255,0.5)"/>`,
  ])
    assert.ok(
      audit(rect).some((i) => /no full-canvas background rect/.test(i)),
      `taken as the page: ${rect}`,
    );
});
test("both themes' page colours come from the page rect", () => {
  // a black page that a dark rule turns white, with black text: unreadable in light
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">` +
    `<style>@media (prefers-color-scheme: dark){rect[fill="#000000"]{fill:#ffffff}}</style>` +
    `<rect width="400" height="200" fill="#000000"/>${ink(20, 60, "black on black", "#000000")}</svg>`;
  const issues = auditSvg(svg, { minText: MIN_TEXT, minBoxText: MIN_BOX_TEXT });
  assert.ok(
    issues.some((i) => /^light: "black on black"/.test(i)),
    `light-theme text on a black page passed: ${JSON.stringify(issues)}`,
  );
  assert.ok(!issues.some((i) => /^dark:/.test(i)), "dark theme: black text on the white page");
});
test("a text's backdrop is the paint stack under its glyph box, in document order", () => {
  // a covering rect painted after the label hides it: reported, and the label is judged
  // against what was painted before it (the white page)
  const covered = auditMini(
    ink(20, 60, "hidden", "#ffffff") +
      `<rect x="10" y="40" width="200" height="30" fill="#000000"/>`,
  );
  assert.ok(
    covered.some((i) => /"hidden" is covered by a rect drawn after it/.test(i)),
    `a rect painted over the label passed: ${JSON.stringify(covered)}`,
  );
  assert.ok(
    covered.some((i) => /^light: "hidden"/.test(i)),
    "white label judged against black",
  );
  // overlapping earlier rects: the topmost one painted before the text is its backdrop,
  // not the smallest
  const stacked = auditMini(
    `<rect x="15" y="45" width="90" height="20" fill="#ffffff"/>` +
      `<rect x="10" y="40" width="200" height="30" fill="#000000"/>` +
      ink(20, 60, "on black", "#1c2330"),
  );
  assert.ok(
    stacked.some((i) => /^light: "on black"/.test(i)),
    `dark ink over the topmost black rect passed: ${JSON.stringify(stacked)}`,
  );
  // control: the same stack in the other order (white on top) is readable
  assert.deepEqual(
    auditMini(
      `<rect x="10" y="40" width="200" height="30" fill="#000000"/>` +
        `<rect x="15" y="45" width="90" height="20" fill="#ffffff"/>` +
        ink(20, 60, "on white", "#1c2330"),
    ),
    [],
  );
});
// A text's backdrop and its collisions are taken over its glyph box (its anchor, its
// text-anchor and its estimated width), never its anchor point alone.
test("a rect holding the anchor but not the glyph box is not the text's backdrop", () => {
  // long white text anchored inside a narrow dark box, its glyphs running onto the page
  const box = `<rect x="20" y="40" width="60" height="30" fill="#1c2330"/>`;
  const long = auditMini(box + ink(70, 60, "white text past the box", "#ffffff"));
  assert.ok(
    long.some((i) => /^light: "white text past the box"/.test(i) && /4\.5:1/.test(i)),
    `white glyphs on the white page passed: ${JSON.stringify(long)}`,
  );
  assert.ok(
    long.some((i) => /"white text past the box" crosses the edge of the rect/.test(i)),
    `a label crossing its backdrop's edge passed: ${JSON.stringify(long)}`,
  );
  // dark text anchored on the page whose glyphs run onto a dark rect painted before it
  const into = auditMini(
    `<rect x="100" y="40" width="200" height="30" fill="#1c2330"/>` +
      ink(60, 60, "dark ink into the bar", "#1c2330"),
  );
  assert.ok(
    into.some((i) => /"dark ink into the bar" crosses the edge of the rect/.test(i)),
    `dark glyphs over a dark rect passed: ${JSON.stringify(into)}`,
  );
  // text-anchor is honoured: anchored at its end on the page, its glyphs run left into
  // the dark rect
  const end = auditMini(
    `<rect x="20" y="40" width="100" height="30" fill="#1c2330"/>` +
      `<text x="180" y="60" font-size="13" fill="#1c2330" text-anchor="end">end-anchored label</text>`,
  );
  assert.ok(
    end.some((i) => /"end-anchored label" crosses the edge of the rect/.test(i)),
    `an end-anchored label running into a rect passed: ${JSON.stringify(end)}`,
  );
  // a rect painted after the text over part of its glyphs, though not its anchor
  const cover = auditMini(
    ink(20, 60, "partly covered label", "#1c2330") +
      `<rect x="80" y="40" width="200" height="30" fill="#e8ecf0"/>`,
  );
  assert.ok(
    cover.some((i) => /"partly covered label" is covered by a rect drawn after it/.test(i)),
    `a rect painted over the label's glyphs passed: ${JSON.stringify(cover)}`,
  );
  // a rect crossing the glyph box under an opaque frame that holds the box is hidden by
  // the frame; under a translucent frame it shows through and crosses the glyphs
  const band = `<rect x="0" y="50" width="60" height="40" fill="#1c2330"/>`;
  assert.deepEqual(
    auditMini(
      band +
        `<rect x="20" y="40" width="200" height="30" fill="#ffffff"/>` +
        ink(30, 60, "over a band", "#1c2330"),
    ),
    [],
  );
  assert.ok(
    auditMini(
      band +
        `<rect x="20" y="40" width="200" height="30" fill="rgba(255,255,255,0.5)"/>` +
        ink(30, 60, "over a band", "#1c2330"),
    ).some((i) =>
      /"over a band" crosses the edge of the rect painted under it \(fill #1c2330\)/.test(i),
    ),
    "a band under a translucent frame was hidden",
  );
  // controls: the same white text wholly inside a wide dark box, and dark text clear of it
  assert.deepEqual(
    auditMini(
      `<rect x="20" y="40" width="300" height="30" fill="#1c2330"/>` +
        ink(30, 60, "white text past the box", "#ffffff"),
    ),
    [],
  );
  assert.deepEqual(
    auditMini(
      `<rect x="250" y="40" width="100" height="30" fill="#1c2330"/>` +
        ink(20, 60, "dark ink into the bar", "#1c2330"),
    ),
    [],
  );
});
test("a page-coloured fill is exempt only inside a visible stroke (a hollow mark)", () => {
  // a white dot with no stroke on the white page: invisible, a mark at 1:1
  for (const dot of [
    `<circle cx="50" cy="50" r="4" fill="#ffffff" stroke="none"/>`,
    `<circle cx="50" cy="50" r="4" fill="#ffffff"/>`,
    `<circle cx="50" cy="50" r="4" fill="#ffffff" stroke="#3a4656" stroke-width="0"/>`,
    `<circle cx="50" cy="50" r="4" fill="#ffffff" stroke="rgba(58,70,86,0)"/>`,
    `<circle cx="50" cy="50" r="4" fill="#ffffff" stroke="#f4f4f4"/>`,
    `<rect x="20" y="20" width="200" height="12" fill="#ffffff"/>`,
  ])
    assert.ok(
      auditMini(dot).some((i) => /^light: (circle|rect) fill #ffffff at 1\.00:1/.test(i)),
      `a page-coloured fill without a visible stroke passed: ${dot}`,
    );
  // a hollow ring: page-coloured centre inside a 3:1 stroke
  assert.deepEqual(
    auditMini(`<circle cx="50" cy="50" r="4" fill="#ffffff" stroke="#3a4656" stroke-width="1.5"/>`),
    [],
  );
  assert.deepEqual(
    auditMini(`<circle cx="50" cy="50" r="4" fill="#ffffff" stroke="#3a4656"/>`),
    [],
  );
});
// A page-coloured channel (fill or stroke) is not a mark only when the element's other
// channel is painted and itself passes as a mark: the white halo around a filled dot, the
// page-coloured centre of a hollow ring. A page-coloured series line, edge or ring with
// nothing else painted is invisible, and is reported. Both channels, both themes.
const themed = (rules, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">` +
  `<style>@media (prefers-color-scheme: dark){rect[fill="#ffffff"]{fill:#0d1117}${rules}}</style>` +
  `<rect width="400" height="200" fill="#ffffff"/>${body}</svg>`;
const auditThemed = (rules, body) =>
  auditSvg(themed(rules, body), { minText: MIN_TEXT, minBoxText: MIN_BOX_TEXT });
test("a page-coloured channel is exempt only when the other channel is painted and passes as a mark", () => {
  // light: a page-coloured stroke with nothing else painted
  for (const [mark, tag] of [
    [`<polyline points="20,20 200,20" fill="none" stroke="#ffffff"/>`, "polyline"],
    [`<line x1="20" y1="20" x2="200" y2="20" stroke="#ffffff"/>`, "line"],
    [`<path d="M20 20L200 20" fill="none" stroke="#ffffff"/>`, "path"],
    [`<circle cx="50" cy="50" r="4" fill="none" stroke="#ffffff"/>`, "circle"],
    [`<rect x="20" y="20" width="200" height="12" fill="none" stroke="#ffffff"/>`, "rect"],
    // the other channel painted but itself too faint to be a mark
    [`<circle cx="50" cy="50" r="4" fill="#f4f4f4" stroke="#ffffff"/>`, "circle"],
  ])
    assert.ok(
      auditMini(mark).some((i) => new RegExp(`^light: ${tag} stroke #ffffff at 1\\.00:1`).test(i)),
      `a page-coloured stroke with no visible mark under it passed: ${mark} → ${JSON.stringify(auditMini(mark))}`,
    );
  // both channels page-coloured: both reported
  const both = auditMini(`<circle cx="50" cy="50" r="4" fill="#ffffff" stroke="#ffffff"/>`);
  assert.ok(
    both.some((i) => /^light: circle fill #ffffff at 1\.00:1/.test(i)) &&
      both.some((i) => /^light: circle stroke #ffffff at 1\.00:1/.test(i)),
    `a dot page-coloured in both channels passed: ${JSON.stringify(both)}`,
  );
  // controls: the halo around a filled dot, the centre of a hollow ring
  assert.deepEqual(
    auditMini(`<circle cx="50" cy="50" r="4" fill="#3a4656" stroke="#ffffff" stroke-width="1.5"/>`),
    [],
  );
  assert.deepEqual(
    auditMini(`<circle cx="50" cy="50" r="4" fill="#ffffff" stroke="#3a4656"/>`),
    [],
  );
  // dark: a series stroke a dark rule turns into the dark page colour
  const line = auditThemed(
    `polyline[stroke="#3a4656"]{stroke:#0d1117}`,
    `<polyline points="20,20 200,20" fill="none" stroke="#3a4656"/>`,
  );
  assert.ok(
    line.some((i) => /^dark: polyline stroke #3a4656 at 1\.00:1/.test(i)) &&
      !line.some((i) => /^light:/.test(i)),
    `a series line in the dark page colour passed: ${JSON.stringify(line)}`,
  );
  // dark: the halo's dot fill turns faint, so the page-coloured halo is no longer exempt
  const halo = auditThemed(
    `circle[stroke="#ffffff"]{stroke:#0d1117}circle[fill="#3a4656"]{fill:#161b22}`,
    `<circle cx="50" cy="50" r="4" fill="#3a4656" stroke="#ffffff"/>`,
  );
  assert.ok(
    halo.some((i) => /^dark: circle stroke #ffffff at 1\.00:1/.test(i)) &&
      !halo.some((i) => /^light:/.test(i)),
    `a dark-theme halo around a faint dot passed: ${JSON.stringify(halo)}`,
  );
  // dark: the ring's stroke turns faint, so the page-coloured centre is no longer exempt
  const ring = auditThemed(
    `circle[fill="#ffffff"]{fill:#0d1117}circle[stroke="#3a4656"]{stroke:#161b22}`,
    `<circle cx="50" cy="50" r="4" fill="#ffffff" stroke="#3a4656"/>`,
  );
  assert.ok(
    ring.some((i) => /^dark: circle fill #ffffff at 1\.00:1/.test(i)) &&
      !ring.some((i) => /^light:/.test(i)),
    `a dark-theme ring with a faint stroke passed: ${JSON.stringify(ring)}`,
  );
  // dark controls: the same halo and ring with dark colours that pass
  assert.deepEqual(
    auditThemed(
      `circle[stroke="#ffffff"]{stroke:#0d1117}circle[fill="#3a4656"]{fill:#a7b6c8}`,
      `<circle cx="50" cy="50" r="4" fill="#3a4656" stroke="#ffffff"/>`,
    ),
    [],
  );
  assert.deepEqual(
    auditThemed(
      `circle[fill="#ffffff"]{fill:#0d1117}circle[stroke="#3a4656"]{stroke:#a7b6c8}`,
      `<circle cx="50" cy="50" r="4" fill="#ffffff" stroke="#3a4656"/>`,
    ),
    [],
  );
});

// The page is the first painted element. A full-canvas rect painted after a text or a mark
// is ordinary paint: it covers what is under it.
test("the page rect is the first painted element; a later full-canvas rect covers what is under it", () => {
  const doc = (body) =>
    auditSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">${body}</svg>`,
      { minText: MIN_TEXT, minBoxText: MIN_BOX_TEXT },
    );
  const full = (fill) => `<rect width="400" height="200" fill="${fill}"/>`;
  // white text, then a full-canvas black rect: the text is covered, and there is no page
  const late = doc(ink(20, 60, "under the page", "#ffffff") + full("#000000"));
  assert.ok(
    late.some((i) =>
      /"under the page" is covered by a rect drawn after it \(fill #000000\)/.test(i),
    ),
    `a text under a later full-canvas rect passed: ${JSON.stringify(late)}`,
  );
  assert.ok(
    late.some((i) => /no full-canvas background rect/.test(i)),
    `a full-canvas rect painted after a text was taken as the page: ${JSON.stringify(late)}`,
  );
  // a page first, then dark text, then a second full-canvas rect over it
  const second = doc(
    full("#ffffff") + ink(20, 60, "under a second page", "#1c2330") + full("#ffffff"),
  );
  assert.ok(
    second.some((i) => /"under a second page" is covered by a rect drawn after it/.test(i)),
    `a text under a second full-canvas rect passed: ${JSON.stringify(second)}`,
  );
  // a mark painted before the only full-canvas rect is hidden by it
  const mark = doc(`<circle cx="50" cy="50" r="4" fill="#3a4656"/>` + full("#ffffff"));
  assert.ok(
    mark.some((i) => /circle fill #3a4656 is hidden by a rect drawn after it/.test(i)),
    `a dot under a later full-canvas rect passed: ${JSON.stringify(mark)}`,
  );
  // control: the page first
  assert.deepEqual(doc(full("#ffffff") + ink(20, 60, "on the page", "#1c2330")), []);
});

// A mark is judged as drawn: over the rects painted under it that hold it (its backdrop)
// and under the rects painted after it that hold it (an opaque one hides it).
test("a mark wholly under a later opaque rect is hidden; one inside a frame is judged against it", () => {
  const cover = `<rect x="20" y="20" width="200" height="100" fill="#5a6b80"/>`;
  for (const [mark, tag, attr] of [
    [`<circle cx="50" cy="50" r="4" fill="#3a4656"/>`, "circle", "fill"],
    [`<polyline points="30,30 200,90" fill="none" stroke="#3a4656"/>`, "polyline", "stroke"],
    [`<line x1="30" y1="30" x2="200" y2="90" stroke="#3a4656"/>`, "line", "stroke"],
    [`<path d="M40 40L60 50L40 60z" fill="#3a4656"/>`, "path", "fill"],
  ]) {
    const issues = auditMini(mark + cover);
    for (const th of ["light", "dark"])
      assert.ok(
        issues.some((i) =>
          new RegExp(`^${th}: ${tag} ${attr} #3a4656 is hidden by a rect drawn after it`).test(i),
        ),
        `${th}: a mark under a later opaque rect passed: ${mark} → ${JSON.stringify(issues)}`,
      );
  }
  // a dark dot inside a dark box painted under it: invisible, whatever the page shows
  const inBox = auditMini(
    `<rect x="20" y="20" width="200" height="100" fill="#1c2330"/><circle cx="50" cy="50" r="4" fill="#1c2330"/>`,
  );
  assert.ok(
    inBox.some((i) => /^light: circle fill #1c2330 at 1\.00:1/.test(i)),
    `a dark dot on a dark box passed: ${JSON.stringify(inBox)}`,
  );
  // controls: an edge running under a box at one end only, a white dot drawn over the box
  // (judged against the box, where it would fail against the page), a dot beside the box
  assert.deepEqual(
    auditMini(`<line x1="0" y1="50" x2="60" y2="50" stroke="#3a4656"/>${cover}`),
    [],
  );
  assert.deepEqual(auditMini(`${cover}<circle cx="50" cy="50" r="4" fill="#ffffff"/>`), []);
  assert.deepEqual(auditMini(`<circle cx="300" cy="150" r="4" fill="#3a4656"/>${cover}`), []);
});

test("dark rules: a declaration on a property other than the selector's attribute is unsupported", () => {
  const style = (css) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">` +
    `<style>@media (prefers-color-scheme: dark){${css}}</style><rect width="400" height="200" fill="#ffffff"/>` +
    `<circle cx="50" cy="50" r="4" fill="#ff0000" stroke="#3a4656"/></svg>`;
  const audit = (css) => auditSvg(style(css), { minText: MIN_TEXT, minBoxText: MIN_BOX_TEXT });
  for (const css of [
    `circle[fill="#ff0000"]{stroke:#000000}`,
    `circle[stroke="#3a4656"]{fill:#0d1117}`,
    `circle[stroke="#3a4656"]{fill-opacity:.2}`,
    `circle[fill="#ff0000"]{fill:#ff4444;stroke:#000000}`,
  ])
    assert.throws(() => audit(css), /unsupported dark rule/, css);
  // controls: the same property as the selector's attribute
  assert.deepEqual(audit(`circle[fill="#ff0000"]{fill:#ff4444;fill-opacity:.9}`), []);
  assert.deepEqual(audit(`circle[stroke="#3a4656"]{stroke:#1c2330}`), []);
});

test("the svg's viewBox must match its width and height; rect, circle and path need a fill", () => {
  const doc = (svgAttrs, body = "") =>
    `<svg xmlns="http://www.w3.org/2000/svg" ${svgAttrs}><rect width="400" height="200" fill="#ffffff"/>${body}</svg>`;
  const audit = (s) => auditSvg(s, { minText: MIN_TEXT, minBoxText: MIN_BOX_TEXT });
  // a 13px text in a viewBox twice the canvas renders at 6.5px
  assert.throws(
    () =>
      audit(
        doc(`width="400" height="200" viewBox="0 0 800 400"`, ink(20, 60, "scaled", "#1c2330")),
      ),
    /unsupported viewBox/,
  );
  assert.deepEqual(
    audit(doc(`width="400" height="200" viewBox="0 0 400 200"`, ink(20, 60, "1:1", "#1c2330"))),
    [],
  );
  // a nested <svg> opens a new viewport (its own viewBox scales what it holds)
  assert.throws(
    () =>
      audit(
        doc(
          `width="400" height="200" viewBox="0 0 400 200"`,
          `<svg width="400" height="200" viewBox="0 0 800 400">${ink(20, 60, "nested", "#1c2330")}</svg>`,
        ),
      ),
    /unsupported markup "<svg/,
  );
  // an element without a fill attribute is filled black, which no dark rule can select
  for (const body of [
    `<rect x="20" y="20" width="50" height="20"/>`,
    `<circle cx="50" cy="50" r="4" stroke="#3a4656"/>`,
    `<path d="M20 20L200 20" stroke="#3a4656"/>`,
  ])
    assert.throws(
      () => audit(doc(`width="400" height="200" viewBox="0 0 400 200"`, body)),
      /unsupported .*no fill/,
      body,
    );
});

test("an SVG without a full-canvas background rect is reported, not thrown on", () => {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">` +
    `${ink(20, 60, "no page", "#1c2330")}</svg>`;
  let issues;
  assert.doesNotThrow(() => {
    issues = auditSvg(svg, { minText: MIN_TEXT, minBoxText: MIN_BOX_TEXT });
  });
  assert.ok(
    issues.some((i) => /background/.test(i)),
    `missing background not reported: ${JSON.stringify(issues)}`,
  );
  // the rest of the audit still runs, against white
  assert.ok(
    auditSvg(svg.replace("#1c2330", "#f4f4f4"), {
      minText: MIN_TEXT,
      minBoxText: MIN_BOX_TEXT,
    }).some((i) => /no page/.test(i) && /4\.5:1/.test(i)),
  );
});

test("an element's own translate() places it, self-closing ones included", () => {
  const dark = `<rect x="200" y="40" width="160" height="40" fill="#1c2330"/>`;
  const own = (fill) =>
    `<text x="20" y="64" font-size="13" fill="${fill}" transform="translate(200)">t</text>`;
  assert.deepEqual(auditMini(dark + own("#ffffff")), [], "white ink moved onto the dark rect");
  assert.ok(
    auditMini(dark + own("#1c2330")).some((i) => /4\.5:1/.test(i)),
    "dark ink moved onto the dark rect passed",
  );
  // a self-closing rect moved under the text is its backdrop
  assert.ok(
    auditMini(
      `<rect x="0" y="40" width="160" height="40" fill="#1c2330" transform="translate(200 0)"/>` +
        `<text x="220" y="64" font-size="13" fill="#1c2330">t</text>`,
    ).some((i) => /4\.5:1/.test(i)),
    "a translated self-closing rect was not the text's backdrop",
  );
});
test("any transform other than translate() is unsupported, on any element", () => {
  for (const body of [
    `<text x="20" y="64" font-size="13" fill="#1c2330" transform="rotate(90)">t</text>`,
    `<rect x="0" y="40" width="10" height="10" fill="#1c2330" transform="scale(2)"/>`,
    `<g transform="rotate(90)"/>`,
    `<g transform="matrix(1 0 0 1 5 5)"><circle cx="5" cy="5" r="3" fill="#1c2330"/></g>`,
  ])
    assert.throws(() => auditMini(body), /unsupported/, body);
});
test("the audit certifies only the allowlisted SVG subset; anything else is unsupported", () => {
  const refused = [
    [`<ellipse cx="50" cy="50" rx="4" ry="2" fill="#1c2330"/>`, /unsupported element <ellipse>/],
    [`<text x="20" y="64" font-size="13" fill="#1c2330"><tspan>t</tspan></text>`, /<tspan>/],
    [`<!-- a comment -->`, /unsupported markup/],
    [
      `<rect x="0" y="0" width="9" height="9" fill="#1c2330" stroke-dasharray="2 2"/>`,
      /stroke-dasharray/,
    ],
    [`<path d="M0 0C1 1 2 2 3 3" fill="none" stroke="#1c2330"/>`, /d="M0 0C1 1 2 2 3 3"/],
    [
      `<polyline points="0,0 9,9" fill="#1c2330" stroke="#1c2330"/>`,
      /fill="#1c2330" on <polyline>/,
    ],
    [
      `<text x="20" y="64" font-size="13" fill="#1c2330" font-weight="bold">t</text>`,
      /font-weight/,
    ],
    [`<text x="20" y="64" font-size="13" fill="#1c2330">a &quot;b&quot;</text>`, /entity/],
    [`<rect x='0' y="0" width="9" height="9" fill="#1c2330"/>`, /unsupported markup/],
  ];
  for (const [body, why] of refused) assert.throws(() => auditMini(body), why, body);
  // a dark rule outside the tag[attr="value"]{fill|stroke|fill-opacity} form
  const style = (css) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">` +
    `<style>@media (prefers-color-scheme: dark){${css}}</style><rect width="400" height="200" fill="#ffffff"/></svg>`;
  assert.deepEqual(
    auditSvg(style(`rect[fill="#ffffff"]{fill:#0d1117}`), {
      minText: MIN_TEXT,
      minBoxText: MIN_BOX_TEXT,
    }),
    [],
  );
  for (const css of [`.dark{fill:#000}`, `rect[fill="#ffffff"]{opacity:.5}`])
    assert.throws(
      () => auditSvg(style(css), { minText: MIN_TEXT, minBoxText: MIN_BOX_TEXT }),
      /unsupported dark rule/,
      css,
    );
});
// ---- one geometry model per shape ----
// Every predicate reads a shape's geometry through one primitive (shapeOf in _svg-audit.mjs):
// where its fill paints, where its stroke's ring paints, and what lies inside its stroke's
// inner edge. The concrete cases below each broke a predicate that carried its own idea of
// a shape; the matrix after them runs every predicate over every shape kind in both themes,
// so a predicate that bypasses the primitive fails here.
const GEO_RULES =
  `rect[fill="#ffffff"]{fill:#0d1117}` +
  `rect[fill="#1c2330"],circle[fill="#1c2330"],path[fill="#1c2330"],text[fill="#1c2330"]{fill:#e6edf3}` +
  `text[fill="#ffffff"],circle[fill="#ffffff"],path[fill="#ffffff"]{fill:#0d1117}` +
  `rect[fill="#f2f2f2"],circle[fill="#f2f2f2"],path[fill="#f2f2f2"]{fill:#161b22}` +
  `rect[stroke="#1c2330"],circle[stroke="#1c2330"],path[stroke="#1c2330"]{stroke:#e6edf3}` +
  `rect[stroke="#f2f2f2"],circle[stroke="#f2f2f2"],path[stroke="#f2f2f2"]{stroke:#161b22}`;
// the page (white, #0d1117 in dark) unless `page` is false; the body after it
const geoSvg = (body, page = true) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">` +
  `<style>@media (prefers-color-scheme: dark){${GEO_RULES}}</style>` +
  `${page ? `<rect width="400" height="200" fill="#ffffff"/>` : ""}${body}</svg>`;
const auditGeo = (body, page) =>
  auditSvg(geoSvg(body, page), { minText: MIN_TEXT, minBoxText: MIN_BOX_TEXT });
const geoText = (x, y, fill, { size = 13, anchor = "start", s = "ab" } = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}"${anchor === "start" ? "" : ` text-anchor="${anchor}"`}>${s}</text>`;
const dot = ([cx, cy], fill) => `<circle cx="${cx}" cy="${cy}" r="4" fill="${fill}"/>`;
const strokeAttr = (stroke) => (stroke ? ` stroke="${stroke}"` : "");
// Each kind: draw(fill, stroke), and probe points in its own coordinates. `centre` (a
// middle-anchored text baseline and a dot centre) lies inside every kind's fill; `corner`
// (a text baseline) and `cornerDot` lie inside the kind's bounding box, inside a square
// rect's fill and an outline's inner edge, and clear of a rounded rect's, a circle's and a
// diamond's fill; `edge` (a text baseline) puts the glyph box across the fill's boundary.
const KINDS = {
  square: {
    draw: (fill, stroke) =>
      `<rect x="60" y="20" width="280" height="160" fill="${fill}"${strokeAttr(stroke)}/>`,
    tag: "rect",
    filled: true,
    cornerFilled: true,
    figureBox: true,
    corner: [63, 33],
    cornerDot: [68, 28],
    edge: [55, 104],
  },
  rounded: {
    draw: (fill, stroke) =>
      `<rect x="60" y="20" width="280" height="160" rx="70" fill="${fill}"${strokeAttr(stroke)}/>`,
    tag: "rect",
    filled: true,
    cornerFilled: false,
    figureBox: true,
    corner: [63, 33],
    cornerDot: [68, 28],
    edge: [74, 44],
  },
  circle: {
    draw: (fill, stroke) =>
      `<circle cx="200" cy="100" r="80" fill="${fill}"${strokeAttr(stroke)}/>`,
    tag: "circle",
    filled: true,
    cornerFilled: false,
    figureBox: false,
    corner: [123, 33],
    cornerDot: [128, 28],
    edge: [137, 47],
  },
  diamond: {
    draw: (fill, stroke) =>
      `<path d="M200 20L340 100L200 180L60 100z" fill="${fill}"${strokeAttr(stroke)}/>`,
    tag: "path",
    filled: true,
    cornerFilled: false,
    figureBox: false,
    corner: [63, 33],
    cornerDot: [68, 28],
    edge: [124, 62],
  },
  // an outline-only rect: no fill, a visible border
  outline: {
    draw: (_fill, stroke) =>
      `<rect x="60" y="20" width="280" height="160" fill="none" stroke="${stroke || "#1c2330"}" stroke-width="2"/>`,
    tag: "rect",
    filled: false,
    cornerFilled: false,
    figureBox: true,
    corner: [63, 33],
    cornerDot: [68, 28],
    edge: [55, 104],
  },
};
const CENTRE = [200, 104];
const CENTRE_DOT = [200, 100];
const both = (issues, re) => ["light", "dark"].every((th) => issues.some((i) => re(th).test(i)));
const none = (issues, re) => !issues.some((i) => re.test(i));

test("finding 1: a dark filled circle is the backdrop of the text and the dot painted over it", () => {
  // a dark circle, then text in its colour: unreadable, though it would pass on the page
  const txt = auditGeo(
    KINDS.circle.draw("#1c2330") + geoText(...CENTRE, "#1c2330", { anchor: "middle" }),
  );
  assert.ok(
    both(txt, (th) => new RegExp(`^${th}: "ab" #1c2330 at 1\\.00:1`)),
    `text the colour of the circle under it passed: ${JSON.stringify(txt)}`,
  );
  // a smaller dot of the same colour wholly inside it
  const inner = auditGeo(KINDS.circle.draw("#1c2330") + dot(CENTRE_DOT, "#1c2330"));
  assert.ok(
    both(inner, (th) => new RegExp(`^${th}: circle fill #1c2330 at 1\\.00:1`)),
    `a dot the colour of the circle under it passed: ${JSON.stringify(inner)}`,
  );
});

test("finding 2: a canvas-sized rect with rounded corners is not the page", () => {
  // a black canvas-sized rect with rx: its corners are transparent, so white text in a
  // corner sits on the reader's surface, not on black
  const issues = auditSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">` +
      `<rect width="400" height="200" rx="60" fill="#000000"/>${geoText(2, 11, "#ffffff")}</svg>`,
    { minText: MIN_TEXT, minBoxText: MIN_BOX_TEXT },
  );
  assert.ok(
    issues.some((i) => /no full-canvas background rect/.test(i)),
    `a rounded canvas-sized rect was taken as the page: ${JSON.stringify(issues)}`,
  );
  assert.ok(
    issues.some((i) => /^light: "ab" #ffffff/.test(i)),
    `white text in a transparent corner passed: ${JSON.stringify(issues)}`,
  );
});

test("finding 3: text in a rounded rect's clipped corner is not framed by the rect", () => {
  // white text in the corner of a dark rounded rect, clear of its fill: on the page
  const corner = auditGeo(
    KINDS.rounded.draw("#1c2330") + geoText(...KINDS.rounded.corner, "#ffffff"),
  );
  assert.ok(
    both(corner, (th) => new RegExp(`^${th}: "ab" #ffffff at 1\\.00:1`)),
    `white text in a clipped corner was judged against the rect: ${JSON.stringify(corner)}`,
  );
  // text across the corner's arc crosses the fill's edge
  const arc = auditGeo(KINDS.rounded.draw("#1c2330") + geoText(...KINDS.rounded.edge, "#1c2330"));
  assert.ok(
    arc.some((i) => /"ab" crosses the edge of the rect painted under it/.test(i)),
    `text across a rounded corner's arc was framed by the rect: ${JSON.stringify(arc)}`,
  );
});

test("finding 4: an outline-only rect with a visible border is a figure box", () => {
  const box = (stroke) =>
    `<rect x="60" y="20" width="280" height="160" fill="none" stroke="${stroke}"/>` +
    geoText(...CENTRE, "#1c2330", { size: 10, anchor: "middle" });
  assert.ok(
    auditGeo(box("#1c2330")).some((i) => /"ab" is 10px inside a figure box/.test(i)),
    "10px text inside an outline-only box passed the box floor",
  );
  // a border of alpha 0 is not visible: no box
  assert.ok(
    none(auditGeo(box("rgba(0,0,0,0)")), /figure box/),
    "an invisible border made a figure box",
  );
});

test("the shape primitive: fill, stroke ring and inner edge per shape kind", () => {
  const { shapeOf } = svgAudit;
  assert.equal(typeof shapeOf, "function", "_svg-audit.mjs exports shapeOf");
  const el = (tag, a) => ({ tag, a, dx: 0, dy: 0 });
  // a rounded rect: corners clamped per axis (rx 30 on a 100x20 rect is 30 by 10)
  const rr = shapeOf(
    el("rect", { x: "0", y: "0", width: "100", height: "20", rx: "30", fill: "#000" }),
  );
  assert.ok(rr.fillContains([30, 0, 70, 20]), "the straight middle is filled");
  assert.ok(!rr.fillContains([0, 0, 4, 4]), "a clipped corner is not filled");
  assert.ok(!rr.fillMeets([0, 0, 2, 2]), "a box in the clipped corner meets no fill");
  assert.ok(rr.fillMeets([0, 8, 4, 12]), "the corner's arc reaches the left edge at mid-height");
  assert.ok(!rr.fillCoversCanvas(100, 20), "a rounded rect does not cover its own bounds");
  // a circle: its disk, and its stroke's ring
  const c = shapeOf(
    el("circle", {
      cx: "50",
      cy: "50",
      r: "20",
      fill: "none",
      stroke: "#000",
      "stroke-width": "2",
    }),
  );
  assert.ok(!c.fillMeets([45, 45, 55, 55]), "an unfilled circle has no fill");
  assert.ok(c.holds([45, 45, 55, 55]), "the ring's hole holds a box at the centre");
  assert.ok(!c.strokeMeets([45, 45, 55, 55]), "the ring does not reach the centre");
  assert.ok(c.strokeMeets([65, 45, 75, 55]), "the ring crosses a box on its edge");
  assert.ok(!c.holds([60, 45, 70, 55]), "a box under the ring is not inside the inner edge");
  // a path's fill (nonzero, implicitly closed) and its outline
  const tri = shapeOf(el("path", { d: "M0 0L100 0L0 100", fill: "#000" }));
  assert.ok(tri.fillContains([5, 5, 20, 20]) && !tri.fillMeets([60, 60, 90, 90]));
  // an outline-only rect: no fill; inside its inner edge; its ring
  const o = shapeOf(
    el("rect", {
      x: "0",
      y: "0",
      width: "100",
      height: "50",
      fill: "none",
      stroke: "#000",
      "stroke-width": "4",
    }),
  );
  assert.ok(!o.fillMeets([10, 10, 20, 20]) && o.holds([10, 10, 20, 20]));
  assert.ok(!o.holds([1, 10, 20, 20]), "a box under the border is not inside the inner edge");
  assert.ok(o.strokeMeets([-5, 10, 1, 20]) && !o.strokeMeets([10, 10, 20, 20]));
  // a canvas-covering circle and a canvas-sized square rect cover the canvas
  assert.ok(
    shapeOf(el("circle", { cx: "200", cy: "100", r: "230", fill: "#fff" })).fillCoversCanvas(
      400,
      200,
    ),
  );
  assert.ok(
    !shapeOf(el("circle", { cx: "200", cy: "100", r: "200", fill: "#fff" })).fillCoversCanvas(
      400,
      200,
    ),
  );
});

// the matrix: [predicate, kind] → one test, each asserting both themes where the outcome
// is a contrast
const MATRIX = {
  // page selection: the first painted element is the page when its fill covers the canvas
  page: (k) => {
    const canvas = {
      square: `<rect width="400" height="200" fill="#ffffff"/>`,
      rounded: `<rect width="400" height="200" rx="30" fill="#ffffff"/>`,
      circle: `<circle cx="200" cy="100" r="230" fill="#ffffff"/>`,
      diamond: `<path d="M200 0L400 100L200 200L0 100z" fill="#ffffff"/>`,
      outline: `<rect width="400" height="200" fill="none" stroke="#1c2330"/>`,
    }[k];
    const covers = k === "square" || k === "circle";
    const issues = auditGeo(canvas + geoText(...CENTRE, "#1c2330", { anchor: "middle" }), false);
    if (covers) assert.deepEqual(issues, [], "a canvas-covering fill is the page in both themes");
    else
      assert.ok(
        issues.some((i) => /no full-canvas background rect/.test(i)),
        `a fill that leaves the canvas's corners bare was taken as the page: ${JSON.stringify(issues)}`,
      );
    if (k === "circle")
      assert.ok(
        auditGeo(
          `<circle cx="200" cy="100" r="200" fill="#ffffff"/>${geoText(...CENTRE, "#1c2330", { anchor: "middle" })}`,
          false,
        ).some((i) => /no full-canvas background rect/.test(i)),
        "a circle short of the canvas's corners was taken as the page",
      );
  },
  // text frame: the backdrop of a text inside the fill is the fill
  frame: (k, K) => {
    const same = auditGeo(K.draw("#1c2330") + geoText(...CENTRE, "#1c2330", { anchor: "middle" }));
    const white = auditGeo(K.draw("#1c2330") + geoText(...CENTRE, "#ffffff", { anchor: "middle" }));
    const fails = (issues, ink) =>
      both(issues, (th) => new RegExp(`^${th}: "ab" ${ink} at 1\\.00:1`));
    if (K.filled) {
      assert.ok(
        fails(same, "#1c2330"),
        `same-coloured text on the ${k} passed: ${JSON.stringify(same)}`,
      );
      assert.deepEqual(white, [], `white text on the ${k} was not judged against it`);
    } else {
      assert.deepEqual(same, [], "an outline is not a backdrop");
      assert.ok(
        fails(white, "#ffffff"),
        `white text in an outline was not judged against the page`,
      );
    }
  },
  // text in the bounding box's corner: framed only where the fill reaches
  corner: (k, K) => {
    const issues = auditGeo(K.draw("#1c2330") + geoText(...K.corner, "#ffffff"));
    if (K.cornerFilled)
      assert.deepEqual(issues, [], `the ${k}'s filled corner is not the backdrop`);
    else {
      assert.ok(
        both(issues, (th) => new RegExp(`^${th}: "ab" #ffffff at 1\\.00:1`)),
        `white text in the ${k}'s bare corner was judged against its fill: ${JSON.stringify(issues)}`,
      );
      assert.ok(none(issues, /crosses the edge/), `text clear of the ${k}'s fill crossed it`);
    }
  },
  // a glyph box across the fill's boundary, the fill painted before the text
  crossing: (k, K) => {
    const issues = auditGeo(K.draw("#1c2330") + geoText(...K.edge, "#1c2330"));
    const re = new RegExp(`"ab" crosses the edge of the ${K.tag} painted under it`);
    if (K.filled)
      assert.ok(
        issues.some((i) => re.test(i)),
        `text across the ${k}'s edge passed: ${JSON.stringify(issues)}`,
      );
    else assert.ok(none(issues, /crosses the edge/), "an outline has no fill to cross");
  },
  // a fill painted after a text over its glyph box covers it; one clear of it does not
  cover: (k, K) => {
    const over = auditGeo(geoText(...CENTRE, "#1c2330", { anchor: "middle" }) + K.draw("#f2f2f2"));
    const corner = auditGeo(geoText(...K.corner, "#1c2330") + K.draw("#f2f2f2"));
    const re = new RegExp(`"ab" is covered by a ${K.tag} drawn after it`);
    assert.equal(
      over.some((i) => re.test(i)),
      K.filled,
      `${k} over a text: ${JSON.stringify(over)}`,
    );
    assert.equal(
      corner.some((i) => /is covered by/.test(i)),
      K.cornerFilled,
      `${k} over a text in its corner: ${JSON.stringify(corner)}`,
    );
  },
  // a mark's backdrop: the fill painted under it that holds it
  markBackdrop: (k, K) => {
    const same = auditGeo(K.draw("#1c2330") + dot(CENTRE_DOT, "#1c2330"));
    const cornerWhite = auditGeo(K.draw("#1c2330") + dot(K.cornerDot, "#ffffff"));
    const fails = (issues, fill) =>
      both(issues, (th) => new RegExp(`^${th}: circle fill ${fill} at 1\\.00:1`));
    if (K.filled)
      assert.ok(
        fails(same, "#1c2330"),
        `a dot the colour of the ${k} under it passed: ${JSON.stringify(same)}`,
      );
    else assert.deepEqual(same, [], "an outline is not a mark's backdrop");
    if (K.cornerFilled)
      assert.deepEqual(cornerWhite, [], `a white dot on the ${k}'s filled corner failed`);
    else
      assert.ok(
        fails(cornerWhite, "#ffffff"),
        `a white dot in the ${k}'s bare corner was judged against its fill: ${JSON.stringify(cornerWhite)}`,
      );
  },
  // a mark under a later opaque fill that holds it is hidden
  markCover: (k, K) => {
    const hid = (issues) =>
      both(
        issues,
        (th) => new RegExp(`^${th}: circle fill #1c2330 is hidden by a ${K.tag} drawn after it`),
      );
    const centre = auditGeo(dot(CENTRE_DOT, "#1c2330") + K.draw("#f2f2f2"));
    const corner = auditGeo(dot(K.cornerDot, "#1c2330") + K.draw("#f2f2f2"));
    assert.equal(hid(centre), K.filled, `${k} over a dot: ${JSON.stringify(centre)}`);
    assert.equal(
      hid(corner),
      K.cornerFilled,
      `${k} over a dot in its corner: ${JSON.stringify(corner)}`,
    );
  },
  // a shape holding a text is that text's frame, not a mark; one holding none is a mark
  markExempt: (k, K) => {
    const attr = K.filled ? "fill" : "stroke";
    const re = (th) => new RegExp(`^${th}: ${K.tag} ${attr} #f2f2f2 at`);
    const framing = auditGeo(
      K.draw("#f2f2f2", K.filled ? undefined : "#f2f2f2") +
        geoText(...CENTRE, "#1c2330", { anchor: "middle" }),
    );
    const corner = auditGeo(
      K.draw("#f2f2f2", K.filled ? undefined : "#f2f2f2") + geoText(...K.corner, "#1c2330"),
    );
    assert.ok(
      none(framing, /#f2f2f2 at/),
      `the ${k} framing a text was judged as a mark: ${JSON.stringify(framing)}`,
    );
    if (K.cornerFilled || !K.filled)
      assert.ok(none(corner, /#f2f2f2 at/), `the ${k} holding a corner text was judged as a mark`);
    else
      assert.ok(
        both(corner, re),
        `the ${k} with a text clear of its fill was exempt: ${JSON.stringify(corner)}`,
      );
  },
  // a figure box: a rect, filled or not, with a visible border holding the glyph box
  figureBox: (k, K) => {
    const bordered = K.draw(K.filled ? "#ffffff" : "none", "#1c2330");
    const centre = auditGeo(
      bordered + geoText(...CENTRE, "#1c2330", { size: 10, anchor: "middle" }),
    );
    const corner = auditGeo(bordered + geoText(...K.corner, "#1c2330", { size: 10 }));
    const boxed = (issues) => issues.some((i) => /"ab" is 10px inside a figure box/.test(i));
    assert.equal(
      boxed(centre),
      K.figureBox,
      `10px text centred in the bordered ${k}: ${JSON.stringify(centre)}`,
    );
    assert.equal(
      boxed(corner),
      K.figureBox && (K.cornerFilled || !K.filled),
      `10px text in the bordered ${k}'s corner: ${JSON.stringify(corner)}`,
    );
  },
  // the overlap check: a text collides with a stroke's ring or outline where the ring meets
  // its glyph box, not inside a hollow shape's hole nor in a rounded or round shape's bare
  // corner; painted before or after the text alike
  strokeOverlap: (k, K) => {
    const ring = K.draw("none", "#1c2330");
    const re = new RegExp(
      `"ab" \\(box [^)]*\\) overlaps the ${K.tag} stroke drawn (before|after) it`,
    );
    for (const [where, text, hit] of [
      ["edge", geoText(...K.edge, "#1c2330"), true],
      ["centre", geoText(...CENTRE, "#1c2330", { anchor: "middle" }), false],
      ["corner", geoText(...K.corner, "#1c2330"), false],
    ])
      for (const body of [ring + text, text + ring]) {
        const issues = auditGeo(body);
        assert.equal(
          issues.some((i) => re.test(i)),
          hit,
          `${where} text and the ${k}'s stroke: ${JSON.stringify(issues)}`,
        );
      }
  },
};
for (const [pred, fn] of Object.entries(MATRIX))
  for (const [k, K] of Object.entries(KINDS))
    test(`geometry matrix: ${pred} x ${k}`, () => fn(k, K));

test("every committed chart, LEGACY ones included, is inside the audit's allowlist", () => {
  for (const f of readdirSync(chartsDir).filter((f) => f.endsWith(".svg")))
    assert.doesNotThrow(
      () =>
        auditSvg(readFileSync(new URL(f, chartsDir), "utf8"), {
          minText: MIN_TEXT,
          minBoxText: MIN_BOX_TEXT,
        }),
      f,
    );
});

test("the audit checks stroke-only marks: tile outlines, hollow dots, arrows", () => {
  const faint = "#d0d4d8"; // ~1.4:1 on white
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60" viewBox="0 0 200 60"><rect width="200" height="60" fill="#ffffff"/><rect x="10" y="10" width="8" height="8" fill="none" stroke="${faint}"/><circle cx="40" cy="20" r="4" fill="#ffffff" stroke="${faint}"/><line x1="60" y1="20" x2="100" y2="20" stroke="${faint}"/><path d="M100 20L94 17L94 23z" fill="${faint}"/><line x1="0" y1="50" x2="200" y2="50" stroke="#e4e8ec"/></svg>`;
  const issues = auditSvg(svg, { minText: MIN_TEXT, minBoxText: MIN_BOX_TEXT });
  for (const what of ["rect stroke", "circle stroke", "line stroke", "path fill"])
    assert.ok(
      issues.some((i) => i.includes(what)),
      `audit missed a faint ${what}: ${issues}`,
    );
  assert.ok(
    !issues.some((i) => i.includes("#e4e8ec")),
    "a GRID hairline is decoration, not a mark",
  );
});

// The audit's overlap check: a text's estimated box (per-glyph Arial / Arial Bold
// advances x 1.1, so a wider system-ui face such as DejaVu Sans fits inside it) must not
// meet a mark drawn after it or the box of another text, except a rect that frames it and
// a GRID hairline.
// the collision issues: overlaps, covers and crossings of a rect's edge
const overlapIssues = (body) =>
  auditMini(body).filter((i) => /overlap|is covered by|crosses the edge/.test(i));
const label = (x, y, s, extra = "") =>
  `<text x="${x}" y="${y}" font-size="11" fill="#1c2330"${extra}>${s}</text>`;
test("the audit flags a text whose box runs into a bar drawn after it", () => {
  // "a label that runs on into the bar" at 11px is ~190px in Arial x 1.1: from x=20 it
  // reaches past the bar at x=150
  const issues = overlapIssues(
    label(20, 60, "a label that runs on into the bar") +
      `<rect x="150" y="50" width="120" height="13" fill="#3f4b5b"/>`,
  );
  assert.ok(
    issues.some((i) => /runs on into the bar/.test(i) && /rect/.test(i)),
    `overlap not flagged: ${JSON.stringify(issues)}`,
  );
});
test("the audit flags a stroked line drawn after a text across its glyphs", () => {
  const issues = overlapIssues(
    label(20, 60, "a label crossed by an axis line") +
      `<line x1="120" y1="40" x2="120" y2="80" stroke="#3a4656"/>`,
  );
  assert.ok(
    issues.some((i) => /crossed by an axis/.test(i) && /line/.test(i)),
    `line overlap not flagged: ${JSON.stringify(issues)}`,
  );
});
test("the audit flags two texts whose boxes overlap, and an end-anchored one", () => {
  const issues = overlapIssues(label(20, 60, "the first text is long") + label(90, 62, "second"));
  assert.ok(
    issues.some((i) => /second/.test(i) && /first text/.test(i)),
    `text-text overlap not flagged: ${JSON.stringify(issues)}`,
  );
  const end = overlapIssues(
    label(20, 60, "left") + label(120, 60, "right-aligned and long", ` text-anchor="end"`),
  );
  assert.ok(end.length > 0, `end-anchored text over another not flagged: ${end}`);
});
test("the audit flags a text whose box runs off the canvas", () => {
  // miniSvg is 400 wide: an end-anchored text past x=0, a start-anchored one past 400
  assert.ok(
    auditMini(label(380, 60, "runs past the right edge")).some((i) => /off the 400x200/.test(i)),
  );
  assert.ok(
    auditMini(label(30, 60, "runs past the left edge", ` text-anchor="end"`)).some((i) =>
      /off the/.test(i),
    ),
  );
  assert.deepEqual(auditMini(label(20, 60, "inside")), []);
});
test("the audit passes a text that clears its neighbours (no-overlap guard)", () => {
  assert.deepEqual(
    overlapIssues(
      label(20, 60, "a short label") +
        `<rect x="150" y="50" width="120" height="13" fill="#3f4b5b"/>` +
        label(277, 60, "58.1s", ` font-weight="600"`) +
        label(20, 80, "a second line below the first") +
        `<line x1="140" y1="30" x2="140" y2="100" stroke="#e4e8ec"/>`,
    ),
    [],
  );
  // a GRID hairline through a text is decoration, not an overlap
  assert.deepEqual(
    overlapIssues(
      label(20, 60, "over a gridline") + `<line x1="50" y1="40" x2="50" y2="80" stroke="#e4e8ec"/>`,
    ),
    [],
  );
});
test("the audit exempts the rect that frames a text, and only that rect", () => {
  // an outline drawn after the text around it frames it
  assert.deepEqual(
    overlapIssues(
      label(30, 60, "framed text") +
        `<rect x="20" y="45" width="120" height="25" fill="none" stroke="#3a4656"/>`,
    ),
    [],
  );
  // a rect drawn after the text that frames ANOTHER text (anchored low in it, clear of
  // this one) is not this text's frame: its outline crossing this text's tail is reported,
  // naming the rect
  const issues = overlapIssues(
    label(30, 60, "a text whose tail is under a box") +
      `<rect x="100" y="45" width="120" height="60" fill="none" stroke="#3a4656"/>${label(110, 95, "box")}`,
  );
  assert.ok(
    issues.some(
      (i) => /tail is under/.test(i) && /overlaps the rect stroke drawn after it/.test(i),
    ),
    `a rect framing another text exempted this one: ${JSON.stringify(issues)}`,
  );
  assert.ok(
    !issues.some((i) => /"box"/.test(i)),
    `the other text collides on its own, so the fixture tests nothing: ${issues}`,
  );
});
test("the chart kit measures text with the audit's estimate", () => {
  assert.equal(typeof textWidth, "function", "_text-width.mjs exports textWidth");
  for (const [s, px, bold] of [
    ["the whole workspace's source, once", 10, false],
    ["58.9s batch · 10.3s sliced", 11, false],
    ["per-package pipeline", 12, true],
  ])
    assert.equal(approxW(s, px, bold), textWidth(s, px, bold ? "600" : ""));
  // the audit's box for a text is that width: a rect drawn after the text starting just
  // past it passes, one starting just inside it is an overlap
  const s = "the whole workspace's source, once";
  const w = textWidth(s, 10);
  const at = (x) =>
    auditMini(
      `<text x="20" y="60" font-size="10" fill="#1c2330">${s}</text><rect x="${x}" y="50" width="40" height="13" fill="#3f4b5b"/>`,
    ).filter((i) => /overlap|is covered by/.test(i));
  assert.deepEqual(at(20 + w + 0.5), []);
  assert.ok(at(20 + w - 0.5).length > 0, "a rect inside the text's estimated width passed");
});

test("the width estimate holds the widest system-ui face, DejaVu Sans", () => {
  // advances of these strings in DejaVu Sans 2.37 (px, at the size given), read from the
  // font files; each must fit inside the estimate, as must Arial's x 1.1
  for (const [s, px, weight, dejavu] of [
    ["the whole workspace's source, once", 10, "", 180.6],
    ["a breaking rev turns all 30,000 apps red: 58.9s batch · 10.3s sliced", 11, "", 369.0],
    ["30,171 = 30,171", 13, "650", 120.3],
  ])
    assert.ok(
      textWidth(s, px, weight) >= dejavu,
      `"${s}" estimated ${textWidth(s, px, weight).toFixed(1)}px < DejaVu Sans ${dejavu}px`,
    );
});

test("a framing rect exempts a text only while the text's box fits inside its inner edge", () => {
  const frame = (x, w) =>
    `<rect x="${x}" y="40" width="${w}" height="34" rx="6" fill="#fcf4f0" stroke="#e2c0b0" stroke-width="1"/>`;
  // drawn before the text, the frame holds it: no issue
  assert.deepEqual(overlapIssues(frame(20, 220) + label(30, 61, "fits inside its box")), []);
  // the same text in a narrower frame runs across its right edge: reported, naming the rect
  const over = auditMini(frame(20, 100) + label(30, 61, "fits inside its box"));
  assert.ok(
    over.some(
      (i) => /fits inside/.test(i) && /crosses the edge of the rect painted under it/.test(i),
    ),
    `a text crossing its own frame's edge passed: ${JSON.stringify(over)}`,
  );
  // the inner edge is inset by half the stroke: a text ending on the stroke is reported
  const w = textWidth("edge", 11);
  const onStroke = overlapIssues(frame(20, 10 + w + 0.2) + label(30, 61, "edge"));
  assert.ok(onStroke.length > 0, "a text ending under its frame's stroke passed");
});
test("a fill painted before a text that its glyph box crosses collides, whatever the anchor", () => {
  // a label emitted after a filled bar, dot or arrowhead, its anchor outside the mark and
  // its glyphs over the fill: the fill is not the label's backdrop, so it collides
  const mark = "#3f4b5b";
  const cases = [
    [
      `<rect x="100" y="50" width="200" height="14" fill="${mark}"/>`,
      label(40, 60, "label over the bar"),
    ],
    [`<circle cx="100" cy="56" r="5" fill="${mark}"/>`, label(40, 60, "label over the dot")],
    [`<path d="M110 56L98 50L98 62z" fill="${mark}"/>`, label(40, 60, "label over the head")],
    [
      `<circle cx="60" cy="56" r="5" fill="${mark}"/>`,
      label(170, 60, "end-anchored over the dot", ' text-anchor="end"'),
    ],
    // a stripe of 3px or less is not a backdrop either
    [
      `<rect x="100" y="45" width="3" height="20" fill="${mark}"/>`,
      label(40, 60, "label over the stripe"),
    ],
  ];
  for (const [fill, text] of cases) {
    const issues = overlapIssues(fill + text);
    assert.ok(
      issues.some((i) =>
        /overlaps the (circle|path|rect) fill drawn before it|crosses the edge of the (rect|circle|path)/.test(
          i,
        ),
      ),
      `a label over a fill painted before it passed: ${fill}${text} -> ${JSON.stringify(issues)}`,
    );
  }
  // controls: the same labels clear of the marks
  assert.deepEqual(
    overlapIssues(
      `<rect x="250" y="50" width="100" height="14" fill="${mark}"/>` +
        `<circle cx="300" cy="100" r="5" fill="${mark}"/>` +
        `<path d="M310 140L298 134L298 146z" fill="${mark}"/>` +
        label(40, 60, "label over the bar") +
        label(40, 104, "label over the dot") +
        label(40, 144, "label over the head"),
    ),
    [],
  );
});
test("a filled rect painted after a text: its fill over the box covers it, its stroke alone collides", () => {
  const box = (y) =>
    `<rect x="40" y="${y}" width="100" height="20" fill="#ffffff" stroke="#3f4b5b" stroke-width="6"/>`;
  // the fill over the box: one covering issue
  const covered = overlapIssues(label(40, 60, "label by a box") + box(55));
  assert.deepEqual(
    covered.map((i) => i.replace(/ \(fill.*/, "")),
    ['"label by a box" is covered by a rect drawn after it'],
  );
  // the fill clear of the box, its stroke (outset by half its width) reaching it
  assert.ok(
    overlapIssues(label(40, 60, "label by a box") + box(63)).some((i) =>
      /overlaps the rect stroke drawn after it/.test(i),
    ),
    "a filled rect's stroke painted over the label passed",
  );
});
test("a stroke drawn before a text that crosses its box is an overlap, a hairline is not", () => {
  const series = `<polyline points="20,70 200,40" fill="none" stroke="#556375" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round"/>`;
  const issues = overlapIssues(series + label(60, 62, "10,185"));
  assert.ok(
    issues.some((i) => /10,185/.test(i) && /overlaps the polyline stroke drawn before it/.test(i)),
    `a series line under a label passed: ${JSON.stringify(issues)}`,
  );
  // clear of the line: no issue
  assert.deepEqual(overlapIssues(series + label(60, 40, "10,185")), []);
  // a GRID hairline, a filled backdrop drawn before: no issue
  assert.deepEqual(
    overlapIssues(
      `<line x1="70" y1="20" x2="70" y2="100" stroke="#e4e8ec"/>` +
        `<rect x="10" y="80" width="300" height="40" fill="#eef1f4"/>` +
        label(60, 62, "over a gridline") +
        label(20, 100, "on a backdrop"),
    ),
    [],
  );
  // the frame's own stroke is judged by the frame rule, not as a crossing stroke
  assert.deepEqual(
    overlapIssues(
      `<rect x="20" y="40" width="220" height="34" fill="none" stroke="#3a4656"/>` +
        label(30, 61, "framed"),
    ),
    [],
  );
});
test("a rounded frame's corners count: text in a corner square crosses the curve", () => {
  const pill = `<rect x="20" y="20" width="100" height="60" rx="30" fill="none" stroke="#000000"/>`;
  // inside the rectangular inner edge, but in the top-left corner the arc cuts through
  assert.ok(
    overlapIssues(pill + label(22, 35, "ab")).some((i) =>
      /overlaps the rect stroke drawn before it/.test(i),
    ),
    "text in a rounded corner passed",
  );
  // clear of the corners: no issue
  assert.deepEqual(overlapIssues(pill + label(55, 55, "ab")), []);
  // the kit's chip shape (rx 4, 20 tall) with a padded label passes
  assert.deepEqual(
    overlapIssues(
      `<rect x="20" y="40" width="70" height="20" rx="4" fill="#ffffff" stroke="#c9d3e6" stroke-width="1"/>` +
        `<text x="55" y="53.5" font-size="9.5" fill="#1c2330" text-anchor="middle">@demo libs</text>`,
    ),
    [],
  );
});
test("a dark rule may not select a none value (a dark-only paint the checks would skip)", () => {
  const svg = (css) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">` +
    `<style>@media (prefers-color-scheme: dark){${css}}</style><rect width="400" height="200" fill="#ffffff"/>` +
    `<line x1="20" y1="40" x2="200" y2="40" stroke="none"/></svg>`;
  for (const css of [`line[stroke="none"]{stroke:#000000}`, `rect[fill="none"]{fill:#000000}`])
    assert.throws(
      () => auditSvg(svg(css), { minText: MIN_TEXT, minBoxText: MIN_BOX_TEXT }),
      /unsupported dark rule selector/,
      css,
    );
});
test("the background rect may not carry a stroke", () => {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">` +
    `<rect width="400" height="200" fill="#ffffff" stroke="#000000" stroke-width="30"/>` +
    `<text x="5" y="20" font-size="13" fill="#1c2330">edge</text></svg>`;
  assert.throws(
    () => auditSvg(svg, { minText: MIN_TEXT, minBoxText: MIN_BOX_TEXT }),
    /unsupported stroke on the background rect/,
  );
});
test("one paint-order model: a filled rect painted over a text covers it, once", () => {
  // a small black rect painted after the label, over its anchor: one covering issue, not
  // also a frame-edge collision from a second rule
  const mine = auditMini(
    label(20, 60, "a long label under a patch") +
      `<rect x="15" y="50" width="40" height="15" fill="#000000"/>`,
  );
  assert.equal(mine.length, 1, JSON.stringify(mine));
  assert.match(mine[0], /"a long label under a patch" is covered by a rect drawn after it/);
  // an outline painted after the text around it still frames it
  assert.deepEqual(
    auditMini(
      label(30, 60, "framed") +
        `<rect x="20" y="45" width="120" height="25" fill="none" stroke="#3a4656"/>`,
    ),
    [],
  );
});
test("an untabled glyph is unsupported: the width estimate refuses it", () => {
  // œ is ~1.02 em in DejaVu Sans; a 0.66 em guess would let it overflow
  for (const s of ["œ", "tab\there", "e\u0301"])
    assert.throws(() => textWidth(s, 10), /unsupported glyph/, JSON.stringify(s));
  // every symbol the chart sources (kit, generators, derived-claim helpers) write is tabled
  for (const f of [
    "_chartstyle.mjs",
    "figures.mjs",
    "fleet-chart.mjs",
    "comparison-chart.mjs",
    "scale-chart.mjs",
    "net-cache-chart.mjs",
    "chart.mjs",
    "_net-cache-finding.mjs",
    "_install-speed-context.mjs",
  ]) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    for (const ch of new Set(src.match(/[^\x20-\x7e\n\r]/gu) || []))
      assert.doesNotThrow(() => textWidth(ch, 10), `${f}: "${ch}" is not tabled`);
  }
});
test("the GRID exemption covers hairlines only (stroke-width 1 or less)", () => {
  const across = (w) =>
    label(20, 60, "a label under a gridline") +
    `<line x1="60" y1="20" x2="60" y2="100" stroke="#e4e8ec"${w ? ` stroke-width="${w}"` : ""}/>`;
  assert.deepEqual(overlapIssues(across()), [], "a 1px GRID hairline is decoration");
  assert.ok(
    overlapIssues(across(30)).some((i) => /overlaps the line stroke/.test(i)),
    "a 30px GRID-coloured line across the text passed",
  );
  // the mark check holds a wide GRID stroke to 3:1 like any other mark
  assert.ok(
    auditMini(`<line x1="20" y1="150" x2="300" y2="150" stroke="#e4e8ec" stroke-width="30"/>`).some(
      (i) => /line stroke #e4e8ec/.test(i),
    ),
  );
});
test("a hollow circle collides only where its ring meets the text", () => {
  const ring = `<circle cx="96" cy="60" r="40" fill="none" stroke="#3a4656"/>`;
  // a ring whose hole holds the text: no ink meets the text
  assert.deepEqual(overlapIssues(label(90, 64, "in") + ring), []);
  // the same ring across the text: it runs through the glyphs
  assert.ok(
    overlapIssues(label(130, 64, "on the ring") + ring).some((i) =>
      /overlaps the circle stroke/.test(i),
    ),
    "a text across a ring passed",
  );
});

// A colour channel outside 0-255 is outside the subset: browsers clamp it, and a luminance
// taken from the raw value would certify a contrast no reader sees. The audit refuses it.
test("an rgb()/rgba() channel above 255 is unsupported, in an attribute and in a dark rule", () => {
  // an upper-case RGB() is refused too: the colour parser reads only lower case
  for (const c of ["rgb(999,999,999)", "rgb(0,256,0)", "rgba(300,0,0,0.5)", "RGB(0,0,255)"]) {
    assert.throws(
      () => auditMini(`<rect x="20" y="20" width="40" height="40" fill="${c}"/>`),
      /unsupported/,
      `fill="${c}" was audited`,
    );
    assert.throws(
      () => auditMini(`<text x="20" y="100" font-size="13" fill="${c}">ab</text>`),
      /unsupported/,
      `text fill="${c}" was audited`,
    );
  }
  assert.throws(
    () =>
      auditSvg(
        `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">` +
          `<style>@media (prefers-color-scheme: dark){rect[fill="#ffffff"]{fill:rgb(0,0,999)}}</style>` +
          `<rect width="400" height="200" fill="#ffffff"/></svg>`,
        { minText: MIN_TEXT, minBoxText: MIN_BOX_TEXT },
      ),
    /unsupported/,
  );
  // the edges of the range stay supported
  assert.doesNotThrow(() =>
    auditMini(`<rect x="20" y="20" width="40" height="40" fill="rgb(0,0,255)"/>`),
  );
});

// A stroke of width 0 paints nothing. Beside a painted fill it is no stroke; on a mark that
// paints nothing else (a line, a polyline, a hollow circle or rect) the mark is invisible.
test("a stroke-only mark with stroke-width 0 is reported as invisible", () => {
  const dark = "#1c2330";
  for (const body of [
    `<line x1="20" y1="20" x2="200" y2="20" stroke="${dark}" stroke-width="0"/>`,
    `<polyline points="20,40 100,60 200,40" fill="none" stroke="${dark}" stroke-width="0" stroke-linejoin="round" stroke-linecap="round"/>`,
    `<circle cx="60" cy="120" r="6" fill="none" stroke="${dark}" stroke-width="0"/>`,
    `<rect x="100" y="100" width="20" height="20" fill="none" stroke="${dark}" stroke-width="0"/>`,
    // in the GRID colour too: width 0 is checked before the hairline exemption
    `<line x1="20" y1="20" x2="200" y2="20" stroke="#e4e8ec" stroke-width="0"/>`,
    `<path d="M20 60L200 60" fill="none" stroke="#e4e8ec" stroke-width="0"/>`,
  ])
    assert.ok(
      auditMini(body).some((i) => /stroke-width 0 .*invisible/.test(i)),
      `a width-0 stroke-only mark passed: ${body}`,
    );
  // a filled mark with a width-0 stroke: the stroke is judged as absent, even a faint one
  assert.deepEqual(
    auditMini(
      `<circle cx="60" cy="120" r="6" fill="${dark}" stroke="#fdfdfd" stroke-width="0"/>` +
        `<rect x="100" y="100" width="20" height="20" fill="${dark}" stroke="#fdfdfd" stroke-width="0"/>`,
    ),
    [],
  );
});

// The figure-box floor does not depend on paint order: an outline-only frame drawn after
// its label holds it as much as one drawn before it.
test("an outline-only frame painted after its label is a figure box", () => {
  const frame = `<rect x="60" y="20" width="280" height="160" fill="none" stroke="#1c2330"/>`;
  const label10 = geoText(...CENTRE, "#1c2330", { size: 10, anchor: "middle" });
  for (const body of [frame + label10, label10 + frame])
    assert.ok(
      auditGeo(body).some((i) => /"ab" is 10px inside a figure box/.test(i)),
      `10px text in an outline-only frame passed: ${body}`,
    );
});

// chart.mjs's typecheck chart adds a tsgo clause to its lede when bench/tsgo-scale-table.json
// has the charted scale. The committed records do not have it, so the committed chart never
// shows that path: render it from synthetic records in a scratch tree (chart.mjs reads and
// writes relative to its working directory) and require the chart to stay on its canvas.
test("chart.mjs: the typecheck chart's tsgo lede stays inside the canvas", () => {
  const dir = mkdtempSync(join(tmpdir(), "chart-tsgo-note-"));
  try {
    mkdirSync(join(dir, "bench"));
    const row = {
      label: "10kx300",
      apps: 10000,
      libs: 300,
      versions: { pnpm: "12.8.1" },
      phases: {
        typecheck: { coldOk: true, warmOk: true, warmupOk: true, coldMs: 61234, warmMs: 4321 },
      },
    };
    writeFileSync(join(dir, "bench", "results.json"), JSON.stringify([row]));
    writeFileSync(
      join(dir, "bench", "tsgo-scale-table.json"),
      JSON.stringify({ cores: 192, scales: [{ apps: 10000, libs: 300, coldMedianMs: 4321 }] }),
    );
    writeFileSync(
      join(dir, "README.md"),
      "<!-- chart-data:typecheck-cold-vs-warm -->\n<!-- /chart-data:typecheck-cold-vs-warm -->\n",
    );
    // PATH without ImageMagick: the PNG step warns and the SVG is still written
    const r = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./chart.mjs", import.meta.url))],
      { cwd: dir, encoding: "utf8", env: { PATH: dirname(process.execPath) } },
    );
    assert.equal(r.status, 0, `chart.mjs exited ${r.status}: ${r.stderr}`);
    const svg = readFileSync(join(dir, "bench", "charts", "typecheck-cold-vs-warm.svg"), "utf8");
    assert.match(svg, /whole-program tsgo: 4\.3s on 192 cores/, "the tsgo clause was not drawn");
    assert.deepEqual(auditSvg(svg, { minText: MIN_TEXT, minBoxText: MIN_BOX_TEXT }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`1..${n}`);
if (failed.length) {
  console.log(`# ${failed.length} of ${n} failed:\n#   ${failed.join("\n#   ")}`);
  process.exit(1);
}
