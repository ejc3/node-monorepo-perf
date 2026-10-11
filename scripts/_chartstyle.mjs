// The shared visual system every SVG generator in this repo draws with
// (diagram-style-spec.md, distilled from the cmux page). One palette, one
// dark-mode <style> block, one box/text/arrow grammar, one heat ramp — so the
// heat charts, the mechanism figures, the fleet infographic, and the scaling
// charts read as one system. Imported by figures.mjs, comparison-chart.mjs,
// scale-chart.mjs, net-cache-chart.mjs, fleet-chart.mjs, chart.mjs.
//
// Deterministic by construction: no Date, no environment reads — every export
// is a pure constant or a pure function of its arguments (emitChart's PNG
// raster is the one side effect, per the repo's SVG+PNG-in-one-step contract).
// Also home to assertComparable, the guard every two-record figure calls before
// it draws the records as one contrast.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

// --- palette -------------------------------------------------------------------
export const INK = "#1c2330";
export const MUTED = "#6b7885";
export const ACCENT = "#1a73e8";
export const GRID = "#e4e8ec";
export const BG = "#ffffff";
// box tints: [fill, border] — semantic, not decorative
export const TINT = {
  blue: ["#eef3fb", "#b9cdec"], // component / neutral
  green: ["#f0faf5", "#a9d8bd"], // fast path / green verdict
  rust: ["#fdf3ef", "#e4b9a6"], // slow path / red verdict / blast radius
  amber: ["#fbf6e9", "#eee3bb"], // caveat / incident window
};

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
rect[fill="#eef3fb"]{fill:#1f2f45}rect[stroke="#b9cdec"]{stroke:#3d5a85}
rect[fill="#f0faf5"]{fill:#173029}rect[stroke="#a9d8bd"]{stroke:#2e6b52}
rect[fill="#fdf3ef"]{fill:#331f18}rect[stroke="#e4b9a6"]{stroke:#7a4630}
rect[fill="#fbf6e9"]{fill:#c9a13b;fill-opacity:.14}rect[stroke="#eee3bb"]{stroke:#7a6224}
rect[fill="#e4b9a6"]{fill:#7a4630}
text[fill="#1a7f45"]{fill:#5cc48c}
text[fill="#b0382f"]{fill:#f0847b}
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
export const box = (x, y, w, h, tint, rx = 7) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${TINT[tint][0]}" stroke="${TINT[tint][1]}" stroke-width="1.2"/>`;

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
  return `<path d="${d}" stroke="${MUTED}" stroke-width="1.5" fill="none"/>`;
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
  const hl = 7; // head length
  const hw = 3; // head half-width
  const bx = x2 - ux * hl;
  const by = y2 - uy * hl;
  const f = (n) => +n.toFixed(1);
  return (
    (dashed
      ? dashes(x1, y1, bx, by)
      : `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(bx)}" y2="${f(by)}" stroke="${MUTED}" stroke-width="1.5"/>`) +
    `<path d="M${f(x2)} ${f(y2)}L${f(bx - uy * hw)} ${f(by + ux * hw)}L${f(bx + uy * hw)} ${f(by - ux * hw)}z" fill="${MUTED}"/>`
  );
};

// provenance footer: a hairline + one muted "data: …" line (the number-tracing
// rule made visible inside the image)
export const footer = (w, y, sources, pad = 16) => [
  `<line x1="${pad}" y1="${y - 14}" x2="${w - pad}" y2="${y - 14}" stroke="${GRID}"/>`,
  txt(pad, y, `data: ${sources}`, { size: 10, fill: MUTED }),
];

// --- the heat ramp ---------------------------------------------------------------
// Anchored at MULTIPLES of the row's fastest and interpolated in log-multiple
// space, so ×12 is the same color in every chart. Green is deliberately narrow:
// by ×2 a cell is full amber, then it ramps through orange to red (clamped at
// ×100). Anchors are this palette's saturated green/amber/rust/red, mid-toned so
// the per-cell ink (inkFor) clears readable contrast on both themes.
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
const relLum = ([r, g, b]) => {
  const lin = (c) => ((c /= 255), c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
const DARK_INK = [10, 13, 18];
const DARK_INK_L = relLum(DARK_INK);
// Pick whichever ink contrasts MORE with the cell fill, so a cell never gets the
// worse-legibility color; the fill is constant across themes, so the choice
// holds on light and dark alike.
export const inkFor = (rgb) => {
  const L = relLum(rgb);
  return contrast(L, DARK_INK_L) >= contrast(L, 1) ? "#0a0d12" : "#ffffff";
};
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
// One scale for every generator (px in SVG user units). Charts are drawn at a width
// that GitHub shows at roughly 1:1 on a desktop column (≤ 880), so these are the
// sizes a reader sees.
export const TYPE = {
  title: 17, // chart title
  lede: 12, // the one line under the title
  section: 13.5, // section heading in a stacked chart
  head: 11.5, // column header
  label: 11.5, // row label / box label
  value: 13, // a cell's headline number
  sub: 10.5, // a cell's second line
  note: 10, // per-section note, legend, axis
};

// a positive / negative verdict colour for TEXT (not fills): readable on white and,
// via the dark block, on GitHub dark
export const GOOD = "#1a7f45";
export const BAD = "#b0382f";

// --- heat-table pieces (v2) ----------------------------------------------------------
// A cell is a quiet tint, not a saturated button: the ramp colour at CELL_ALPHA
// opacity, so the same fill reads as a pale tint on white and a dark tint on GitHub
// dark, and the text is always plain ink. The headline is the measured value; the
// second line is its standing (fastest / +N% / ×N). A 3px stripe at the left edge
// carries the full-strength ramp colour so the ranking still scans at a glance.
export const CELL_ALPHA = 0.2;
// rgba() rather than fill-opacity: ImageMagick's internal SVG renderer (what `convert`
// uses here and in CI) ignores fill-opacity and opacity but honours an rgba() fill
export const tintCss = ([r, g, b], a = CELL_ALPHA) => `rgba(${r},${g},${b},${a})`;
const CELL_GAP = 2;
export const heatCell = (x, y, w, h, rgb, main, sub, { detail, subFill } = {}) => {
  const ix = x + CELL_GAP / 2;
  const iy = y + CELL_GAP / 2;
  const iw = w - CELL_GAP;
  const ih = h - CELL_GAP;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const fill = rgbCss(rgb);
  const mainSize = Math.min(TYPE.value, +((iw - 14) / (String(main).length * 0.6)).toFixed(1));
  const parts = [
    `<rect x="${ix}" y="${iy}" width="${iw}" height="${ih}" rx="3" fill="${tintCss(rgb)}"/>`,
    `<rect x="${ix}" y="${iy}" width="3" height="${ih}" rx="1.5" fill="${fill}"/>`,
    txt(cx, cy + (detail ? -6 : sub ? -1 : 4.5), main, {
      size: mainSize,
      weight: "650",
      anchor: "middle",
    }),
  ];
  if (sub)
    parts.push(
      txt(cx, cy + (detail ? 8 : 13), sub, {
        size: TYPE.sub,
        fill: subFill || MUTED,
        weight: subFill ? "600" : "",
        anchor: "middle",
      }),
    );
  if (detail)
    parts.push(txt(cx, cy + 20, detail, { size: TYPE.note - 1, fill: MUTED, anchor: "middle" }));
  return parts;
};
// a measured cell: value headline + standing sub-line from its multiple of the best
export const rankedCell = (x, y, w, h, mult, valueText, { detail } = {}) => {
  if (isFastest(mult))
    return heatCell(x, y, w, h, rampRGB(1), valueText, "fastest", { detail, subFill: GOOD });
  if (isNearTie(mult))
    return heatCell(
      x,
      y,
      w,
      h,
      rampRGB(1),
      valueText,
      nearTiePct(mult).replace(" vs fastest", ""),
      {
        detail,
      },
    );
  return heatCell(x, y, w, h, rampRGB(mult), valueText, fmtMult(mult), { detail });
};
// a status cell (crash, wedge, timeout): status words, never a number posing as one
export const statusCell = (x, y, w, h, main, sub) =>
  heatCell(x, y, w, h, RAMP[RAMP.length - 1][1], main, sub, { subFill: BAD });
// "—" cell for an intentionally-unmeasured value (never a failure disguised)
export const naCell = (x, y, w, h, why) => {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const parts = [
    `<rect x="${x + CELL_GAP / 2}" y="${y + CELL_GAP / 2}" width="${w - CELL_GAP}" height="${h - CELL_GAP}" rx="3" fill="none" stroke="${GRID}"/>`,
    txt(cx, cy + (why ? -1 : 4.5), "—", { size: TYPE.value, fill: MUTED, anchor: "middle" }),
  ];
  if (why)
    parts.push(txt(cx, cy + 13, why, { size: TYPE.note - 0.5, fill: MUTED, anchor: "middle" }));
  return parts;
};
// column header: label lines (bold), optional muted sub line, and the tool's stable
// hue as a small dot left of the first line (identity without decoration)
export const colHeader = (x, y, w, h, label, { sub, chip } = {}) => {
  const parts = [];
  const lines = String(label).split("\n");
  const lh = 13.5;
  const block = lines.length * lh + (sub ? 12 : 0);
  const ly = y + h - block + 6; // bottom-aligned on the header band
  if (chip && !TOOL_COLORS[chip]) throw new Error(`no stable tool color for "${chip}"`);
  lines.forEach((ln, k) => {
    parts.push(
      txt(x + w / 2 + (chip && k === 0 ? 5 : 0), ly + k * lh, ln, {
        size: TYPE.head,
        weight: "650",
        anchor: "middle",
      }),
    );
    if (chip && k === 0)
      parts.push(
        `<circle cx="${(x + w / 2 - approxW(ln, TYPE.head, true) / 2 - 2).toFixed(1)}" cy="${ly - 4}" r="3.5" fill="${TOOL_COLORS[chip]}"/>`,
      );
  });
  if (sub)
    parts.push(
      txt(x + w / 2, ly + (lines.length - 1) * lh + 12, sub, {
        size: TYPE.note - 0.5,
        fill: MUTED,
        anchor: "middle",
      }),
    );
  return parts;
};
// section heading for a stacked chart: title + optional muted lede, then a hairline.
// Returns the parts and the y where the section body starts.
export const sectionHead = (x, y, w, title, lede) => {
  const parts = [txt(x, y, title, { size: TYPE.section, weight: "650" })];
  let by = y;
  if (lede) {
    by += 16;
    parts.push(txt(x, by, lede, { size: TYPE.note + 0.5, fill: MUTED }));
  }
  by += 9;
  parts.push(`<line x1="${x}" y1="${by}" x2="${x + w}" y2="${by}" stroke="${GRID}"/>`);
  return { parts, bodyY: by };
};
// the ramp key: the four anchors as tinted chips with their stripe, plus extra states
export const rampLegend = (x, y, extra = []) => {
  const items = [
    { rgb: rampRGB(1), t: "fastest" },
    { rgb: rampRGB(2), t: "×2" },
    { rgb: rampRGB(10), t: "×10" },
    { rgb: rampRGB(100), t: "×100+ slower" },
    ...extra,
  ];
  const parts = [];
  let lx = x;
  for (const it of items) {
    if (it.rgb) {
      parts.push(
        `<rect x="${lx}" y="${y - 9}" width="20" height="12" rx="2" fill="${tintCss(it.rgb)}"/>`,
        `<rect x="${lx}" y="${y - 9}" width="3" height="12" rx="1.5" fill="${rgbCss(it.rgb)}"/>`,
      );
      lx += 25;
    }
    parts.push(txt(lx, y + 1, it.t, { size: TYPE.note, fill: MUTED }));
    lx += approxW(it.t, TYPE.note) + 14;
  }
  return { parts, endX: lx };
};

// --- text measurement / wrapping --------------------------------------------------
// Rough advance-width estimate (px) so canvases widen to fit prose, never clip.
export const approxW = (str, px, bold = false) => str.length * px * (bold ? 0.58 : 0.53);
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
