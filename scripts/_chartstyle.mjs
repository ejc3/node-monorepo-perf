// The shared visual system every SVG generator in this repo draws with
// (diagram-style-spec.md, distilled from the cmux page). One palette, one
// dark-mode <style> block, one box/text/arrow grammar, one heat ramp — so the
// heat charts, the mechanism figures, the fleet infographic, and the scaling
// charts read as one system. Imported by figures.mjs, comparison-chart.mjs,
// scale-chart.mjs, net-cache-chart.mjs, fleet-chart.mjs, chart.mjs.
//
// Deterministic by construction: no Date, no environment reads. Every export is a
// pure constant or a pure function of its arguments, except the two writers:
// emitChart (SVG + its PNG raster in one step) and writeDocBlock (the chart's
// markdown text alternative in the doc that embeds it).
// Also home to assertComparable, the guard every two-record figure calls before
// it draws the records as one contrast.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { textWidth } from "./_text-width.mjs";

// --- palette -------------------------------------------------------------------
export const INK = "#1c2330";
export const MUTED = "#6b7885";
export const ACCENT = "#1a73e8";
export const GRID = "#e4e8ec";
export const BG = "#ffffff";
// One outer margin for every chart and figure.
export const MARGIN = 20;
// The whole-repo vs scoped-closure pair, at two strengths: `mark` for lines, bars and
// dots, `tint` for areas behind text. Deliberately off the heat ramp's hues (so a
// whole-repo series never reads as a ×100 cell) and off every TOOL_COLORS hue; the two
// separate by lightness as well as hue, so they hold under colour-vision deficiency.
// Marks clear 3:1 against the page in both themes (the dark block lifts the charcoal).
export const REPO = { mark: "#3a4656", tint: "#eff1f4" };
export const SCOPE = { mark: "#1b8aa0", tint: "#e8f4f6" };
// a neutral single series (no repo/closure meaning, no tool identity)
export const SLATE = "#556375";
// box tints: [fill, border] — semantic, not decorative
// (figure grammar v2: lighter fills, quieter borders; each pair has a dark-mode
// twin in TINT_DARK, which the dark block below is generated from)
export const TINT = {
  blue: ["#f3f6fb", "#c5d4ea"], // component / neutral
  green: ["#f1f9f4", "#b2d8c1"], // fast path / green verdict
  rust: ["#fcf4f0", "#e2c0b0"], // slow path / red verdict / blast radius
  amber: ["#fbf7ea", "#e6d8a8"], // caveat / incident window
  repo: [REPO.tint, "#b8c0ca"], // a whole-repo selection (the REPO pair)
  scope: [SCOPE.tint, "#a6d0d9"], // one closure (the SCOPE pair)
};
const TINT_DARK = {
  blue: ["#172435", "#34507a"],
  green: ["#13281f", "#2c6049"],
  rust: ["#2b1b15", "#6c4232"],
  amber: ["#2a2414", "#6e5a24"],
  repo: ["#1a2029", "#465260"],
  scope: ["#0f2529", "#2a6470"],
};
// edges (arrows, connectors): one step lighter than MUTED so lines recede behind text
export const EDGE = "#8794a1";
// two neutral series fills for a comparison that is not a verdict (the same run on
// two machines): no green/rust, so neither side reads as the winner
// Both clear 3:1 against the page in both themes; the dark block lifts the first.
export const MACHINE_SERIES = ["#3f4b5b", "#7a8899"];

// Stable categorical tool colors: a tool keeps ONE hue across every chart in the
// repo (a series color, a header chip, a legend swatch — always this value).
// Validated per co-occurring group (install · checkers · build · lint) for CVD
// separation and contrast on the light AND dark surfaces.
export const TOOL_COLORS = {
  bun: "#0e8f7e", // teal
  pnpm: "#cb711f", // orange
  yarn: "#6f56c4", // violet
  npm: "#c0453b", // red
  tsgo: "#1a73e8", // blue (the accent — the recommended checker)
  tsc: "#b2538f", // magenta (tsserver is tsc's daemon: same identity)
  flow: "#b28a2f", // gold
  vite: "#5865c0", // indigo
  next: "#a86b32", // bronze
  oxlint: "#2e9e57", // green
  eslint: "#9a6ade", // light purple
};

export const FONT = "system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif";

// Dark-mode recolors INSIDE each SVG: GitHub serves SVGs through camo as <img>,
// where internal CSS + prefers-color-scheme work and JS does not. Attribute
// selectors retarget exactly the palette constants above, so any element drawn
// with them flips with the theme; ramp-filled heat cells keep their inline fill
// (their ink is chosen against that fill, so they read on either surface).
export const DARK_STYLE = `<style>@media (prefers-color-scheme: dark){
rect[fill="${BG}"]{fill:#0d1117}
text[fill="${INK}"]{fill:#e2e7ec}
text[fill="${MUTED}"]{fill:#9aa6b1}
text[fill="${ACCENT}"]{fill:#6ba3f5}
line[stroke="${GRID}"]{stroke:#2b333c}
rect[stroke="${GRID}"]{stroke:#39424c}
rect[fill="${GRID}"]{fill:#2b333c}
line[stroke="${MUTED}"],path[stroke="${MUTED}"],polyline[stroke="${MUTED}"]{stroke:#8b98a4}
path[fill="${MUTED}"]{fill:#8b98a4}
line[stroke="${EDGE}"],path[stroke="${EDGE}"],polyline[stroke="${EDGE}"]{stroke:#6f7c88}
path[fill="${EDGE}"]{fill:#6f7c88}
circle[stroke="${EDGE}"]{stroke:#6f7c88}rect[stroke="${EDGE}"]{stroke:#6f7c88}circle[fill="${EDGE}"]{fill:#6f7c88}
${Object.keys(TINT)
  .map(
    (k) =>
      `rect[fill="${TINT[k][0]}"]{fill:${TINT_DARK[k][0]}}rect[stroke="${TINT[k][1]}"]{stroke:${TINT_DARK[k][1]}}rect[fill="${TINT[k][1]}"]{fill:${TINT_DARK[k][1]}}`,
  )
  .join("\n")}
rect[fill="${MACHINE_SERIES[0]}"]{fill:#c3cfdc}
circle[fill="${BG}"]{fill:#0d1117}
text[fill="#146b3a"]{fill:#5cc48c}
text[fill="#46505b"]{fill:#aab4be}
text[fill="#8f2a23"]{fill:#f0847b}
polyline[stroke="${REPO.mark}"]{stroke:#a7b6c8}circle[fill="${REPO.mark}"],rect[fill="${REPO.mark}"]{fill:#a7b6c8}
text[fill="${REPO.mark}"]{fill:#a7b6c8}
}</style>`;

export const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// --- document ------------------------------------------------------------------
// Every SVG gets role="img" + an aria-label stating the mechanism, the dark-mode
// block, and an EXPLICIT light background rect the dark block retargets — a
// transparent SVG with dark text is unreadable on GitHub dark.
export const svgDoc = (w, h, aria, body) =>
  [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(aria)}" font-family="${FONT}" style="font-variant-numeric:tabular-nums">`,
    DARK_STYLE,
    `<rect width="${w}" height="${h}" fill="${BG}"/>`,
    ...body,
    `</svg>`,
  ].join("\n");

// --- box / text / arrow grammar --------------------------------------------------
export const box = (x, y, w, h, tint, rx = 6) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${TINT[tint][0]}" stroke="${TINT[tint][1]}" stroke-width="1"/>`;

export const txt = (x, y, s, { size = 11, fill = INK, weight = "", anchor = "" } = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}"${weight ? ` font-weight="${weight}"` : ""}${anchor ? ` text-anchor="${anchor}"` : ""}>${esc(s)}</text>`;

// dashed edge (the soft / conditional path), drawn as explicit segments rather than
// stroke-dasharray: ImageMagick's internal SVG renderer paints a continuous hairline
// under a dasharray stroke, so a dashed edge would read as solid in a PNG it rasters.
export const dashes = (x1, y1, x2, y2, on = 6, off = 5) => {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (!(len > 0)) return "";
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const f = (n) => +n.toFixed(1);
  // n dashes of length `on` with the gap adjusted so the first dash starts at
  // (x1, y1) and the last ends exactly at (x2, y2) — an arrow's shaft then always
  // meets its head. The dash count drops until the gap is at least MIN_GAP; an
  // edge too short for two dashes and a gap is one solid segment.
  const MIN_GAP = 2;
  let n = Math.max(1, Math.round((len + off) / (on + off)));
  while (n > 1 && (len - n * on) / (n - 1) < MIN_GAP) n--;
  const step = n > 1 ? (len - on) / (n - 1) : 0;
  let d = "";
  for (let i = 0; i < n; i++) {
    const s = i * step;
    const e = n === 1 ? len : s + on;
    d += `M${f(x1 + ux * s)} ${f(y1 + uy * s)}L${f(x1 + ux * e)} ${f(y1 + uy * e)}`;
  }
  return `<path d="${d}" stroke="${EDGE}" stroke-width="1.25" fill="none"/>`;
};

// arrow-ended edge. The head is an explicit triangle, not a <marker>: ImageMagick's
// SVG fallback renderer (what `convert` uses in CI when inkscape is absent) drops
// <marker> elements, so a marker-end head would vanish from every committed PNG.
export const arrow = (x1, y1, x2, y2, dashed = false) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  const hl = 6.5; // head length
  const hw = 3; // head half-width
  const bx = x2 - ux * hl;
  const by = y2 - uy * hl;
  const f = (n) => +n.toFixed(1);
  return (
    (dashed
      ? dashes(x1, y1, bx, by)
      : `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(bx)}" y2="${f(by)}" stroke="${EDGE}" stroke-width="1.25"/>`) +
    `<path d="M${f(x2)} ${f(y2)}L${f(bx - uy * hw)} ${f(by + ux * hw)}L${f(bx + uy * hw)} ${f(by - ux * hw)}z" fill="${EDGE}"/>`
  );
};

// provenance footer: a hairline + one muted "data: …" line (the number-tracing
// rule made visible inside the image). One style for every figure, fleet chart and
// line chart; the heat charts carry per-section source links instead.
export const footer = (w, y, sources, pad = MARGIN) => [
  `<line x1="${pad}" y1="${y - 14}" x2="${w - pad}" y2="${y - 14}" stroke="${GRID}"/>`,
  txt(pad, y, `data: ${sources}`, { size: TYPE.note, fill: MUTED }),
];

// --- figure grammar (v2) -----------------------------------------------------------
// The mechanism figures share the heat and line charts' type scale (TYPE): title,
// lede, value and note sizes are TYPE's (chartstyle-selftest asserts it); text inside
// a box is at least MIN_BOX_TEXT, secondary text inside a box is CELL_INK2, and text
// on the page may drop to TYPE.note. One weight step (600–650) carries emphasis.
export const FIG = {
  title: 17, // = TYPE.title
  lede: 12, // = TYPE.lede
  label: 12, // a box's or panel's bold first line
  body: 11, // = MIN_BOX_TEXT: any text inside a figure box
  value: 13, // = TYPE.value
  note: 10, // = TYPE.note: text on the page, outside boxes
  edge: 10, // edge labels, on the page
};
// title + optional lede; returns the parts and the baseline below them
export const figTitle = (x, y, title, lede) => {
  const parts = [txt(x, y, title, { size: FIG.title, weight: "650" })];
  if (lede) parts.push(txt(x, y + 18, lede, { size: FIG.lede, fill: MUTED }));
  return { parts, y: y + (lede ? 18 : 0) };
};
// a labeled node: tinted box, a bold first line, then body lines
export const node = (x, y, w, h, tint, label, lines = [], { rx = 6, size = FIG.body } = {}) => {
  const parts = [box(x, y, w, h, tint, rx)];
  const top = y + 18;
  parts.push(txt(x + 11, top, label, { size: FIG.label, weight: "600" }));
  lines.forEach((ln, i) => parts.push(txt(x + 11, top + 15 + i * 14, ln, { size })));
  return parts;
};
// small edge label, centered (anchor default) on (x, y)
export const edgeLabel = (x, y, s, anchor = "middle") =>
  txt(x, y, s, { size: FIG.edge, fill: MUTED, anchor });
// a dot mark (filled, or hollow ring for a secondary value) in a series colour
export const dot = (cx, cy, color, { r = 4.5, hollow = false } = {}) =>
  hollow
    ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${BG}" stroke="${color}" stroke-width="1.75"/>`
    : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>`;

// --- the heat ramp ---------------------------------------------------------------
// Anchored at MULTIPLES of the row's fastest and interpolated in log-multiple
// space, so ×12 is the same color in every chart. Green is deliberately narrow:
// by ×2 a cell is full amber, then it ramps through orange to red (clamped at
// ×100). Cells draw the ramp as a light rgba() tint plus a full-strength stripe.
export const RAMP = [
  [1, [31, 138, 77]], // fastest — green
  [2, [209, 163, 43]], // ×2 slower — amber (clearly off green)
  [10, [194, 99, 37]], // ~×10 — orange (the rust family, saturated)
  [100, [176, 58, 54]], // ×100+ — red (clamped)
];
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
export const rampRGB = (mult) => {
  if (mult <= 1.0001) return RAMP[0][1];
  const m = Math.min(mult, RAMP[RAMP.length - 1][0]);
  const lm = Math.log10(m);
  for (let i = 0; i < RAMP.length - 1; i++) {
    const [m0, c0] = RAMP[i];
    const [m1, c1] = RAMP[i + 1];
    if (m <= m1) {
      const f = (lm - Math.log10(m0)) / (Math.log10(m1) - Math.log10(m0));
      return [lerp(c0[0], c1[0], f), lerp(c0[1], c1[1], f), lerp(c0[2], c1[2], f)];
    }
  }
  return RAMP[RAMP.length - 1][1];
};
export const rgbCss = ([r, g, b]) => `rgb(${r},${g},${b})`;
export const fmtMult = (m) => "×" + (m < 10 ? m.toFixed(1) : Math.round(m).toLocaleString("en-US"));
// The near-tie rule every heat chart shares: a cell within 5% of the row's fastest
// (inclusive) keeps its time as the headline with the +N% as the sub-line. One
// definition, so the boundary cannot drift between generators.
export const NEAR_TIE_MAX = 1.05;
export const isFastest = (mult) => mult <= 1.0001;
export const isNearTie = (mult) => !isFastest(mult) && mult <= NEAR_TIE_MAX;
// near-tie sub-line: one decimal below 1% so a real +0.4% never rounds to a
// meaningless "+0%"
export const nearTiePct = (mult) => {
  const p = (mult - 1) * 100;
  return `+${p.toFixed(p < 1 ? 1 : 0)}% vs fastest`;
};

// --- type scale ----------------------------------------------------------------------
// One scale for every heat chart (px in SVG user units). Charts are drawn at a width
// that GitHub shows at roughly 1:1 on a desktop column (≤ 920), so these are the
// sizes a reader sees. MIN_TEXT is the floor: text that does not fit its space at
// the floor fails the generator instead of shrinking into illegibility.
export const TYPE = {
  title: 17, // chart title
  lede: 12, // the line(s) under the title
  section: 13.5, // section heading in a stacked chart
  head: 11.5, // column header
  label: 11.5, // row label / box label
  value: 13, // a cell's headline number
  sub: 10.5, // a cell's second line
  note: 10, // per-section note, legend, axis
};
export const MIN_TEXT = 9;
// text inside a figure box (a labelled node) has a higher floor: at phone width a
// figure scales to roughly half size
export const MIN_BOX_TEXT = 11;

// text colours for verdicts and for secondary text ON a tinted cell. Each clears
// WCAG AA (4.5:1) on the strongest light tint; the dark block recolours them.
export const GOOD = "#146b3a";
export const BAD = "#8f2a23";
export const CELL_INK2 = "#46505b";

// the size at which `s` fits `maxW` px: `size` if it fits, else smaller down to
// MIN_TEXT; below that the caller's text is too long for its space and this throws
export const fitSize = (s, maxW, size, bold = false) => {
  const need = approxW(String(s), size, bold);
  if (need <= maxW) return size;
  const fit = Math.floor(((size * maxW) / need) * 10) / 10;
  if (fit < MIN_TEXT)
    throw new Error(
      `chart text "${s}" needs ${Math.round(approxW(String(s), MIN_TEXT, bold))}px at the ${MIN_TEXT}px floor but has ${Math.round(maxW)}px — shorten it or widen its space`,
    );
  return fit;
};

// --- heat-table pieces (v2) ----------------------------------------------------------
// A cell is a quiet tint, not a saturated button: the ramp colour as an rgba() fill
// (ImageMagick's internal SVG renderer, what `convert` uses here and in CI, ignores
// fill-opacity and opacity but honours rgba), so the same fill reads as a light tint
// on white and a dark tint on GitHub dark, and the text is plain ink. The tint gets
// stronger with the multiple (×1 → ×100) so the ranking separates by fill as well as
// by the 3px full-strength stripe at the cell's left edge. The headline is the
// measured value; the second line is its standing (fastest / +N% / ×N).
export const tintAlpha = (mult) =>
  +(0.16 + 0.2 * Math.min(1, Math.max(0, Math.log10(mult) / 2))).toFixed(3);
export const tintCss = ([r, g, b], a) => `rgba(${r},${g},${b},${a})`;
const NEUTRAL = [107, 120, 133]; // a non-ranking cell (e.g. a red-vs-green delta)
const CELL_GAP = 2;
export const heatCell = (x, y, w, h, { rgb, alpha, main, sub, subFill, detail }) => {
  const ix = x + CELL_GAP / 2;
  const iy = y + CELL_GAP / 2;
  const iw = w - CELL_GAP;
  const ih = h - CELL_GAP;
  const cx = x + 1.5 + w / 2; // centred on the area right of the stripe
  const cy = y + h / 2;
  const room = iw - 14;
  const parts = [
    `<rect x="${ix}" y="${iy}" width="${iw}" height="${ih}" rx="3" fill="${tintCss(rgb, alpha)}"/>`,
    `<rect x="${ix}" y="${iy}" width="3" height="${ih}" rx="1.5" fill="${rgbCss(rgb)}"/>`,
    txt(cx, cy + (detail ? -6 : sub ? -1 : 4.5), main, {
      size: fitSize(main, room, TYPE.value, true),
      weight: "650",
      anchor: "middle",
    }),
  ];
  if (sub)
    parts.push(
      txt(cx, cy + (detail ? 8 : 13), sub, {
        size: fitSize(sub, room, TYPE.sub, Boolean(subFill)),
        fill: subFill || CELL_INK2,
        weight: subFill ? "600" : "",
        anchor: "middle",
      }),
    );
  if (detail)
    parts.push(
      txt(cx, cy + 20, detail, {
        size: fitSize(detail, room, MIN_TEXT),
        fill: CELL_INK2,
        anchor: "middle",
      }),
    );
  return parts;
};
// a measured cell's standing against the row's best: one definition, used by the SVG
// cell and its markdown twin alike
export const standingText = (mult) =>
  isFastest(mult)
    ? "fastest"
    : isNearTie(mult)
      ? nearTiePct(mult).replace(" vs fastest", "")
      : fmtMult(mult);
// a measured cell: value headline + standing sub-line from its multiple of the best
export const rankedCell = (x, y, w, h, mult, valueText, { detail } = {}) => {
  const tie = isFastest(mult) || isNearTie(mult);
  return heatCell(x, y, w, h, {
    rgb: rampRGB(tie ? 1 : mult),
    alpha: tintAlpha(tie ? 1 : mult),
    main: valueText,
    sub: standingText(mult),
    subFill: isFastest(mult) ? GOOD : undefined,
    detail,
  });
};
// a status cell (crash, wedge, timeout): words, never a number posing as one
const STATUS_RGB = RAMP[RAMP.length - 1][1];
export const statusCell = (x, y, w, h, main, sub) =>
  heatCell(x, y, w, h, { rgb: STATUS_RGB, alpha: tintAlpha(100), main, sub, subFill: BAD });
// "—" cell for an intentionally-unmeasured value (never a failure disguised)
export const naCell = (x, y, w, h, why) => {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const parts = [
    `<rect x="${x + CELL_GAP / 2}" y="${y + CELL_GAP / 2}" width="${w - CELL_GAP}" height="${h - CELL_GAP}" rx="3" fill="none" stroke="${GRID}"/>`,
    txt(cx, cy + (why ? -1 : 4.5), "—", { size: TYPE.value, fill: MUTED, anchor: "middle" }),
  ];
  if (why) {
    // the bordered outline makes the cell a figure box: its reason holds the box floor
    if (approxW(why, MIN_BOX_TEXT) > w - 14)
      throw new Error(
        `"—" cell reason "${why}" needs ${Math.round(approxW(why, MIN_BOX_TEXT))}px at the ${MIN_BOX_TEXT}px box floor but has ${Math.round(w - 14)}px — shorten it or widen the column`,
      );
    parts.push(txt(cx, cy + 13, why, { size: MIN_BOX_TEXT, fill: MUTED, anchor: "middle" }));
  }
  return parts;
};
// column headers: every header in a section sits in one band whose height fits the
// tallest header, bottom-aligned, so names, sub-lines and the tool chips line up
// across the row. The tool's stable hue is a short rule under the name (identity
// without width estimates: a dot beside a centred name cannot be placed exactly).
const HEAD_LH = 13.5;
const headerBlock = ({ label, sub }) => String(label).split("\n").length * HEAD_LH + (sub ? 12 : 0);
export const headerBand = (cols) => Math.max(...cols.map(headerBlock)) + 14;
export const colHeader = (x, y, w, band, { label, sub, chip }) => {
  if (chip && !TOOL_COLORS[chip]) throw new Error(`no stable tool color for "${chip}"`);
  const parts = [];
  const lines = String(label).split("\n");
  const cx = x + 1.5 + w / 2;
  const bottom = y + band - 8; // the chip's baseline
  let ly = bottom - 6 - (sub ? 12 : 0) - (lines.length - 1) * HEAD_LH;
  for (const ln of lines) {
    parts.push(
      txt(cx, ly, ln, {
        size: fitSize(ln, w - 8, TYPE.head, true),
        weight: "650",
        anchor: "middle",
      }),
    );
    ly += HEAD_LH;
  }
  if (sub)
    parts.push(
      txt(cx, ly - 1.5, sub, {
        size: fitSize(sub, w - 8, MIN_TEXT),
        fill: MUTED,
        anchor: "middle",
      }),
    );
  if (chip)
    parts.push(
      `<rect x="${cx - 9}" y="${bottom}" width="18" height="2.5" rx="1.25" fill="${TOOL_COLORS[chip]}"/>`,
    );
  return parts;
};
// section heading for a stacked chart: title, then a hairline. Returns the parts and
// the y where the section body starts.
export const sectionHead = (x, y, w, title) => {
  const by = y + 9;
  return {
    parts: [
      txt(x, y, title, { size: fitSize(title, w, TYPE.section, true), weight: "650" }),
      `<line x1="${x}" y1="${by}" x2="${x + w}" y2="${by}" stroke="${GRID}"/>`,
    ],
    bodyY: by,
  };
};
// the key: the ramp anchors as cells in miniature, then the text-only states
export const rampLegend = (x, y, extra = []) => {
  const items = [
    { rgb: rampRGB(1), a: tintAlpha(1), t: "fastest" },
    { rgb: rampRGB(2), a: tintAlpha(2), t: "×2" },
    { rgb: rampRGB(10), a: tintAlpha(10), t: "×10" },
    { rgb: rampRGB(100), a: tintAlpha(100), t: "×100+ slower" },
    ...extra,
  ];
  const parts = [];
  let lx = x;
  for (const it of items) {
    if (it.rgb) {
      parts.push(
        `<rect x="${lx}" y="${y - 9}" width="20" height="12" rx="2" fill="${tintCss(it.rgb, it.a)}"/>`,
        `<rect x="${lx}" y="${y - 9}" width="3" height="12" rx="1.5" fill="${rgbCss(it.rgb)}"/>`,
      );
      lx += 25;
    }
    parts.push(txt(lx, y + 1, it.t, { size: TYPE.note, fill: MUTED }));
    lx += approxW(it.t, TYPE.note) + 16;
  }
  return { parts, endX: lx };
};

// --- the stacked heat chart -------------------------------------------------------------
// One renderer for every heat table (tool comparison, checker scale, cache network):
// title + lede + key, then per section a heading, column headers, rows of cell
// descriptors, the source links and the note. Returns the SVG and its markdown twin
// (the mobile text alternative), both from the same descriptors, so they cannot
// disagree. A cell descriptor is one of
//   { kind: "ranked", text, mult, detail? }  measured; standing from its multiple
//   { kind: "na", why }                        intentionally not measured
//   { kind: "status", main, sub }              crash / wedge / timeout: words, no number
//   { kind: "delta", main, sub }               a non-ranking comparison (neutral tint)
//   { kind: "ok", main, sub }                  a passing status (fastest tint, sub in green)
const cellParts = (x, y, w, h, c) => {
  if (c.kind === "ranked") return rankedCell(x, y, w, h, c.mult, c.text, { detail: c.detail });
  if (c.kind === "na") return naCell(x, y, w, h, c.why);
  if (c.kind === "status") return statusCell(x, y, w, h, c.main, c.sub);
  if (c.kind === "delta")
    return heatCell(x, y, w, h, { rgb: NEUTRAL, alpha: 0.12, main: c.main, sub: c.sub });
  if (c.kind === "ok")
    return heatCell(x, y, w, h, {
      rgb: rampRGB(1),
      alpha: tintAlpha(1),
      main: c.main,
      sub: c.sub,
      subFill: GOOD,
    });
  throw new Error(`unknown heat cell kind ${c.kind}`);
};
const cellMd = (c) => {
  if (c.kind === "ranked")
    return (
      (isFastest(c.mult) ? `**${c.text}**` : `${c.text} (${standingText(c.mult)})`) +
      (c.detail ? `<br>${c.detail}` : "")
    );
  if (c.kind === "na") return `— (${c.why})`;
  return c.sub ? `${c.main} (${c.sub})` : c.main;
};
export function heatChart({
  title,
  lede = [],
  sections,
  labelW = 232,
  colW = 118,
  aria,
  statusKey,
}) {
  const PAD = 20;
  const ROW_H = 42;
  const ROW_H_TALL = 50;
  const maxCols = Math.max(...sections.map((s) => s.cols.length));
  const W = Math.ceil(
    Math.max(PAD * 2 + labelW + colW * maxCols, PAD * 2 + approxW(title, TYPE.title, true)),
  );
  const innerW = W - PAD * 2;
  const ledeLines = [].concat(lede);
  const cells = sections.flatMap((s) => s.rows.flatMap((r) => r.cells));
  const T = [];
  let y = 32;
  T.push(txt(PAD, y, title, { size: TYPE.title, weight: "650" }));
  for (const ln of ledeLines.flatMap((l) => wrapPx(l, TYPE.lede, innerW))) {
    y += 18;
    T.push(txt(PAD, y, ln, { size: TYPE.lede, fill: MUTED }));
  }
  y += 24;
  const extra = [];
  if (cells.some((c) => c.kind === "ranked" && isNearTie(c.mult)))
    extra.push({ t: "+N%  within 5% of fastest" });
  if (cells.some((c) => c.kind === "status")) {
    if (!statusKey)
      throw new Error(`heat chart "${title}": status cells need a statusKey for the legend`);
    extra.push({ rgb: STATUS_RGB, a: tintAlpha(100), t: statusKey });
  }
  if (cells.some((c) => c.kind === "na")) extra.push({ t: "—  not measured" });
  T.push(...rampLegend(PAD, y, extra).parts);
  y += 40;
  const md = ledeLines.length ? [ledeLines.join(" ")] : [];
  for (const sec of sections) {
    for (const row of sec.rows)
      if (row.cells.length !== sec.cols.length)
        throw new Error(
          `heat section "${sec.title}": row "${row.label}" has ${row.cells.length} cells for ${sec.cols.length} columns`,
        );
    const gridX = PAD + labelW;
    let sy;
    if (sec.title) {
      const head = sectionHead(PAD, y, innerW, sec.title);
      T.push(...head.parts);
      sy = head.bodyY;
    } else sy = y - 14;
    const band = headerBand(sec.cols);
    if (sec.rowHead)
      T.push(txt(PAD, sy + band - 14, sec.rowHead, { size: TYPE.note, fill: MUTED }));
    sec.cols.forEach((col, ci) => T.push(...colHeader(gridX + ci * colW, sy, colW, band, col)));
    sy += band;
    for (const row of sec.rows) {
      const lines = wrapPx(row.label, TYPE.label, labelW - 14, Boolean(row.sub));
      if (lines.length > 2)
        throw new Error(
          `heat row label "${row.label}" needs ${lines.length} lines in ${labelW - 14}px`,
        );
      const tall = row.sub || lines.length > 1 || row.cells.some((c) => c.detail);
      const rh = tall ? ROW_H_TALL : ROW_H;
      const textLines = [
        ...lines.map((t) => ({ t, size: TYPE.label, fill: INK, weight: row.sub ? "600" : "" })),
        ...(row.sub ? [{ t: row.sub, size: TYPE.note, fill: MUTED, weight: "" }] : []),
      ];
      let ty = sy + rh / 2 + 4 - ((textLines.length - 1) * 15) / 2;
      for (const l of textLines) {
        T.push(
          txt(PAD, ty, l.t, {
            size: fitSize(l.t, labelW - 14, l.size, Boolean(l.weight)),
            fill: l.fill,
            weight: l.weight,
          }),
        );
        ty += 15;
      }
      row.cells.forEach((c, ci) => T.push(...cellParts(gridX + ci * colW, sy, colW, rh, c)));
      sy += rh;
    }
    // provenance: the source(s) as links (relative href resolves from bench/charts/
    // in GitHub's raw view), then the note
    sy += 18;
    const sources = sec.source.split(", ");
    let sx = PAD;
    T.push(txt(sx, sy, "source", { size: TYPE.note, fill: MUTED }));
    sx += approxW("source", TYPE.note) + 8;
    sources.forEach((p, i) => {
      const shown = p.replace("bench/", "");
      if (i) {
        T.push(txt(sx, sy, "·", { size: TYPE.note, fill: MUTED }));
        sx += 10;
      }
      T.push(
        `<a href="${esc("../../" + p)}"><text x="${sx}" y="${sy}" font-size="${TYPE.note}" fill="${ACCENT}">${esc(shown)}</text></a>`,
      );
      sx += approxW(shown, TYPE.note) + 8;
    });
    for (const ln of sec.note ? wrapPx(sec.note, TYPE.note, innerW) : []) {
      sy += 14;
      T.push(txt(PAD, sy, ln, { size: TYPE.note, fill: MUTED }));
    }
    y = sy + 44;
    md.push(
      [
        sec.title ? `**${sec.title}**` : null,
        mdTable(
          [
            sec.rowHead || "",
            ...sec.cols.map((c) => c.label.replace("\n", " ") + (c.sub ? ` (${c.sub})` : "")),
          ],
          sec.rows.map((r) => [r.sub ? `${r.label} (${r.sub})` : r.label, ...r.cells.map(cellMd)]),
        ),
        `${sources.map((p) => `[\`${p}\`](${p})`).join(", ")}${sec.note ? `. ${sec.note}` : ""}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }
  return { svg: svgDoc(W, y - 18, aria, T), md: md.join("\n\n") };
}

// --- axes / series (v2) ----------------------------------------------------------------
// The plotting grammar for the scaling charts: real axes (ticks, gridlines, titles),
// log scales where the data spans more than ~10×, direct labels instead of legends.
// Series colours: the REPO/SCOPE pair (whole repo vs one closure, also used by the
// mechanism figures) and SLATE for a neutral single series.
export const SERIES = {
  scoped: SCOPE.mark,
  repo: REPO.mark,
  neutral: SLATE,
};
// A log domain that contains every value, on 1–3 bounds (…, 100, 300, 1k, 3k, …), and
// its ticks. Derived from the data, so a record outside any fixed range can never be
// drawn past the frame.
const LOG_STEPS = [1, 3];
const logStops = (lo, hi) => {
  const out = [];
  for (let e = Math.floor(Math.log10(lo)) - 1; e <= Math.ceil(Math.log10(hi)) + 1; e++)
    for (const m of LOG_STEPS) out.push(+(m * 10 ** e).toPrecision(12));
  return out;
};
export const logDomain = (values) => {
  const vs = values.filter((v) => v != null);
  if (!vs.length || vs.some((v) => !(v > 0)))
    throw new Error(`log domain needs positive values, got [${values}]`);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const stops = logStops(lo, hi);
  let d0 = Math.max(...stops.filter((s) => s <= lo));
  let d1 = Math.min(...stops.filter((s) => s >= hi));
  // a single value sitting on a stop (one benchmark row at 300 packages) would give a
  // zero-span domain and NaN coordinates: widen to the neighbouring stops
  if (d0 === d1) {
    const wide = logStops(lo / 10, hi * 10);
    d0 = Math.max(...wide.filter((s) => s < lo));
    d1 = Math.min(...wide.filter((s) => s > hi));
    return { domain: [d0, d1], ticks: wide.filter((s) => s >= d0 && s <= d1) };
  }
  return { domain: [d0, d1], ticks: stops.filter((s) => s >= d0 && s <= d1) };
};
export const linScale = (d0, d1, r0, r1) => (v) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
export const logScale = (d0, d1, r0, r1) => {
  const l0 = Math.log10(d0);
  const span = Math.log10(d1) - l0;
  return (v) => {
    if (!(v > 0)) throw new Error(`log scale: non-positive value ${v}`);
    return r0 + ((Math.log10(v) - l0) / span) * (r1 - r0);
  };
};
// compact tick label: 300 · 1k · 20k · 1M
export const fmtTick = (n) =>
  n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n);
const f1 = (n) => +n.toFixed(1);
// Plot frame: gridlines at the value-axis ticks, a baseline, tick labels, axis titles.
// `grid` picks which axis carries the gridlines ("y" for line charts, "x" for
// horizontal bars). Ticks are explicit: the caller chooses round values inside the
// domain, so no label is invented by an auto-tick heuristic.
export function plotFrame({
  x,
  y,
  w,
  h,
  sx,
  sy,
  xTicks = [],
  yTicks = [],
  xFmt = fmtTick,
  yFmt = fmtTick,
  xTitle,
  yTitle,
  grid = "y",
}) {
  const parts = [];
  if (grid === "y")
    for (const t of yTicks)
      parts.push(
        `<line x1="${x}" y1="${f1(sy(t))}" x2="${x + w}" y2="${f1(sy(t))}" stroke="${GRID}"/>`,
      );
  if (grid === "x")
    for (const t of xTicks)
      parts.push(
        `<line x1="${f1(sx(t))}" y1="${y}" x2="${f1(sx(t))}" y2="${y + h}" stroke="${GRID}"/>`,
      );
  // baseline: the domain-floor edge of the plot
  parts.push(`<line x1="${x}" y1="${y + h}" x2="${x + w}" y2="${y + h}" stroke="${MUTED}"/>`);
  for (const t of xTicks) {
    const tx = f1(sx(t));
    parts.push(`<line x1="${tx}" y1="${y + h}" x2="${tx}" y2="${y + h + 4}" stroke="${MUTED}"/>`);
    parts.push(txt(tx, y + h + 17, xFmt(t), { size: TYPE.note, fill: MUTED, anchor: "middle" }));
  }
  for (const t of yTicks)
    parts.push(
      txt(x - 8, f1(sy(t)) + 3.5, yFmt(t), { size: TYPE.note, fill: MUTED, anchor: "end" }),
    );
  if (xTitle)
    parts.push(txt(x + w, y + h + 36, xTitle, { size: TYPE.note, fill: MUTED, anchor: "end" }));
  if (yTitle) parts.push(txt(x, y - 12, yTitle, { size: TYPE.note, fill: MUTED }));
  return parts;
}
// One series: a polyline broken at missing points, with a dot per measured point.
export function seriesLine(points, sx, sy, color, { width = 2.25, r = 3.25 } = {}) {
  const parts = [];
  let seg = [];
  const flush = () => {
    if (seg.length > 1)
      parts.push(
        `<polyline points="${seg.join(" ")}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"/>`,
      );
    seg = [];
  };
  for (const [px, py] of points) {
    if (py == null) flush();
    else seg.push(`${f1(sx(px))},${f1(sy(py))}`);
  }
  flush();
  for (const [px, py] of points)
    if (py != null)
      parts.push(`<circle cx="${f1(sx(px))}" cy="${f1(sy(py))}" r="${r}" fill="${color}"/>`);
  return parts;
}

// The baseline of a value label centred above point i of a series: 9px above the point,
// raised until the label's box (its measured width; 0.75 em above the baseline, 0.21 em
// below) clears the point's dot and each series segment that meets the point by
// LABEL_GAP px past the stroke's edge. `pts` are the series' screen points in order, null
// where the series breaks (no segment crosses a break). Stroke width and dot radius are
// seriesLine's defaults.
export const LABEL_GAP = 2;
export const labelBaseline = (pts, i, label, size, { stroke = 2.25, r = 3.25 } = {}) => {
  const [cx, cy] = pts[i];
  const half = approxW(label, size) / 2;
  const down = 0.21 * size;
  let bottom = Math.min(cy - 9 + down, cy - r - LABEL_GAP);
  for (const j of [i - 1, i + 1]) {
    if (!pts[j]) continue;
    const [bx, by] = pts[j];
    if (bx === cx) {
      // a vertical segment (two points on one x): the label clears its upper end
      bottom = Math.min(bottom, Math.min(cy, by) - stroke / 2 - LABEL_GAP);
      continue;
    }
    const lo = Math.max(Math.min(cx, bx), cx - half);
    const hi = Math.min(Math.max(cx, bx), cx + half);
    const yAt = (x) => cy + ((by - cy) * (x - cx)) / (bx - cx);
    for (const x of [lo, hi]) bottom = Math.min(bottom, yAt(x) - stroke / 2 - LABEL_GAP);
  }
  return bottom - down;
};

// --- text measurement / wrapping --------------------------------------------------
// Advance-width estimate (px): _text-width.mjs's, the one the legibility audit checks
// every text's box with (per glyph the wider of Arial x 1.1 and DejaVu Sans), so what the
// layout reserves for a text is what a reader on any of the system-ui faces sees.
export const approxW = (str, px, bold = false) => textWidth(String(str), px, bold ? "bold" : "");
// wrap to a pixel width with the same advance estimate the layout uses everywhere
export const wrapPx = (s, px, maxW, bold = false) => {
  const lines = [];
  let line = "";
  for (const word of String(s).split(" ")) {
    const cand = line ? `${line} ${word}` : word;
    if (line && approxW(cand, px, bold) > maxW) {
      lines.push(line);
      line = word;
    } else line = cand;
  }
  if (line) lines.push(line);
  return lines;
};
export const wrapText = (s, maxChars) => {
  const lines = [];
  let line = "";
  for (const word of String(s).split(" ")) {
    if (line && line.length + 1 + word.length > maxChars) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
};

// recorded version banners ("v22.23.3", "Version 7.0.2", "Version: 1.86.0",
// "Relay Compiler 21.0.1") down to the bare version, for display. Benches record
// the banner their tool printed, so every generator strips through this one helper.
// A non-string or empty field throws: a malformed record must not render as a version.
export const bareVer = (v) => {
  if (typeof v !== "string" || v.trim() === "")
    throw new Error("version banner is not a non-empty string in a cited bench JSON");
  return v.replace(/^(?:Version:?\s*|Relay Compiler\s+|v)/, "");
};

// --- cross-record guard ------------------------------------------------------------
// A figure that reads two bench records as ONE contrast (64- vs 192-core, batch vs
// sliced) compares the caller-named tree fields and recorded tool versions first; a
// tool the records do not carry is outside this guard. `fields` are dotted paths
// whose values must be deep-equal; `versions` are keys under each record's
// `versions` whose values must be equal strings once tsc's "Version " banner prefix
// is stripped (some benches record it verbatim).
// Throws on a mismatch, a missing field, a non-string version, or an empty
// comparison (a guard that compares nothing is a bug at the call site).
export function assertComparable(a, b, { fields = [], versions = [] }, what) {
  if (fields.length + versions.length === 0)
    throw new Error(`${what}: assertComparable called with nothing to compare`);
  const at = (o, path) => path.split(".").reduce((v, k) => v?.[k], o);
  const pair = (path) => {
    const va = at(a, path);
    const vb = at(b, path);
    if (va == null || vb == null)
      throw new Error(`${what}: missing field ${path} in a cited bench JSON`);
    return [va, vb];
  };
  const differs = (path, sa, sb) =>
    new Error(`${what}: ${path} differs (${sa} vs ${sb}) — the records are not one contrast`);
  for (const path of fields) {
    const [va, vb] = pair(path);
    if (!isDeepStrictEqual(va, vb)) throw differs(path, JSON.stringify(va), JSON.stringify(vb));
  }
  for (const key of versions) {
    const path = `versions.${key}`;
    const [va, vb] = pair(path);
    if (typeof va !== "string" || typeof vb !== "string")
      throw new Error(`${what}: ${path} is not a version string in a cited bench JSON`);
    const ver = (v) => v.replace(/^Version(?::\s*|\s+)/, "");
    if (ver(va) !== ver(vb)) throw differs(path, ver(va), ver(vb));
  }
}

// --- emit: SVG + 300 DPI PNG in one step -------------------------------------------
// The repo chart convention: regenerating a chart regenerates its raster, so the
// committed PNG can never drift from the byte-gated SVG. strict: a convert
// failure exits 1 (figures/fleet contract); otherwise it warns and keeps the SVG
// (a local run without ImageMagick still updates the gated artifact — CI always
// has convert, so the PNG is always refreshed there).
export function emitChart(name, svg, { strict = false } = {}) {
  mkdirSync("bench/charts", { recursive: true });
  const svgPath = join("bench", "charts", `${name}.svg`);
  const pngPath = join("bench", "charts", `${name}.png`);
  writeFileSync(svgPath, svg + "\n");
  console.log(`wrote ${svgPath}`);
  const conv = spawnSync(
    "convert",
    ["-density", "300", "-background", "white", svgPath, "-flatten", "-depth", "8", pngPath],
    { encoding: "utf8" },
  );
  const ok = !conv.error && conv.status === 0 && existsSync(pngPath) && statSync(pngPath).size > 0;
  if (!ok) {
    const why = conv.error
      ? "not found"
      : `exited ${conv.status}: ${(conv.stderr || "").slice(-300)}`;
    if (strict) {
      console.error(`convert failed for ${name}: ${why}`);
      process.exit(1);
    }
    console.warn(
      `! PNG NOT rasterized: ImageMagick \`convert\` ${why}. The SVG is updated but ${pngPath} may now be STALE — install ImageMagick and re-run before committing.`,
    );
    return;
  }
  console.log(`wrote ${pngPath} — 300 DPI raster of the SVG`);
}

// --- the mobile alternative: a generated markdown block in the doc --------------------
// A chart scaled to a phone is unreadable, and GitHub's mobile views ignore width media
// queries, so every chart also writes its numbers as markdown into the doc that embeds
// it, between a pair of markers:
//
//   <!-- chart-data:<id> -->
//   ...generated...
//   <!-- /chart-data:<id> -->
//
// The block is a function of the same bench JSON as the SVG, so charts.yml byte-gates
// it with the SVGs. A doc without the markers throws: a chart cannot silently lose
// its text alternative.
export const mdCell = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
export const mdTable = (head, rows, align) => {
  const al = align || head.map((_, i) => (i === 0 ? "l" : "r"));
  return [
    `| ${head.map(mdCell).join(" | ")} |`,
    `| ${al.map((a) => (a === "r" ? "---:" : a === "c" ? ":---:" : "---")).join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(mdCell).join(" | ")} |`),
  ].join("\n");
};
// <details> wrapper so the block costs one line on desktop and opens on demand
export const mdDetails = (summary, body) =>
  `<details>\n<summary>${esc(summary)}</summary>\n\n${body}\n\n</details>`;
export function writeDocBlock(docPath, id, markdown) {
  const open = `<!-- chart-data:${id} -->`;
  const close = `<!-- /chart-data:${id} -->`;
  const doc = readFileSync(docPath, "utf8");
  const a = doc.indexOf(open);
  const b = doc.indexOf(close);
  if (a < 0 || b < a)
    throw new Error(
      `${docPath}: missing the ${open} … ${close} markers for the chart's text alternative`,
    );
  if (doc.indexOf(open, a + 1) >= 0) throw new Error(`${docPath}: ${open} appears twice`);
  const next = doc.slice(0, a + open.length) + "\n" + markdown + "\n" + doc.slice(b);
  if (next !== doc) writeFileSync(docPath, next);
  console.log(`wrote ${docPath} (${id} text alternative)`);
}
