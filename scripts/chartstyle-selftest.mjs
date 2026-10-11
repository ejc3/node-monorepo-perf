#!/usr/bin/env node
// Self-test for the shared chart kit (scripts/_chartstyle.mjs): the layout and
// legibility contracts the heat charts rely on, each pinned by a check that fails if
// the contract regresses. Run in CI before the charts render (charts.yml).
//
//   node scripts/chartstyle-selftest.mjs

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MIN_TEXT,
  TYPE,
  CELL_INK2,
  GOOD,
  BAD,
  RAMP,
  rampRGB,
  tintAlpha,
  fitSize,
  approxW,
  wrapPx,
  heatChart,
  headerBand,
  writeDocBlock,
} from "./_chartstyle.mjs";

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

test("tints separate by multiple and secondary text clears AA on the strongest tint", () => {
  assert.ok(tintAlpha(1) < tintAlpha(10) && tintAlpha(10) < tintAlpha(100));
  const lum = ([r, g, b]) => {
    const f = (c) => ((c /= 255), c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const over = (rgb, a) => rgb.map((c) => c * a + 255 * (1 - a));
  const cr = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  for (const [m] of RAMP) {
    const bg = over(rampRGB(m), tintAlpha(m));
    assert.ok(cr(hex(CELL_INK2), bg) >= 4.5, `secondary ink on the ×${m} tint`);
  }
  assert.ok(cr(hex(GOOD), over(rampRGB(1), tintAlpha(1))) >= 4.5, "'fastest' on its tint");
  assert.ok(cr(hex(BAD), over(rampRGB(100), tintAlpha(100))) >= 4.5, "status text on its tint");
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

console.log(`1..${n}`);
