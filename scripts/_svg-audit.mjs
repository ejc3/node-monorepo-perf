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
//   - svg: the root element only (a nested one would open a new viewport); xmlns, width,
//     height, viewBox "0 0 W H" with the same W and H (another would scale every size),
//     role="img", aria-label, font-family (the kit's FONT),
//     style="font-variant-numeric:tabular-nums".
//   - style: one `@media (prefers-color-scheme: dark){...}` block of
//     `tag[fill|stroke="value"]` selectors (tag: rect, text, line, path, polyline, circle),
//     each rule setting only the property its selector reads: fill (a colour) and
//     fill-opacity (a number) on a [fill] selector, stroke (a colour) on a [stroke] one.
//   - g: transform; a: href (a link around a text).
//   - rect: x y width height rx fill stroke stroke-width transform; fill required (SVG
//     fills an element without one black, a paint no dark rule can select).
//   - text: x y font-size fill font-weight (a number) text-anchor (start, middle, end)
//     transform; its content plain text (no tspan).
//   - line: x1 y1 x2 y2 stroke stroke-width transform.
//   - polyline: points, fill="none" (a filled polyline is unsupported), stroke,
//     stroke-width, stroke-linejoin="round", stroke-linecap="round", transform.
//   - path: d of absolute M/L moves and segments, optionally closed by z; fill (required),
//     stroke, stroke-width, transform.
//   - circle: cx cy r fill (required) stroke stroke-width transform.
//   - values: numbers; colours #rgb, #rrggbb, rgb(r,g,b), rgba(r,g,b,a) or none;
//     transform translate(x[ y]) only.
// No opacity, fill-opacity or stroke-opacity attribute, no clip-path, mask, filter,
// marker, dash array or other transform: each is unsupported, not modelled.
// Every position is read through one placement primitive, place(), that applies the
// translate() of the element and of its groups. The page is the first painted element
// when that is a full-canvas rect, opaque in both themes; each theme's page colour is its
// fill in that theme. An SVG without one is reported, and the rest of the audit then runs
// against white. A full-canvas rect painted later is ordinary paint.
//
// A text is judged over its glyph box, never its anchor point: the box runs from its
// placed anchor by its text-anchor over the kit's advance-width estimate (approxW in
// _chartstyle.mjs, the estimate its layout uses), 0.75em above the baseline and 0.21em
// below it. Every filled rect that meets the box was painted either before the text, where
// it holds the whole box inside its inner edge (inset by half its stroke: a frame) or
// crosses the box's edge (reported), or after it (reported as covering it). The text's
// backdrop is the page plus its frames composited in document order; a crossing rect
// painted under an opaque frame is hidden by it and not reported.

import { approxW } from "./_chartstyle.mjs";

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
      // a rule restyles only the property its selector reads (fill-opacity goes with
      // fill): paint() looks a rule up by the element's value of that same property
      for (const k of Object.keys(props))
        if (k.replace(/-opacity$/, "") !== m[2])
          unsupported(`dark rule "${sel.trim()}{${body}}": it sets ${k} on a [${m[2]}] selector`);
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
  let root = null; // the <svg> element's attributes
  const open = []; // { tag, dx, dy }
  let text = null; // the <text> being read
  let ord = 0; // paint order
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
    // one <svg>, the root: a nested one would open a new viewport
    if ((tag === "svg") !== (ord === 0 && !open.length))
      unsupported(`markup "${tok.slice(0, 40)}"`);
    if (tag === "svg") root = a;
    // an element with no fill attribute is filled black, a paint no dark rule can select
    if (["rect", "circle", "path"].includes(tag) && !("fill" in a))
      unsupported(`<${tag}> with no fill (SVG fills it black)`);
    const parent = open[open.length - 1] || { dx: 0, dy: 0 };
    const t = a.transform ? TRANSLATE.exec(a.transform) : null;
    const dx = parent.dx + (t ? +t[1] : 0);
    const dy = parent.dy + (t ? +(t[2] ?? 0) : 0);
    const e = { tag, a, dx, dy, ord: ++ord };
    if (tag === "text") {
      if (selfClose) unsupported(`markup "${tok}"`);
      text = { ...e, raw: "" };
    } else if (!["svg", "style", "g", "a"].includes(tag)) els.push(e);
    if (!selfClose) open.push({ tag, dx, dy });
  }
  if (open.length) unsupported(`unclosed <${open[open.length - 1].tag}>`);
  if (!root) unsupported("document: no <svg>");
  return { root, els, texts, css };
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

// The page: the first painted element, when it is a rect that covers the whole W x H
// canvas from its origin (after place()) with an opaque fill in both themes. Without one
// the reader's own surface shows through (a transparent SVG with dark text is unreadable
// on GitHub dark), which is an issue. A full-canvas rect painted after any text or mark is
// ordinary paint: it covers what is under it.
const pageRect = (els, texts, W, H, rules) => {
  const e = [els[0], texts[0]].filter(Boolean).sort((p, q) => p.ord - q.ord)[0];
  if (!e || e.tag !== "rect") return undefined;
  const [x, y] = place(e, +e.a.x || 0, +e.a.y || 0);
  const full =
    x === 0 &&
    y === 0 &&
    +e.a.width === W &&
    +e.a.height === H &&
    ["light", "dark"].every((t) => paint(e, "fill", t, rules)?.a === 1);
  return full ? e : undefined;
};

const GRID = "#e4e8ec";
const sameRgb = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 0.5);

export function auditSvg(svg, { minText, minBoxText }) {
  const { root, els, texts, css } = parse(svg);
  if (!root.width || !root.height) unsupported("document: no <svg width> and height");
  const W = +root.width;
  const H = +root.height;
  // every size and position is read in CSS pixels: a viewBox other than the canvas would
  // scale them
  if (
    root.viewBox !== undefined &&
    root.viewBox.split(" ").map(Number).join(" ") !== `0 0 ${W} ${H}`
  )
    unsupported(`viewBox "${root.viewBox}" on a ${W}x${H} <svg>`);
  const rules = css === null ? new Map() : darkRules(css);
  const out = [];
  // each theme's page colour is the page rect's fill in that theme; without a page rect
  // the rest of the audit runs against white in both themes
  const bgRect = pageRect(els, texts, W, H, rules);
  if (!bgRect)
    out.push(
      `no full-canvas background rect: the page colour is unknown (white assumed in both themes)`,
    );
  const page = Object.fromEntries(
    ["light", "dark"].map((t) => [
      t,
      bgRect ? paint(bgRect, "fill", t, rules).rgb : [255, 255, 255],
    ]),
  );
  const geom = (e) => {
    const [x, y] = place(e, +e.a.x || 0, +e.a.y || 0);
    return { e, x, y, w: +e.a.width, h: +e.a.height };
  };
  // filled rects (wider and taller than a 3px stripe), in paint order
  const rects = els
    .filter((e) => e.tag === "rect" && e !== bgRect && e.a.fill && e.a.fill !== "none")
    .map(geom)
    .filter((r) => r.w > 3 && r.h > 3);
  // a text's glyph box [x0, y0, x1, y1] (spaces at either end carry no ink); null if none
  const glyphBox = (t) => {
    const size = +(t.a["font-size"] || 16);
    const bold = +(t.a["font-weight"] || 400) >= 600;
    const s = t.text;
    if (!s.trim()) return null;
    const share = { start: 0, middle: 0.5, end: 1 }[t.a["text-anchor"] || "start"];
    const [x, y] = place(t, +t.a.x, +t.a.y);
    const x0 = x - approxW(s, size, bold) * share;
    const lead = s.length - s.trimStart().length;
    return [
      x0 + approxW(s.slice(0, lead), size, bold),
      y - 0.75 * size,
      x0 + approxW(s.trimEnd(), size, bold),
      y + 0.21 * size,
    ];
  };
  // boxes are [x0, y0, x1, y1]
  const meets = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  const outer = (r) => [r.x, r.y, r.x + r.w, r.y + r.h];
  // does rect r hold box b inside its inner edge (inset by half its stroke, if painted)?
  const holds = (r, b) => {
    const hw = r.e.a.stroke && r.e.a.stroke !== "none" ? +(r.e.a["stroke-width"] ?? 1) / 2 : 0;
    return b[0] >= r.x + hw && b[1] >= r.y + hw && b[2] <= r.x + r.w - hw && b[3] <= r.y + r.h - hw;
  };
  const opaque = (r) => ["light", "dark"].every((th) => paint(r.e, "fill", th, rules)?.a === 1);
  // The paint-order model, the one place backdrops, crossings and covers are decided, over
  // a text's glyph box b. Of the filled rects meeting b: painted before the text, those
  // holding b are its frames (its backdrop stack, bottom first) and the rest cross its
  // edge, unless an opaque frame painted after them hides them; painted after the text,
  // they cover it.
  const paintAround = (t, b) => {
    const meeting = rects.filter((r) => meets(outer(r), b));
    const before = meeting.filter((r) => r.e.ord < t.ord);
    const frames = before.filter((r) => holds(r, b));
    const floor = frames.filter(opaque).pop();
    return {
      frames,
      crossing: before.filter((r) => !holds(r, b) && !(floor && r.e.ord < floor.e.ord)),
      above: meeting.filter((r) => r.e.ord > t.ord),
    };
  };
  const boxes = new Map(texts.map((t) => [t, glyphBox(t)]));
  for (const t of texts) {
    const size = +(t.a["font-size"] || 16);
    if (size < minText) out.push(`"${t.s}" is ${size}px (floor ${minText}px)`);
    const b = boxes.get(t);
    if (!b) continue;
    const { frames, crossing, above } = paintAround(t, b);
    for (const r of crossing)
      out.push(`"${t.s}" crosses the edge of the rect painted under it (fill ${r.e.a.fill})`);
    for (const r of above)
      out.push(`"${t.s}" is covered by a rect drawn after it (fill ${r.e.a.fill})`);
    // the topmost frame painted under the text
    const under = frames[frames.length - 1];
    const isBox =
      under && under.e.a.stroke && under.e.a.stroke !== "none" && under.w > 40 && under.h > 20;
    if (isBox && size < minBoxText)
      out.push(`"${t.s}" is ${size}px inside a figure box (floor ${minBoxText}px)`);
    for (const theme of ["light", "dark"]) {
      const ink = paint(t, "fill", theme, rules) || {
        rgb: theme === "light" ? [0, 0, 0] : [0, 0, 0],
        a: 1,
      };
      // the page, then every frame in paint order
      let bg = page[theme];
      for (const r of frames) {
        const f = paint(r.e, "fill", theme, rules);
        if (f) bg = over(f, bg);
      }
      const c = contrast(over(ink, bg), bg);
      if (c < 4.5) out.push(`${theme}: "${t.s}" ${t.a.fill} at ${c.toFixed(2)}:1 (needs 4.5:1)`);
    }
  }
  // Non-text marks, each held to 3:1 as drawn: series lines, arrows and edges (lines,
  // polylines, paths and arrowheads), dots (filled or hollow), and every rect that is not a
  // text-framing box. A rect frames text only if it holds a rendered text's glyph box
  // inside its inner edge (heat cells, figure boxes) or sits beside its label (a legend
  // swatch); one with neither is a bar and its fill and stroke are marks.
  // A mark is judged over its extent (its bounding box, stroke included): its backdrop is
  // the page plus every filled rect painted before it that holds the extent inside its
  // inner edge, composited in document order, and every filled rect or circle painted after
  // it whose fill holds the extent is composited over both the mark and its backdrop. An
  // opaque one hides it, which is reported.
  // Stripes of 3px or less and GRID hairlines are not marks. A channel (fill or stroke)
  // coloured like its backdrop is not a mark only when the element's other channel is
  // painted (a colour of alpha above 0; a stroke also of width above 0) and itself passes
  // as a mark: the page-coloured halo around a filled dot, the page-coloured centre of a
  // hollow ring. A page-coloured series line, edge, ring or outline with nothing else
  // painted is reported.
  const framesText = (r) => [...boxes.values()].some((b) => b && holds(r, b));
  // A labeled swatch (a legend key): a rect of at most 32x20 whose meaning is carried by
  // the inked text that starts within 12px to its right with its baseline inside the rect's
  // vertical extent (+-4px). The information is the adjacent text, not the tint (WCAG 1.4.11).
  const labelsSwatch = (r) =>
    r.w <= 32 &&
    r.h <= 20 &&
    texts.some((t) => {
      if (!boxes.get(t)) return false;
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
  // a mark's extent [x0, y0, x1, y1]: the bounding box of its geometry, grown by half its
  // stroke width when a stroke is set
  const extent = (e) => {
    const hw = e.a.stroke && e.a.stroke !== "none" ? +(e.a["stroke-width"] ?? 1) / 2 : 0;
    let pts;
    if (e.tag === "circle")
      pts = [
        [+e.a.cx - +e.a.r, +e.a.cy - +e.a.r],
        [+e.a.cx + +e.a.r, +e.a.cy + +e.a.r],
      ];
    else if (e.tag === "rect") {
      const [x, y] = [+e.a.x || 0, +e.a.y || 0];
      pts = [
        [x, y],
        [x + +e.a.width, y + +e.a.height],
      ];
    } else if (e.tag === "line")
      pts = [
        [+e.a.x1, +e.a.y1],
        [+e.a.x2, +e.a.y2],
      ];
    else if (e.tag === "polyline") pts = e.a.points.split(" ").map((p) => p.split(",").map(Number));
    else
      pts = [...e.a.d.matchAll(new RegExp(`(${NUM_SRC}) (${NUM_SRC})`, "g"))].map((m) => [
        +m[1],
        +m[2],
      ]);
    pts = pts.map(([x, y]) => place(e, x, y));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return [Math.min(...xs) - hw, Math.min(...ys) - hw, Math.max(...xs) + hw, Math.max(...ys) + hw];
  };
  // does the fill of a rect or circle s hold box b? A rect's fill is its box less the rx
  // corner squares; a circle's is its disk.
  const fillHolds = (s, b) => {
    if (s.tag === "circle") {
      const [cx, cy] = place(s, +s.a.cx, +s.a.cy);
      return [
        [b[0], b[1]],
        [b[2], b[1]],
        [b[0], b[3]],
        [b[2], b[3]],
      ].every(([x, y]) => Math.hypot(x - cx, y - cy) <= +s.a.r);
    }
    const { x, y, w, h } = geom(s);
    if (!(b[0] >= x && b[1] >= y && b[2] <= x + w && b[3] <= y + h)) return false;
    const c = Math.min(+s.a.rx || 0, w / 2, h / 2);
    return !(
      c > 0 &&
      [
        [x, y, x + c, y + c],
        [x + w - c, y, x + w, y + c],
        [x, y + h - c, x + c, y + h],
        [x + w - c, y + h - c, x + w, y + h],
      ].some((sq) => meets(sq, b))
    );
  };
  const fillers = els.filter(
    (e) => e !== bgRect && (e.tag === "rect" || e.tag === "circle") && e.a.fill !== "none",
  );
  // channel `attr` of mark e as drawn in a theme: its paint c0, its backdrop bg, then the
  // mark (ink) and its backdrop (back) under every filled shape painted after it that holds
  // its extent; hiddenBy is the first opaque one
  const drawn = (e, attr, theme) => {
    const ext = extent(e);
    let bg = page[theme];
    for (const r of rects)
      if (r.e !== e && r.e.ord < e.ord && holds(r, ext)) {
        const f = paint(r.e, "fill", theme, rules);
        if (f) bg = over(f, bg);
      }
    const c0 = paint(e, attr, theme, rules);
    let ink = c0 ? over(c0, bg) : bg;
    let back = bg;
    let hiddenBy = null;
    for (const s of fillers)
      if (s.ord > e.ord && fillHolds(s, ext)) {
        const f = paint(s, "fill", theme, rules);
        if (!f) continue;
        ink = over(f, ink);
        back = over(f, back);
        if (f.a === 1) hiddenBy ??= s;
      }
    return { c0, bg, ink, back, hiddenBy };
  };
  // does channel attr of e pass as a mark in a theme?
  const passes = (e, attr, theme) => {
    const raw = e.a[attr];
    if (!raw || raw === "none") return false;
    if (attr === "stroke" && !(+(e.a["stroke-width"] ?? 1) > 0)) return false;
    const v = drawn(e, attr, theme);
    return Boolean(v.c0 && v.c0.a > 0 && !v.hiddenBy && contrast(v.ink, v.back) >= 3);
  };
  const check = (e, attr, theme) => {
    const raw = e.a[attr];
    // a GRID-coloured hairline (gridline, rule) is decoration; a GRID outline on a rect or
    // a dot is a mark like any other
    const hairline = attr === "stroke" && ["line", "path", "polyline"].includes(e.tag);
    if (!raw || raw === "none" || (hairline && raw.toLowerCase() === GRID)) return;
    const v = drawn(e, attr, theme);
    if (!v.c0 || v.c0.a === 0)
      return out.push(`${theme}: ${e.tag} ${attr} ${raw} is fully transparent`);
    if (v.hiddenBy)
      return out.push(
        `${theme}: ${e.tag} ${attr} ${raw} is hidden by a ${v.hiddenBy.tag} drawn after it (fill ${v.hiddenBy.a.fill})`,
      );
    const other = attr === "fill" ? "stroke" : "fill";
    if (sameRgb(v.c0.rgb, v.bg) && passes(e, other, theme)) return;
    const c = contrast(v.ink, v.back);
    if (c < 3) {
      const alpha = v.c0.a < 1 ? ` (alpha ${+v.c0.a.toFixed(3)})` : "";
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
