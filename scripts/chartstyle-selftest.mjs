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
  logScale,
  MIN_BOX_TEXT,
} from "./_chartstyle.mjs";
import { auditSvg } from "./_svg-audit.mjs";

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

console.log(`1..${n}`);
if (failed.length) {
  console.log(`# ${failed.length} of ${n} failed:\n#   ${failed.join("\n#   ")}`);
  process.exit(1);
}
