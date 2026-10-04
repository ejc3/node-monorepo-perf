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

import { writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
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
}</style>`;

export const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// --- document ------------------------------------------------------------------
// Every SVG gets role="img" + an aria-label stating the mechanism, the dark-mode
// block, and an EXPLICIT light background rect the dark block retargets — a
// transparent SVG with dark text is unreadable on GitHub dark.
export const svgDoc = (w, h, aria, body) =>
  [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(aria)}" font-family="${FONT}">`,
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

// rounded tinted section frame (heat charts and infographics group each
// comparison inside one)
export const sectionFrame = (x, y, w, h, tint = "blue") =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${TINT[tint][0]}" stroke="${TINT[tint][1]}" stroke-width="1.2"/>`;

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

// the ramp legend band every heat chart shows (extra chart-specific states are
// appended by the caller)
export const rampLegendItems = () => [
  { c: rgbCss(rampRGB(1)), t: "fastest" },
  { c: rgbCss(rampRGB(2)), t: "×2 slower" },
  { c: rgbCss(rampRGB(10)), t: "×10" },
  { c: rgbCss(rampRGB(100)), t: "×100+" },
  { c: GRID, t: "— not measured" },
];
export const legendRow = (x, y, items) => {
  const parts = [];
  let lx = x;
  for (const it of items) {
    parts.push(`<rect x="${lx}" y="${y - 10}" width="14" height="14" rx="4" fill="${it.c}"/>`);
    lx += 19;
    parts.push(txt(lx, y + 1, it.t, { size: 11, fill: MUTED }));
    lx += approxW(it.t, 11) + 16;
  }
  return { parts, endX: lx };
};

// --- heat-table pieces -------------------------------------------------------------
// One cell: a rounded block (2px surface gap to its neighbors) with centered
// headline/sub/(detail) lines in the ink picked against its fill.
export const heatCell = (x, y, w, h, fill, ink, main, sub, detail) => {
  const cx = x + w / 2;
  const cy = y + h / 2;
  // auto-fit: a long headline shrinks instead of running past the cell edge
  const mainSize = Math.min(15.5, +((w - 14) / (String(main).length * 0.58)).toFixed(1));
  const parts = [
    `<rect x="${x + 1.5}" y="${y + 1.5}" width="${w - 3}" height="${h - 3}" rx="5" fill="${fill}"/>`,
    txt(cx, cy + (detail ? -7 : -3), main, {
      size: mainSize,
      fill: ink,
      weight: "700",
      anchor: "middle",
    }),
  ];
  if (sub)
    parts.push(
      txt(cx, cy + (detail ? 8 : 15), sub, {
        size: 11.5,
        fill: ink,
        weight: "600",
        anchor: "middle",
      }),
    );
  if (detail)
    parts.push(
      `<text x="${cx}" y="${cy + 20}" font-size="9.5" fill="${ink}" opacity="0.85" text-anchor="middle">${esc(detail)}</text>`,
    );
  return parts;
};
// "—" cell for an intentionally-unmeasured value (never a failure disguised)
export const naCell = (x, y, w, h, why) => {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const parts = [
    `<rect x="${x + 1.5}" y="${y + 1.5}" width="${w - 3}" height="${h - 3}" rx="5" fill="${GRID}"/>`,
    txt(cx, cy + (why ? -2 : 5), "—", { size: 15, fill: MUTED, anchor: "middle" }),
  ];
  if (why) parts.push(txt(cx, cy + 15, why, { size: 9.5, fill: MUTED, anchor: "middle" }));
  return parts;
};
// column header on the section frame: centered label lines, optional sub line,
// and the tool-identity chip (the stable TOOL_COLORS hue) as an underline
export const colHeader = (x, y, w, h, label, { sub, chip } = {}) => {
  const parts = [];
  const lines = String(label).split("\n");
  const block = lines.length * 14 + (sub ? 11 : 0); // text block height
  const ly = y + Math.max(14, (h - 10 - block) / 2 + 11); // centered above the chip strip
  lines.forEach((ln, k) =>
    parts.push(txt(x + w / 2, ly + k * 14, ln, { size: 12.5, weight: "700", anchor: "middle" })),
  );
  if (sub)
    parts.push(
      txt(x + w / 2, ly + (lines.length - 1) * 14 + 12, sub, {
        size: 9,
        fill: MUTED,
        anchor: "middle",
      }),
    );
  if (chip) {
    if (!TOOL_COLORS[chip]) throw new Error(`no stable tool color for "${chip}"`);
    parts.push(
      `<rect x="${x + w / 2 - 14}" y="${y + h - 7}" width="28" height="4" rx="2" fill="${TOOL_COLORS[chip]}"/>`,
    );
  }
  return parts;
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
