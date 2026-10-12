// Static legibility audit of a rendered chart SVG, in both themes: every text's size,
// every text's contrast against what is drawn behind it, and every non-text mark's
// contrast against the page. The dark theme is the SVG's own
// `@media (prefers-color-scheme: dark)` rules applied to the elements they select,
// so the audit checks what a GitHub dark-mode reader sees. Used by
// scripts/chartstyle-selftest.mjs over every committed bench/charts/*.svg.
//
// The audit certifies only the SVG subset this repo's generators emit, and throws
// "unsupported ..." on anything else, so a generator that starts writing a new construct
// fails CI until the audit models it. The subset (ALLOWED below), enumerated from every
// committed chart and the chart kit:
//   - markup: elements with double-quoted attributes, nothing else (no comments, no
//     processing instructions, no CDATA); text only inside <text> and <style>; entities
//     &amp; &lt; &gt; only.
//   - svg: xmlns, width, height, viewBox "0 0 W H", role="img", aria-label,
//     font-family (the kit's FONT), style="font-variant-numeric:tabular-nums".
//   - style: one `@media (prefers-color-scheme: dark){...}` block of
//     `tag[fill|stroke="value"]` selectors (tag: rect, text, line, path, polyline, circle)
//     setting fill, stroke (colours) or fill-opacity (a number).
//   - g: transform; a: href (a link around a text).
//   - rect: x y width height rx fill stroke stroke-width transform.
//   - text: x y font-size fill font-weight (a number) text-anchor (start, middle, end)
//     transform; its content plain text (no tspan).
//   - line: x1 y1 x2 y2 stroke stroke-width transform.
//   - polyline: points, fill="none" (a filled polyline is unsupported), stroke,
//     stroke-width, stroke-linejoin="round", stroke-linecap="round", transform.
//   - path: d of absolute M/L moves and segments, optionally closed by z; fill, stroke,
//     stroke-width, transform.
//   - circle: cx cy r fill stroke stroke-width transform.
//   - values: numbers; colours #rgb, #rrggbb, rgb(r,g,b), rgba(r,g,b,a) or none;
//     transform translate(x[ y]) only.
// No opacity, fill-opacity or stroke-opacity attribute, no clip-path, mask, filter,
// marker, dash array or other transform: each is unsupported, not modelled.
// Every position is read through one placement primitive, place(), that applies the
// translate() of the element and of its groups. An SVG without a full-canvas, opaque
// background rect is reported, and the rest of the audit then runs against white.

const lum = ([r, g, b]) => {
  const f = (c) => ((c /= 255), c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
export const contrast = (a, b) =>
  (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

// colour string → { rgb, a } (null for none / unparsable)
export const parseColor = (s) => {
  if (!s || s === "none" || s === "transparent") return null;
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return { rgb: [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)), a: 1 };
  m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return { rgb: [...m[1]].map((c) => parseInt(c + c, 16)), a: 1 };
  m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(s);
  if (m) return { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] };
  return null;
};
const over = (top, bottom) => top.rgb.map((c, i) => c * top.a + bottom[i] * (1 - top.a));

// ---- the allowlist ----
const NUM_SRC = "-?\\d+(?:\\.\\d+)?";
const NUM = new RegExp(`^${NUM_SRC}$`);
const COLOR =
  /^(#[0-9a-f]{3}|#[0-9a-f]{6}|rgb\(\d+,\d+,\d+\)|rgba\(\d+,\d+,\d+,(?:0|1|0?\.\d+)\))$/i;
const PAINT = { test: (v) => v === "none" || COLOR.test(v) };
const TRANSLATE = new RegExp(`^translate\\((${NUM_SRC})(?:[ ,](${NUM_SRC}))?\\)$`);
const XY = `${NUM_SRC} ${NUM_SRC}`;
const PLACED = { transform: TRANSLATE };
const STROKED = { stroke: PAINT, "stroke-width": NUM };
const ALLOWED = {
  svg: {
    xmlns: /^http:\/\/www\.w3\.org\/2000\/svg$/,
    width: NUM,
    height: NUM,
    viewBox: new RegExp(`^0 0 ${XY}$`),
    role: /^img$/,
    "aria-label": /^[^<>]*$/,
    "font-family": /^system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif$/,
    style: /^font-variant-numeric:tabular-nums$/,
  },
  style: {},
  g: PLACED,
  a: { href: /^[^<>]+$/ },
  rect: { x: NUM, y: NUM, width: NUM, height: NUM, rx: NUM, fill: PAINT, ...STROKED, ...PLACED },
  text: {
    x: NUM,
    y: NUM,
    "font-size": NUM,
    fill: COLOR,
    "font-weight": NUM,
    "text-anchor": /^(start|middle|end)$/,
    ...PLACED,
  },
  line: { x1: NUM, y1: NUM, x2: NUM, y2: NUM, ...STROKED, ...PLACED },
  polyline: {
    points: new RegExp(`^${NUM_SRC},${NUM_SRC}(?: ${NUM_SRC},${NUM_SRC})*$`),
    fill: /^none$/,
    ...STROKED,
    "stroke-linejoin": /^round$/,
    "stroke-linecap": /^round$/,
    ...PLACED,
  },
  path: { d: new RegExp(`^(?:M${XY}(?:L${XY})*z?)+$`), fill: PAINT, ...STROKED, ...PLACED },
  circle: { cx: NUM, cy: NUM, r: NUM, fill: PAINT, ...STROKED, ...PLACED },
};
const unsupported = (what) => {
  throw new Error(`unsupported ${what}: the audit certifies only the SVG subset it models`);
};
// a tag's attributes, each checked against the allowlist for its element
const attrs = (tag, body) => {
  const o = {};
  const rest = body.replace(/\s([a-zA-Z][\w:-]*)="([^"]*)"/g, (_, k, v) => {
    const form = ALLOWED[tag][k];
    if (!form || !form.test(v)) unsupported(`attribute ${k}="${v}" on <${tag}>`);
    if (k in o) unsupported(`duplicate attribute ${k} on <${tag}>`);
    o[k] = v;
    return "";
  });
  if (!/^\s*\/?$/.test(rest)) unsupported(`markup "<${tag}${body}>"`);
  return o;
};
// text content: plain characters and the three entities the generators write
const ENTITY = { "&amp;": "&", "&lt;": "<", "&gt;": ">" };
const unescape = (s) => {
  if (/&(?!amp;|lt;|gt;)/.test(s)) unsupported(`entity in "${s}"`);
  return s.replace(/&(amp|lt|gt);/g, (e) => ENTITY[e]);
};

// the dark rules: tag[attr="value"] → { prop: value }
const DARK_SEL = /^(rect|text|line|path|polyline|circle)\[(fill|stroke)="([^"]+)"\]$/;
const DARK_PROP = { fill: COLOR, stroke: COLOR, "fill-opacity": /^(0|1|0?\.\d+)$/ };
const darkRules = (css) => {
  const rules = new Map();
  const block = /^@media \(prefers-color-scheme: dark\)\{([\s\S]*)\}$/.exec(css.trim());
  if (!block) unsupported(`style "${css.trim().slice(0, 60)}"`);
  const rest = block[1].replace(/([^{}]+)\{([^{}]*)\}/g, (_, sels, body) => {
    const props = {};
    for (const p of body.split(";").filter((x) => x.trim())) {
      const [k, v] = p.split(":").map((x) => x && x.trim());
      if (!DARK_PROP[k] || !DARK_PROP[k].test(v || ""))
        unsupported(`dark rule "${sels.trim()}{${body}}"`);
      props[k] = v;
    }
    for (const sel of sels.split(",")) {
      const m = DARK_SEL.exec(sel.trim());
      if (!m) unsupported(`dark rule selector "${sel.trim()}"`);
      const key = `${m[1]}|${m[2]}|${m[3]}`;
      rules.set(key, { ...(rules.get(key) || {}), ...props });
    }
    return "";
  });
  if (rest.trim()) unsupported(`dark rule "${rest.trim().slice(0, 60)}"`);
  return rules;
};

// the SVG's elements in document order, each with its attributes and its placement
// (dx, dy: its own translate() plus every enclosing element's); texts carry their content.
// Anything outside ALLOWED throws.
const parse = (svg) => {
  const els = [];
  const texts = [];
  let css = null;
  const open = []; // { tag, dx, dy }
  let text = null; // the <text> being read
  for (const tok of svg.split(/(<[^>]*>)/)) {
    if (!tok.startsWith("<")) {
      const top = open[open.length - 1];
      if (top && top.tag === "style") css = (css ?? "") + tok;
      else if (text) text.raw += tok;
      else if (tok.trim()) unsupported(`markup "${tok.trim().slice(0, 40)}" outside <text>`);
      continue;
    }
    const m = /^<(\/?)([a-zA-Z]+)([\s\S]*?)(\/?)>$/.exec(tok);
    if (!m) unsupported(`markup "${tok.slice(0, 40)}"`);
    const [, closing, tag, body, selfClose] = m;
    if (!ALLOWED[tag]) unsupported(`element <${tag}>`);
    if (closing) {
      const top = open.pop();
      if (!top || top.tag !== tag || body.trim()) unsupported(`markup "${tok}"`);
      if (tag === "text") {
        text.s = text.raw;
        text.text = unescape(text.raw);
        texts.push(text);
        text = null;
      }
      continue;
    }
    if (text) unsupported(`element <${tag}> inside <text>`);
    const a = attrs(tag, body);
    const parent = open[open.length - 1] || { dx: 0, dy: 0 };
    const t = a.transform ? TRANSLATE.exec(a.transform) : null;
    const dx = parent.dx + (t ? +t[1] : 0);
    const dy = parent.dy + (t ? +(t[2] ?? 0) : 0);
    const e = { tag, a, dx, dy };
    if (tag === "text") {
      if (selfClose) unsupported(`markup "${tok}"`);
      text = { ...e, raw: "" };
    } else if (!["svg", "style", "g", "a"].includes(tag)) els.push(e);
    if (!selfClose) open.push({ tag, dx, dy });
  }
  if (open.length) unsupported(`unclosed <${open[open.length - 1].tag}>`);
  return { els, texts, css };
};

// effective paint of `attr` (fill/stroke) on an element in a theme: its colour, with the
// dark rule's colour and fill-opacity in the dark theme (opacity attributes are outside
// the allowlist)
const paint = (el, attr, theme, rules) => {
  const raw = el.a[attr];
  if (!raw) return null;
  let c = parseColor(raw);
  let op;
  if (theme === "dark") {
    const r = rules.get(`${el.tag}|${attr}|${raw}`);
    if (r && r[attr]) c = parseColor(r[attr]);
    if (r && r[`${attr}-opacity`]) op = r[`${attr}-opacity`];
  }
  if (!c) return null;
  const a = c.a * (op === undefined ? 1 : +op);
  return { ...c, a: Math.min(1, Math.max(0, a)) };
};

// The one placement primitive: a point in an element's own coordinates, moved by its
// translate() and its enclosing elements' (e.dx, e.dy, set by parse()). Every check reads
// positions through it.
const place = (e, x, y) => [x + e.dx, y + e.dy];

// The page: the rect that covers the whole W x H canvas from its origin (after place())
// with an opaque fill in both themes. Without one the reader's own surface shows through
// (a transparent SVG with dark text is unreadable on GitHub dark), which is an issue.
const pageRect = (els, W, H, rules) =>
  els.find((e) => {
    if (e.tag !== "rect") return false;
    const [x, y] = place(e, +e.a.x || 0, +e.a.y || 0);
    return (
      x === 0 &&
      y === 0 &&
      +e.a.width === W &&
      +e.a.height === H &&
      ["light", "dark"].every((t) => paint(e, "fill", t, rules)?.a === 1)
    );
  });

const GRID = "#e4e8ec";
const sameRgb = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 0.5);

export function auditSvg(svg, { minText, minBoxText }) {
  const W = +(/^\s*<svg\b[^>]*\swidth="([\d.]+)"/.exec(svg) ||
    unsupported("document: no <svg width>"))[1];
  const H = +(/^\s*<svg\b[^>]*\sheight="([\d.]+)"/.exec(svg) ||
    unsupported("document: no <svg height>"))[1];
  const { els, texts, css } = parse(svg);
  const rules = css === null ? new Map() : darkRules(css);
  const page = { light: [255, 255, 255], dark: null };
  const out = [];
  // without a page rect the rest of the audit runs against white in both themes
  const bgRect = pageRect(els, W, H, rules);
  if (!bgRect)
    out.push(
      `no full-canvas background rect: the page colour is unknown (white assumed in both themes)`,
    );
  page.dark = ((bgRect && paint(bgRect, "fill", "dark", rules)) || { rgb: [255, 255, 255] }).rgb;
  const geom = (e) => {
    const [x, y] = place(e, +e.a.x || 0, +e.a.y || 0);
    return { e, x, y, w: +e.a.width, h: +e.a.height };
  };
  const rects = els
    .filter((e) => e.tag === "rect" && e !== bgRect && e.a.fill && e.a.fill !== "none")
    .map(geom)
    .filter((r) => r.w > 3 && r.h > 3);
  // a text's anchor point (x, mid-height of the glyphs)
  const anchor = (t) => {
    const [x, y] = place(t, +t.a.x, +t.a.y);
    return { x, y: y - +(t.a["font-size"] || 16) * 0.35 };
  };
  for (const t of texts) {
    const [x, y] = place(t, +t.a.x, +t.a.y);
    const size = +(t.a["font-size"] || 16);
    if (size < minText) out.push(`"${t.s}" is ${size}px (floor ${minText}px)`);
    // the smallest filled rect drawn under the text's anchor point
    const under = rects
      .filter(
        (r) => x > r.x && x < r.x + r.w && y - size * 0.35 > r.y && y - size * 0.35 < r.y + r.h,
      )
      .sort((a, b) => a.w * a.h - b.w * b.h)[0];
    const isBox =
      under && under.e.a.stroke && under.e.a.stroke !== "none" && under.w > 40 && under.h > 20;
    if (isBox && size < minBoxText)
      out.push(`"${t.s}" is ${size}px inside a figure box (floor ${minBoxText}px)`);
    for (const theme of ["light", "dark"]) {
      const ink = paint(t, "fill", theme, rules) || {
        rgb: theme === "light" ? [0, 0, 0] : [0, 0, 0],
        a: 1,
      };
      let bg = page[theme];
      if (under) {
        const f = paint(under.e, "fill", theme, rules);
        if (f) bg = over(f, bg);
      }
      const c = contrast(over(ink, bg), bg);
      if (c < 4.5) out.push(`${theme}: "${t.s}" ${t.a.fill} at ${c.toFixed(2)}:1 (needs 4.5:1)`);
    }
  }
  // non-text marks, each composited over the page of the theme and held to 3:1: series
  // lines, arrows and edges (lines, polylines, paths and arrowheads), dots (filled or
  // hollow), and every rect that is not a text-framing box. A rect
  // frames text only if a rendered text's anchor point lies inside it (heat cells, figure
  // boxes) or sits beside its label (a legend swatch); one with neither is a bar and its fill
  // and stroke are marks.
  // Stripes of 3px or less, GRID hairlines and page-coloured fills (a hollow dot's centre)
  // are not marks.
  const anchors = texts.map(anchor);
  const framesText = (r) =>
    anchors.some((p) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h);
  // A labeled swatch (a legend key): a rect of at most 32x20 whose meaning is carried by
  // the text that starts within 12px to its right with its baseline inside the rect's
  // vertical extent (+-4px). The information is the adjacent text, not the tint (WCAG 1.4.11).
  const labelsSwatch = (r) =>
    r.w <= 32 &&
    r.h <= 20 &&
    texts.some((t) => {
      const [x, y] = place(t, +t.a.x, +t.a.y);
      const gap = x - (r.x + r.w);
      return (
        (t.a["text-anchor"] || "start") === "start" &&
        gap >= 0 &&
        gap <= 12 &&
        y >= r.y - 4 &&
        y <= r.y + r.h + 4
      );
    });
  const check = (e, attr, theme) => {
    const raw = e.a[attr];
    // a GRID-coloured hairline (gridline, rule) is decoration; a GRID outline on a rect or
    // a dot is a mark like any other
    const hairline = attr === "stroke" && ["line", "path", "polyline"].includes(e.tag);
    if (!raw || raw === "none" || (hairline && raw.toLowerCase() === GRID)) return;
    const c0 = paint(e, attr, theme, rules);
    if (!c0 || c0.a === 0)
      return out.push(`${theme}: ${e.tag} ${attr} ${raw} is fully transparent`);
    if (sameRgb(c0.rgb, page[theme])) return;
    const c = contrast(over(c0, page[theme]), page[theme]);
    if (c < 3) {
      const alpha = c0.a < 1 ? ` (alpha ${+c0.a.toFixed(3)})` : "";
      out.push(`${theme}: ${e.tag} ${attr} ${raw}${alpha} at ${c.toFixed(2)}:1 (marks need 3:1)`);
    }
  };
  for (const e of els) {
    if (e === bgRect) continue;
    const attrsToCheck = [];
    if (e.tag === "circle") attrsToCheck.push("fill", "stroke");
    else if (e.tag === "polyline" || e.tag === "line") attrsToCheck.push("stroke");
    else if (e.tag === "path")
      attrsToCheck.push("stroke", "fill"); // edges and arrowheads
    else if (e.tag === "rect") {
      const r = geom(e);
      if (r.w <= 3 || r.h <= 3 || framesText(r) || labelsSwatch(r)) continue;
      attrsToCheck.push("fill", "stroke");
    } else continue;
    for (const attr of attrsToCheck) for (const theme of ["light", "dark"]) check(e, attr, theme);
  }
  return out;
}
