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
//     `tag[fill|stroke="colour"]` selectors (tag: rect, text, line, path, polyline,
//     circle; the selected value a colour, never none), each rule setting only the
//     property its selector reads: fill (a colour) and fill-opacity (a number) on a
//     [fill] selector, stroke (a colour) on a [stroke] one.
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
// translate() of the element and of its groups, and every shape's geometry through one
// geometry primitive, shapeOf(), built on it: where its fill paints (a rect less its
// rounded corners, a circle's disk, a filled path's subpaths), what lies inside its
// stroke's inner edge, and where its stroke's ring paints. The page is the first painted
// element when its fill covers the whole canvas, opaque in both themes; each theme's page
// colour is its fill in that theme. An SVG without one is reported, and the rest of the
// audit then runs against white. A canvas-covering fill painted later is ordinary paint. A
// background rect with a stroke is unsupported.
//
// Text is at least minText, and at least minBoxText inside a figure box: a text is inside
// one when any rect painted under it, filled or fill="none", that holds its glyph box
// inside its stroke's inner edge has a painted border (a stroke of width above 0 whose
// colour has alpha above 0 in either theme), whatever the rect's size. A 20px package chip
// is a box; an unbordered tint (a heat cell) is not.
//
// A text is judged over its glyph box, never its anchor point: the box is estimated from
// its placed anchor, text-anchor, font-size and font-weight with the per-glyph advances
// of _text-width.mjs (the wider of Arial x 1.1 and DejaVu Sans, regular or bold), so it
// holds Arial/Liberation Sans, SF Pro and DejaVu Sans. Every fill (rect, circle or path)
// that meets the box was painted either before the text, where it holds the whole box
// inside its stroke's inner edge (a frame) or crosses the box's edge (reported), or after
// it (reported as covering it). The text's backdrop is the page plus its frames
// composited in document order; a crossing fill painted under an opaque frame is hidden
// by it and not reported.
//
// It also checks that no text runs into what is drawn next to it: any other paint that
// meets the box collides with it, whichever side of the text it was painted on. That is
// a stroke (a line's, polyline's or path's segments widened by half the stroke, a rect's
// or circle's ring), the fill of a rect stripe of 3px or less (every other fill is judged
// by the paint model above), and another text's box painted after it; and the box may
// not leave the canvas. Strokes and fills are read from shapeOf(), so a box inside a
// shape's inner edge (its frame, a hollow ring's hole) or in a rounded shape's bare corner
// is clear. GRID-coloured hairlines (line, polyline, path; stroke-width 1 or less) are
// exempt, as in the mark check. The chart kit (_chartstyle.mjs) lays text out with the
// same estimate, which throws on a glyph it has no width for.

import { glyphCells } from "./_text-width.mjs";

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
      // the selected value must be a colour: a rule on a none value would give the dark
      // theme a paint the light theme does not have, which the checks never look at
      if (!m || !COLOR.test(m[3])) unsupported(`dark rule selector "${sel.trim()}"`);
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

// ---- shape geometry: the one model of where an element paints ----
// Boxes are [x0, y0, x1, y1]. A region is a set of points with two tests: contains(b) (the
// closed box lies inside it) and meets(b) (it shares interior with the box; touching edges
// do not meet).
const meets = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const grow = (b, d) => [b[0] - d, b[1] - d, b[2] + d, b[3] + d];
const corners = (b) => [
  [b[0], b[1]],
  [b[2], b[1]],
  [b[0], b[3]],
  [b[2], b[3]],
];
const EMPTY = { contains: () => false, meets: () => false };
// a rect [x0, y0, x1, y1] with elliptical corners of radii rx, ry (0 for square corners)
const roundRect = (r, rx, ry) => {
  if (!(r[2] > r[0] && r[3] > r[1])) return EMPTY;
  const round = rx > 0 && ry > 0;
  const inside = ([x, y]) => {
    if (!(x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3])) return false;
    if (!round) return true;
    // the nearest corner's ellipse centre, when the point is in that corner's square
    const cx = x < r[0] + rx ? r[0] + rx : x > r[2] - rx ? r[2] - rx : null;
    const cy = y < r[1] + ry ? r[1] + ry : y > r[3] - ry ? r[3] - ry : null;
    return cx === null || cy === null || ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  };
  return {
    // the region is convex: it holds a box when it holds the box's corners
    contains: (b) => corners(b).every(inside),
    meets: (b) => {
      if (!meets(r, b)) return false;
      if (!round) return true;
      // scale y by rx/ry so the corners are circles of radius rx: the region is then the
      // core rect grown by rx, and a box meets it when it is nearer than rx to the core
      const k = rx / ry;
      const core = [r[0] + rx, r[1] * k + rx, r[2] - rx, r[3] * k - rx];
      const dx = Math.max(0, core[0] - b[2], b[0] - core[2]);
      const dy = Math.max(0, core[1] - b[3] * k, b[1] * k - core[3]);
      return Math.hypot(dx, dy) < rx;
    },
  };
};
const disk = (cx, cy, r) =>
  r > 0
    ? {
        contains: (b) => corners(b).every(([x, y]) => Math.hypot(x - cx, y - cy) <= r),
        meets: (b) =>
          Math.hypot(
            cx - Math.max(b[0], Math.min(cx, b[2])),
            cy - Math.max(b[1], Math.min(cy, b[3])),
          ) < r,
      }
    : EMPTY;
// does the segment p-q pass through the open box b (Liang-Barsky against b shrunk by a
// hair, so a segment along an edge does not count)?
const segMeets = ([px, py], [qx, qy], box) => {
  const b = grow(box, -1e-9);
  let t0 = 0;
  let t1 = 1;
  const dx = qx - px;
  const dy = qy - py;
  for (const [p, q] of [
    [-dx, px - b[0]],
    [dx, b[2] - px],
    [-dy, py - b[1]],
    [dy, b[3] - py],
  ]) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  return true;
};
// the closed edges of each subpath (a fill closes every subpath)
const ringEdges = (polys) =>
  polys.flatMap((pts) => pts.map((p, i) => [p, pts[(i + 1) % pts.length]]));
// the region a path fills: its subpaths, each closed, under SVG's default nonzero rule
const polygons = (polys) => {
  const edges = ringEdges(polys.filter((p) => p.length > 2));
  if (!edges.length) return EMPTY;
  const inside = ([x, y]) => {
    let wind = 0;
    for (const [[x0, y0], [x1, y1]] of edges) {
      const side = (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0);
      if (y0 <= y && y1 > y && side > 0) wind++;
      else if (y0 > y && y1 <= y && side < 0) wind--;
    }
    return wind !== 0;
  };
  const crosses = (b) => edges.some(([p, q]) => segMeets(p, q, b));
  return {
    // inside where no edge enters the box and its corners are inside
    contains: (b) => !crosses(b) && corners(b).every(inside),
    meets: (b) => crosses(b) || inside([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]),
  };
};
const painted = (v) => Boolean(v) && v !== "none";
// The geometry primitive: shapeOf(e) for every painted element, in canvas coordinates
// (through place()). Every check that asks where an element paints asks it here.
//   bounds          its geometry's bounding box, stroke excluded
//   extent          its bounding box grown by half its stroke width when a stroke is set
//   hasFill         it paints a fill (a rect, circle or path with a fill other than none)
//   fillContains(b) its fill holds box b (a rounded rect less its corners, a disk, a path's
//                   subpaths filled nonzero)
//   fillMeets(b)    its fill shares interior with box b
//   fillCoversCanvas(W, H)  its fill holds the whole canvas
//   holds(b)        b lies inside its area within the inner edge of its stroke (inset by
//                   half the stroke width when a stroke is set), filled or not: a frame
//   strokeMeets(b)  its stroke's painted outline (a rect's or circle's ring, a line's,
//                   polyline's or path's segments widened by half the stroke) meets box b
// A rect's corner radius is rx clamped to half its width and, as ry (which follows rx),
// to half its height. Lines and polylines have no area: they hold nothing.
export const shapeOf = (e) => {
  const sw = painted(e.a.stroke) ? +(e.a["stroke-width"] ?? 1) : 0;
  const hw = sw / 2;
  let area = null; // the geometry's own region
  let inner = null; // the region inside the stroke's inner edge
  let outer = null; // the region inside the stroke's outer edge
  let lines = null; // the segments a stroke follows, for lines, polylines and paths
  let bounds;
  if (e.tag === "rect") {
    const [x, y] = place(e, +e.a.x || 0, +e.a.y || 0);
    const w = +e.a.width;
    const h = +e.a.height;
    const r = Math.max(0, +e.a.rx || 0);
    const rx = Math.min(r, w / 2);
    const ry = Math.min(r, h / 2);
    bounds = [x, y, x + w, y + h];
    area = roundRect(bounds, rx, ry);
    inner = roundRect(grow(bounds, -hw), Math.max(0, rx - hw), Math.max(0, ry - hw));
    outer = roundRect(grow(bounds, hw), rx > 0 ? rx + hw : 0, ry > 0 ? ry + hw : 0);
  } else if (e.tag === "circle") {
    const [cx, cy] = place(e, +e.a.cx, +e.a.cy);
    const r = +e.a.r;
    bounds = [cx - r, cy - r, cx + r, cy + r];
    area = disk(cx, cy, r);
    inner = disk(cx, cy, r - hw);
    outer = disk(cx, cy, r + hw);
  } else {
    let polys;
    if (e.tag === "line")
      polys = [
        [
          [+e.a.x1, +e.a.y1],
          [+e.a.x2, +e.a.y2],
        ],
      ];
    else if (e.tag === "polyline")
      polys = [e.a.points.split(" ").map((p) => p.split(",").map(Number))];
    else
      polys = e.a.d
        .split("M")
        .filter(Boolean)
        .map((sub) =>
          [...sub.matchAll(new RegExp(`(${NUM_SRC}) (${NUM_SRC})`, "g"))].map((m) => [
            +m[1],
            +m[2],
          ]),
        );
    polys = polys.map((pts) => pts.map(([x, y]) => place(e, x, y)));
    const xs = polys.flat().map((p) => p[0]);
    const ys = polys.flat().map((p) => p[1]);
    bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    // only a filled path has an area; a stroked one is its segments
    if (e.tag === "path" && painted(e.a.fill)) {
      area = polygons(polys);
      // conservatively, inside the inner edge where the box grown by hw is inside the fill
      inner = { contains: (b) => area.contains(grow(b, hw)), meets: () => false };
    }
    const closed =
      e.tag === "path"
        ? e.a.d
            .split("M")
            .filter(Boolean)
            .map((sub) => /z$/.test(sub))
        : [];
    lines = polys.flatMap((pts, i) => {
      const segs = pts.slice(1).map((q, j) => [pts[j], q]);
      if (closed[i] && pts.length > 2) segs.push([pts[pts.length - 1], pts[0]]);
      return segs;
    });
  }
  const hasFill = ["rect", "circle", "path"].includes(e.tag) && painted(e.a.fill);
  const fill = hasFill ? area : EMPTY;
  return {
    e,
    tag: e.tag,
    bounds,
    extent: grow(bounds, hw),
    hasFill,
    fillContains: (b) => fill.contains(b),
    fillMeets: (b) => fill.meets(b),
    fillCoversCanvas: (W, H) => fill.contains([0, 0, W, H]),
    holds: (b) => Boolean(inner) && inner.contains(b),
    strokeMeets: (b) => {
      if (!(sw > 0)) return false;
      if (lines) return lines.some(([p, q]) => segMeets(p, q, grow(b, hw)));
      return outer.meets(b) && !inner.contains(b);
    },
  };
};

// The page: the first painted element, when its fill covers the whole W x H canvas (after
// place()) and is opaque in both themes (a rect with rounded corners leaves the canvas's
// corners bare, so it is not the page). Without one the reader's own surface shows
// through (a transparent SVG with dark text is unreadable on GitHub dark), which is an
// issue. A canvas-covering fill painted after any text or mark is ordinary paint: it
// covers what is under it.
const pageRect = (els, texts, W, H, rules) => {
  const e = [els[0], texts[0]].filter(Boolean).sort((p, q) => p.ord - q.ord)[0];
  if (!e || e.tag === "text") return undefined;
  const full =
    shapeOf(e).fillCoversCanvas(W, H) &&
    ["light", "dark"].every((t) => paint(e, "fill", t, rules)?.a === 1);
  return full ? e : undefined;
};

// a text's inked box [x0, y0, x1, y1] (spaces at either end carry no ink); null if none
const textBox = (t) => {
  const size = +(t.a["font-size"] || 16);
  const { width, cells } = glyphCells(t.text, size, t.a["font-weight"] || "");
  const share = { start: 0, middle: 0.5, end: 1 }[t.a["text-anchor"] || "start"];
  const [x, y] = place(t, +t.a.x, +t.a.y);
  const x0 = x - width * share;
  const inked = cells.filter((c) => c.ink);
  if (!inked.length) return null;
  return [
    x0 + Math.min(...inked.map((c) => c.x0)),
    y - Math.max(...inked.map((c) => c.up)),
    x0 + Math.max(...inked.map((c) => c.x1)),
    y + Math.max(...inked.map((c) => c.down)),
  ];
};
const GRID = "#e4e8ec";
// a gridline or rule: a GRID-coloured line, path or polyline stroke no wider than 1px.
// It is decoration, exempt from the mark check and the overlap check; a wider stroke in
// the GRID colour is a mark like any other.
const isHairline = (e) =>
  ["line", "path", "polyline"].includes(e.tag) &&
  (e.a.stroke || "").toLowerCase() === GRID &&
  +(e.a["stroke-width"] || 1) <= 1;
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
  // each theme's page colour is the page's fill in that theme; without a page the rest of
  // the audit runs against white in both themes
  const bgRect = pageRect(els, texts, W, H, rules);
  if (bgRect && bgRect.a.stroke && bgRect.a.stroke !== "none")
    unsupported(`stroke on the background rect (stroke="${bgRect.a.stroke}")`);
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
  // every element's geometry, from the one primitive
  const shapes = new Map(els.map((e) => [e, shapeOf(e)]));
  const S = (e) => shapes.get(e);
  // a stripe: 3px or less across in either direction
  const stripe = (e) => {
    const b = S(e).bounds;
    return b[2] - b[0] <= 3 || b[3] - b[1] <= 3;
  };
  // every fill painted over the page, in paint order; stripes are never a backdrop nor a
  // crossing
  const fills = els.filter((e) => e !== bgRect && S(e).hasFill);
  const backdrops = fills.filter((e) => !stripe(e));
  const opaque = (e) => ["light", "dark"].every((th) => paint(e, "fill", th, rules)?.a === 1);
  // The paint-order model, the one place backdrops, crossings and covers are decided, over
  // a text's glyph box b. Of the fills meeting b: painted before the text, those holding b
  // inside their stroke's inner edge are its frames (its backdrop stack, bottom first) and
  // the rest cross its edge, unless an opaque frame painted after them hides them; painted
  // after the text, they cover it.
  const paintAround = (t, b) => {
    const meeting = backdrops.filter((e) => S(e).fillMeets(b));
    const before = meeting.filter((e) => e.ord < t.ord);
    const frames = before.filter((e) => S(e).holds(b));
    const floor = frames.filter(opaque).pop();
    return {
      frames,
      crossing: before.filter((e) => !S(e).holds(b) && !(floor && e.ord < floor.ord)),
      above: meeting.filter((e) => e.ord > t.ord),
    };
  };
  // a visible border: a stroke of width above 0 whose colour has alpha above 0 in a theme
  const bordered = (e) =>
    +(e.a["stroke-width"] ?? 1) > 0 &&
    ["light", "dark"].some((th) => (paint(e, "stroke", th, rules)?.a ?? 0) > 0);
  const boxes = new Map(texts.map((t) => [t, textBox(t)]));
  for (const t of texts) {
    const size = +(t.a["font-size"] || 16);
    if (size < minText) out.push(`"${t.s}" is ${size}px (floor ${minText}px)`);
    const b = boxes.get(t);
    if (!b) continue;
    const { frames, crossing, above } = paintAround(t, b);
    for (const e of crossing)
      out.push(`"${t.s}" crosses the edge of the ${e.tag} painted under it (fill ${e.a.fill})`);
    for (const e of above)
      out.push(`"${t.s}" is covered by a ${e.tag} drawn after it (fill ${e.a.fill})`);
    // a figure box is a bordered rect: the text is inside one when any rect painted under
    // it, filled or outline-only, holds its glyph box inside its stroke's inner edge and has
    // a visible border, whatever its size (a 20px package chip is a box); an unbordered
    // tint (a heat cell) is not
    const isBox = els.some(
      (e) => e.tag === "rect" && e !== bgRect && e.ord < t.ord && bordered(e) && S(e).holds(b),
    );
    if (isBox && size < minBoxText)
      out.push(`"${t.s}" is ${size}px inside a figure box (floor ${minBoxText}px)`);
    for (const theme of ["light", "dark"]) {
      const ink = paint(t, "fill", theme, rules) || {
        rgb: theme === "light" ? [0, 0, 0] : [0, 0, 0],
        a: 1,
      };
      // the page, then every frame in paint order
      let bg = page[theme];
      for (const e of frames) {
        const f = paint(e, "fill", theme, rules);
        if (f) bg = over(f, bg);
      }
      const c = contrast(over(ink, bg), bg);
      if (c < 4.5) out.push(`${theme}: "${t.s}" ${t.a.fill} at ${c.toFixed(2)}:1 (needs 4.5:1)`);
    }
  }
  // Non-text marks, each held to 3:1 as drawn: series lines, arrows and edges (lines,
  // polylines, paths and arrowheads), dots (filled or hollow), and every rect, circle or
  // filled path that does not frame text. A shape frames text if it holds a rendered
  // text's glyph box inside its stroke's inner edge (heat cells, figure boxes, a badge) or,
  // for a rect, sits beside its label (a legend swatch); one with neither is a mark (a
  // bar, a dot, an arrowhead) and its fill and stroke are judged.
  // A mark is judged over its extent (its bounding box, stroke included): its backdrop is
  // the page plus every fill painted before it that holds the extent inside its stroke's
  // inner edge, composited in document order, and every fill painted after it that holds
  // the extent is composited over both the mark and its backdrop. An opaque one hides it,
  // which is reported.
  // Stripes of 3px or less and GRID hairlines (width 1 or less) are not marks. A channel (fill or stroke)
  // coloured like its backdrop is not a mark only when the element's other channel is
  // painted (a colour of alpha above 0; a stroke also of width above 0) and itself passes
  // as a mark: the page-coloured halo around a filled dot, the page-coloured centre of a
  // hollow ring. A page-coloured series line, edge, ring or outline with nothing else
  // painted is reported.
  const framesText = (e) => [...boxes.values()].some((b) => b && S(e).holds(b));
  // A labeled swatch (a legend key): a rect of at most 32x20 whose meaning is carried by
  // the inked text that starts within 12px to its right with its baseline inside the rect's
  // vertical extent (+-4px). The information is the adjacent text, not the tint (WCAG 1.4.11).
  const labelsSwatch = (e) => {
    const [x0, y0, x1, y1] = S(e).bounds;
    return (
      e.tag === "rect" &&
      x1 - x0 <= 32 &&
      y1 - y0 <= 20 &&
      texts.some((t) => {
        if (!boxes.get(t)) return false;
        const [x, y] = place(t, +t.a.x, +t.a.y);
        const gap = x - x1;
        return (
          (t.a["text-anchor"] || "start") === "start" &&
          gap >= 0 &&
          gap <= 12 &&
          y >= y0 - 4 &&
          y <= y1 + 4
        );
      })
    );
  };
  // channel `attr` of mark e as drawn in a theme: its paint c0, its backdrop bg, then the
  // mark (ink) and its backdrop (back) under every fill painted after it that holds its
  // extent; hiddenBy is the first opaque one
  const drawn = (e, attr, theme) => {
    const ext = S(e).extent;
    let bg = page[theme];
    for (const r of backdrops)
      if (r !== e && r.ord < e.ord && S(r).holds(ext)) {
        const f = paint(r, "fill", theme, rules);
        if (f) bg = over(f, bg);
      }
    const c0 = paint(e, attr, theme, rules);
    let ink = c0 ? over(c0, bg) : bg;
    let back = bg;
    let hiddenBy = null;
    for (const s of fills)
      if (s.ord > e.ord && S(s).fillContains(ext)) {
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
    if (!raw || raw === "none" || (attr === "stroke" && isHairline(e))) return;
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
  // ---- overlap: a text's box against every element drawn after it ----
  // paint exists if it is painted in the light theme: no dark rule can make a light paint
  // of alpha 0 visible, since that paint is an rgba() value and a dark selector on an rgba()
  // value is unsupported (chartstyle-selftest pins it)
  const painted = (e, attr) => {
    const raw = e.a[attr];
    if (!raw || raw === "none") return false;
    const c = paint(e, attr, "light", rules);
    return Boolean(c && c.a > 0);
  };
  // does element e paint inside box b? Both channels are read from the shape primitive: its
  // fill where the fill paints, its stroke where the stroke's ring or widened segments
  // paint (so a box inside a hollow shape's hole or a rounded shape's bare corner is
  // clear). With `strokeOnly`, only its stroke counts: a fill paintAround() judges is left
  // to it.
  const hits = (e, b, strokeOnly = false) => {
    if (!strokeOnly && painted(e, "fill") && S(e).fillMeets(b)) return "fill";
    if (painted(e, "stroke") && !isHairline(e) && S(e).strokeMeets(b)) return "stroke";
    return null;
  };
  const f1 = (n) => +n.toFixed(1);
  for (const t of texts) {
    const tb = boxes.get(t);
    if (!tb) continue;
    const where = `"${t.s}" (box ${tb.map(f1).join(",")})`;
    if (tb[0] < 0 || tb[2] > W || tb[1] < 0 || tb[3] > H)
      out.push(`${where} runs off the ${W}x${H} canvas`);
    for (const e of els) {
      if (e === bgRect) continue;
      const after = e.ord > t.ord;
      // a fill paintAround() judges (any fill but a stripe) is left to it: painted after the
      // text over its box it covers it (reported once there), painted before it is a frame
      // or a crossing; otherwise only its stroke is judged here
      const judged = backdrops.includes(e);
      if (after && judged && S(e).fillMeets(tb)) continue;
      // any other paint over the box, painted before or after the text, collides with it:
      // a stroke runs through its glyphs, a fill (a stripe) is not its backdrop. A shape
      // that holds the box inside its stroke's inner edge (its frame, or an outline drawn
      // after it) does not collide: its ring misses the box
      const how = hits(e, tb, judged);
      if (how)
        out.push(`${where} overlaps the ${e.tag} ${how} drawn ${after ? "after" : "before"} it`);
    }
    for (const o of texts) {
      if (o.ord < t.ord) continue;
      const ob = boxes.get(o);
      if (o !== t && ob && meets(ob, tb))
        out.push(`${where} overlaps the text "${o.s}" (box ${ob.map(f1).join(",")})`);
    }
  }

  for (const e of els) {
    if (e === bgRect) continue;
    const attrsToCheck = [];
    if (e.tag === "polyline" || e.tag === "line") attrsToCheck.push("stroke");
    else if (["rect", "circle", "path"].includes(e.tag)) {
      // a rect stripe is not a mark; a shape framing text is that text's backdrop
      if ((e.tag === "rect" && stripe(e)) || framesText(e) || labelsSwatch(e)) continue;
      attrsToCheck.push("fill", "stroke");
    } else continue;
    for (const attr of attrsToCheck) for (const theme of ["light", "dark"]) check(e, attr, theme);
  }
  return out;
}
