// Static legibility audit of a rendered chart SVG, in both themes: every text's size,
// every text's contrast against what is drawn behind it, and every non-text mark's
// contrast against the page. The dark theme is the SVG's own
// `@media (prefers-color-scheme: dark)` rules applied to the elements they select,
// so the audit checks what a GitHub dark-mode reader sees. Used by
// scripts/chartstyle-selftest.mjs over every committed bench/charts/*.svg.

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

const attrs = (tag) => {
  const o = {};
  for (const m of tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) o[m[1]] = m[2];
  return o;
};

// the dark rules: tag[attr="value"] → { prop: value }
const darkRules = (svg) => {
  const block = /@media \(prefers-color-scheme: dark\)\{([\s\S]*?)\}<\/style>/.exec(svg);
  const rules = new Map();
  if (!block) return rules;
  for (const m of block[1].matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const props = {};
    for (const p of m[2].split(";")) {
      const [k, v] = p.split(":").map((x) => x && x.trim());
      if (k && v) props[k] = v;
    }
    for (const sel of m[1].split(",")) {
      const s = /^\s*([a-z]+)\[([a-z-]+)="([^"]+)"\]\s*$/.exec(sel);
      if (s)
        rules.set(`${s[1]}|${s[2]}|${s[3]}`, {
          ...(rules.get(`${s[1]}|${s[2]}|${s[3]}`) || {}),
          ...props,
        });
    }
  }
  return rules;
};

// effective paint of `attr` (fill/stroke) on an element in a theme, with its alpha folded
// from the colour, the element's `<attr>-opacity`, its own `opacity`, and every ancestor
// group's `opacity`. The dark rules' `<attr>-opacity` replaces the attribute, as in CSS.
const paint = (el, attr, theme, rules) => {
  const raw = el.a[attr];
  if (!raw) return null;
  let c = parseColor(raw);
  let op = el.a[`${attr}-opacity`];
  if (theme === "dark") {
    const r = rules.get(`${el.tag}|${attr}|${raw}`);
    if (r && r[attr]) c = parseColor(r[attr]);
    if (r && r[`${attr}-opacity`]) op = r[`${attr}-opacity`];
  }
  if (!c) return null;
  const a = c.a * (op === undefined ? 1 : +op) * (el.opacity ?? 1);
  return { ...c, a: Math.min(1, Math.max(0, a)) };
};

const GRID = "#e4e8ec";
const sameRgb = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 0.5);

export function auditSvg(svg, { minText, minBoxText }) {
  const W = +/<svg[^>]*width="([\d.]+)"/.exec(svg)[1];
  const els = [];
  const texts = [];
  // walk the tags in order so each mark carries the product of its ancestors' opacity
  const groups = [];
  for (const m of svg.matchAll(/<(\/?)(g|rect|circle|polyline|line|path|text)\b([^>]*?)(\/?)>/g)) {
    const [, closing, tag, body, selfClose] = m;
    if (tag === "g") {
      if (closing) groups.pop();
      else if (!selfClose) {
        const o = attrs(body).opacity;
        groups.push(o === undefined ? 1 : +o);
      }
      continue;
    }
    if (closing || tag === "text") continue;
    const a = attrs(body);
    const own = a.opacity === undefined ? 1 : +a.opacity;
    els.push({ tag, a, opacity: groups.reduce((p, o) => p * o, own) });
  }
  for (const m of svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g))
    texts.push({ tag: "text", a: attrs(m[1]), s: m[2] });
  const rules = darkRules(svg);
  const page = { light: [255, 255, 255], dark: null };
  const bgRect = els.find((e) => e.tag === "rect" && !e.a.x && +e.a.width === W);
  page.dark = (paint(bgRect, "fill", "dark", rules) || { rgb: [255, 255, 255] }).rgb;
  const geom = (e) => ({ e, x: +e.a.x || 0, y: +e.a.y || 0, w: +e.a.width, h: +e.a.height });
  const rects = els
    .filter((e) => e.tag === "rect" && e !== bgRect && e.a.fill && e.a.fill !== "none")
    .map(geom)
    .filter((r) => r.w > 3 && r.h > 3);
  // a text's anchor point (x, mid-height of the glyphs)
  const anchor = (t) => ({ x: +t.a.x, y: +t.a.y - +(t.a["font-size"] || 16) * 0.35 });
  const out = [];
  for (const t of texts) {
    const x = +t.a.x;
    const y = +t.a.y;
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
  // lines and dots, gridless rules, and every rect that is not a text-framing box. A rect
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
      const gap = +t.a.x - (r.x + r.w);
      const y = +t.a.y;
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
    if (!raw || raw === "none" || (attr === "stroke" && raw === GRID)) return;
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
    if (e.tag === "circle") attrsToCheck.push(e.a.fill && e.a.fill !== "none" ? "fill" : "stroke");
    else if (e.tag === "polyline" || e.tag === "line") attrsToCheck.push("stroke");
    else if (e.tag === "rect") {
      const r = geom(e);
      if (r.w <= 3 || r.h <= 3 || framesText(r) || labelsSwatch(r)) continue;
      attrsToCheck.push("fill", "stroke");
    } else continue;
    for (const attr of attrsToCheck) for (const theme of ["light", "dark"]) check(e, attr, theme);
  }
  return out;
}
