#!/usr/bin/env node
// Generates "vizdash": a data-visualization App Router app of the shape reported in
// vercel/next.js#98043 (a shared viz library and many dashboards). Unlike
// monolith-gen.mjs, the code is hand-written: vizdash/template/ holds the app shell,
// the seeded query engine (src/data) and the viz library (src/viz) on recharts, visx,
// d3, ECharts, TanStack Table, date-fns, lodash-es and zod; vizdash/catalog.mjs holds
// nine product areas with their metrics, dimensions and seven dashboard archetypes
// each. This script copies the template and instantiates the archetypes once per
// scope (e.g. "Pipeline · EMEA · Enterprise"), writing each dashboard as its own
// feature folder plus its routes.
//
//   node scripts/vizdash-gen.mjs --out /tmp/vizdash --clean
//   node scripts/vizdash-gen.mjs --out /tmp/vizdash-quick --dashboards 228 --clean
//
// Defaults: 1,430 dashboards; 2,069 routes (1,706 pages: dashboards, drill-downs, area
// and archetype indexes, search, the overview; 363 CSV/JSON export route handlers) over
// 16,525 TypeScript files. --dashboards 228 gives 401 routes.
//
// Per dashboard, src/dashboards/<area>/<archetype>/<scope>/:
//   spec.ts       title, scope, owner, default range
//   queries.ts    the loader: one engine query per widget, cached per request
//   insights.ts   generated observations over the loaded data
//   Kpis.tsx      KPI grid, and a Summary other dashboards embed
//   Charts.tsx    the widget grid
//   columns.tsx   'use client' TanStack column definitions
//   Table.tsx     'use client' table over the loaded rows
//   Filters.tsx   'use client' URL-driven filter bar
//   Dashboard.tsx the page body
//   index.ts      the folder's public entry
// and app/<area>/<archetype>/<scope>/page.tsx, optionally [entityId]/page.tsx (a
// drill-down) and export/route.ts (CSV/JSON of the table).
//
// Deterministic for a given seed. The app is standalone; install it with
// `pnpm install --ignore-workspace --frozen-lockfile` (the generator copies
// vizdash/pnpm-lock.yaml, which matches PINS below).

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AREAS, REFRESH } from "../vizdash/catalog.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  if (!argv[i + 1] || argv[i + 1].startsWith("--")) {
    console.error(`--${name} needs a value`);
    process.exit(1);
  }
  return argv[i + 1];
};
const intOpt = (name, def, min, max = Infinity) => {
  const raw = opt(name, String(def));
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    console.error(`--${name} must be an integer in [${min}, ${max}] (got "${raw}")`);
    process.exit(1);
  }
  return n;
};

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(REPO, "vizdash", "template");
const LOCKFILE = join(REPO, "vizdash", "pnpm-lock.yaml");
const OUT = resolve(opt("out", "vizdash-app"));
// written into monolith.json (the summary the gym reads); --clean deletes only a tree
// carrying it
const GENERATOR = "node-monorepo-perf scripts/vizdash-gen.mjs";
const DASHBOARDS = intOpt("dashboards", 1430, 1);
const DRILL_PCT = intOpt("drilldown-pct", 14, 0, 100);
const EXPORT_PCT = intOpt("export-pct", 26, 0, 100);
const RELATED_PCT = intOpt("related-pct", 20, 0, 100);
const SEED = intOpt("seed", 98043, 0);
const NEXT_VERSION = opt("next", "16.4.0");
const REACT_VERSION = "19.2.7";

// Exact versions of everything the app imports. The committed lockfile resolves these;
// change both together.
const PINS = {
  dependencies: {
    next: NEXT_VERSION,
    react: REACT_VERSION,
    "react-dom": REACT_VERSION,
    "react-is": REACT_VERSION,
    "@tanstack/react-table": "8.21.3",
    "@visx/axis": "4.0.0",
    "@visx/curve": "4.0.0",
    "@visx/event": "4.0.0",
    "@visx/glyph": "4.0.0",
    "@visx/gradient": "4.0.0",
    "@visx/grid": "4.0.0",
    "@visx/group": "4.0.0",
    "@visx/heatmap": "4.0.0",
    "@visx/hierarchy": "4.0.0",
    "@visx/legend": "4.0.0",
    "@visx/responsive": "4.0.0",
    "@visx/sankey": "4.0.0",
    "@visx/scale": "4.0.0",
    "@visx/shape": "4.0.0",
    "@visx/stats": "4.0.0",
    "@visx/text": "4.0.0",
    "@visx/tooltip": "4.0.0",
    clsx: "2.1.1",
    "d3-array": "3.2.4",
    "d3-color": "3.1.0",
    "d3-format": "3.1.2",
    "d3-interpolate": "3.0.1",
    "d3-scale": "4.0.2",
    "d3-scale-chromatic": "3.1.0",
    "d3-time-format": "4.1.0",
    "date-fns": "4.1.0",
    echarts: "5.6.0",
    "lodash-es": "4.17.21",
    "lucide-react": "1.47.0",
    recharts: "3.10.1",
    zod: "4.6.5",
  },
  devDependencies: {
    "@types/d3-array": "3.2.2",
    "@types/d3-color": "3.1.3",
    "@types/d3-format": "3.0.4",
    "@types/d3-interpolate": "3.0.4",
    "@types/d3-scale": "4.0.9",
    "@types/d3-scale-chromatic": "3.1.0",
    "@types/d3-time-format": "4.0.3",
    "@types/lodash-es": "4.17.12",
    "@types/node": "25.9.9",
    "@types/react": "19.2.17",
    "@types/react-dom": "19.2.7",
    typescript: "6.0.3",
  },
};

if (existsSync(OUT)) {
  if (!flag("clean")) {
    console.error(`${OUT} exists; pass --clean to replace it`);
    process.exit(1);
  }
  const isGenerated = () => {
    try {
      return JSON.parse(readFileSync(join(OUT, "monolith.json"), "utf8")).generator === GENERATOR;
    } catch {
      return false;
    }
  };
  if (readdirSync(OUT).length && !isGenerated()) {
    console.error(
      `${OUT} is not a vizdash tree (no monolith.json with this generator's signature); refusing to delete it`,
    );
    process.exit(1);
  }
  rmSync(OUT, { recursive: true, force: true });
}

// ---- deterministic randomness (mulberry32 over an FNV-1a hash of the parts) ----------
const hash = (s) => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
};
function rng(...parts) {
  let a = hash([SEED, ...parts].join("␟"));
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (pct) => next() * 100 < pct,
    pick: (xs) => xs[Math.floor(next() * xs.length)],
    shuffle: (xs) => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}

// ---- output ------------------------------------------------------------------------
let files = 0;
let tsFiles = 0;
const tsByPart = { template: 0, areas: 0, dashboards: 0, routes: 0 };
function emit(rel, text, part = "routes") {
  const p = join(OUT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  files++;
  if (/\.tsx?$/.test(rel)) {
    tsFiles++;
    tsByPart[part]++;
  }
}

function copyTemplate(dir = TEMPLATE) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const src = join(dir, e.name);
    if (e.isDirectory()) copyTemplate(src);
    else emit(relative(TEMPLATE, src), readFileSync(src), "template");
  }
}

// ---- naming helpers -------------------------------------------------------------------
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\+/g, "-plus")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const ident = (s) => s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^(\d)/, "_$1");
const camel = (s) => {
  const words = s
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const out = words
    .map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()))
    .join("");
  return /^\d/.test(out) ? `w${out}` : out;
};
const pascal = (s) => {
  const c = camel(s);
  return c[0].toUpperCase() + c.slice(1);
};
const str = (s) => JSON.stringify(s);
const lc = (s) => (/^[A-Z]{2,}|^[A-Z][a-z]*[A-Z]/.test(s) ? s : s.toLowerCase());

// ---- catalog checks -------------------------------------------------------------------
const BUILTIN = new Set(["weekday", "hour", "month"]);
for (const area of AREAS) {
  const metricKeys = new Set(area.metrics.map((m) => m.key));
  const dimKeys = new Set([...Object.keys(area.dimensions), ...BUILTIN]);
  const need = (cond, what) => {
    if (!cond) throw new Error(`catalog: ${area.key}: ${what}`);
  };
  for (const k of area.headline) need(metricKeys.has(k), `headline metric ${k}`);
  for (const a of area.scopeAxes) need(area.dimensions[a], `scope axis ${a}`);
  for (const [param, d] of Object.entries(area.filters))
    need(area.dimensions[d], `filter ${param}=${d}`);
  for (const arch of area.archetypes) {
    const where = `${arch.key}`;
    for (const k of arch.kpis) need(metricKeys.has(k), `${where} kpi ${k}`);
    need(area.entities[arch.table.entity], `${where} table entity ${arch.table.entity}`);
    for (const k of arch.table.metrics) need(metricKeys.has(k), `${where} table metric ${k}`);
    for (const w of [...arch.widgets, ...arch.optional]) {
      for (const k of ["metric", "x", "y", "size", "bar", "line"])
        if (w[k]) need(metricKeys.has(w[k]), `${where} ${w.kind}.${k} ${w[k]}`);
      if (w.target && typeof w.target === "string")
        need(metricKeys.has(w.target), `${where} target ${w.target}`);
      for (const k of w.metrics ?? []) need(metricKeys.has(k), `${where} ${w.kind} metric ${k}`);
      for (const k of ["by", "rows", "cols", "outer", "inner"])
        if (w[k]) need(dimKeys.has(w[k]), `${where} ${w.kind}.${k} ${w[k]}`);
      for (const k of w.stages ?? []) need(dimKeys.has(k), `${where} sankey stage ${k}`);
    }
  }
}

// ---- dashboards: expand archetypes over scopes ---------------------------------------
const archetypes = AREAS.flatMap((area) => area.archetypes.map((arch) => ({ area, arch })));
const perArch = archetypes.map(
  (_, i) =>
    Math.floor(DASHBOARDS / archetypes.length) + (i < DASHBOARDS % archetypes.length ? 1 : 0),
);

function scopesFor(area, arch, n) {
  // two scope axes when they give enough combinations, three otherwise
  for (let axes = 2; axes <= area.scopeAxes.length; axes++) {
    const keys = area.scopeAxes.slice(0, axes);
    let combos = [{}];
    for (const k of keys)
      combos = combos.flatMap((c) => area.dimensions[k].values.map((v) => ({ ...c, [k]: v })));
    if (combos.length >= n) return rng("scopes", area.key, arch.key).shuffle(combos).slice(0, n);
  }
  throw new Error(
    `${area.key}/${arch.key}: ${n} dashboards need more scope combinations than ${area.scopeAxes.join(" x ")} gives`,
  );
}

const dashboards = [];
archetypes.forEach(({ area, arch }, ai) => {
  for (const scope of scopesFor(area, arch, perArch[ai])) {
    const scopeSlug = Object.values(scope).map(slug).join("-");
    dashboards.push({
      area,
      arch,
      scope,
      scopeSlug,
      id: `${area.key}-${arch.key}-${scopeSlug}`,
      href: `/${area.key}/${arch.key}/${scopeSlug}`,
      dir: `src/dashboards/${area.key}/${arch.key}/${scopeSlug}`,
      importPath: `@/dashboards/${area.key}/${arch.key}/${scopeSlug}`,
      title: `${arch.label} · ${Object.values(scope).join(" · ")}`,
    });
  }
});

// ---- widgets ------------------------------------------------------------------------
const metricOf = (area, key) => area.metrics.find((m) => m.key === key);
const dimLabel = (area, key) =>
  BUILTIN.has(key)
    ? { weekday: "Weekday", hour: "Hour", month: "Month" }[key]
    : area.dimensions[key].label;
const widgetDims = (w) =>
  [w.by, w.rows, w.cols, w.outer, w.inner, ...(w.stages ?? [])].filter((k) => k !== undefined);
const FULL = new Set(["sankey", "cohort", "calendar"]);
const baseSpan = (area, w) => {
  if (FULL.has(w.kind)) return 12;
  if (w.kind === "heatmap") {
    const cols = BUILTIN.has(w.cols)
      ? { weekday: 7, hour: 24, month: 12 }[w.cols]
      : area.dimensions[w.cols].values.length;
    return cols > 8 ? 12 : 6;
  }
  if (w.kind === "gauge") return 4;
  return 6;
};

// Spans on the 12-column grid: widgets fill rows in order; the last widget of a row
// that the next one does not fit in widens to close the row.
function pack(spans) {
  const out = [...spans];
  let used = 0;
  let rowLast = -1;
  for (let i = 0; i < out.length; i++) {
    if (used + out[i] > 12) {
      out[rowLast] += 12 - used;
      used = 0;
    }
    used += out[i];
    rowLast = i;
  }
  if (rowLast >= 0) out[rowLast] += 12 - used;
  return out;
}

// For one widget: the loader expression, the JSX, the viz components it needs and the
// insight expressions over its data.
function emitWidget(d, w, key, span, r) {
  const { area } = d;
  const m = (k) => `metrics.${ident(k)}`;
  const dim = (k) => `dimensions.${ident(k)}`;
  const label = (k) => metricOf(area, k).label;
  const good = (k) => metricOf(area, k).good ?? "up";
  const t = str(w.title);
  const base = `title={${t}}`;
  switch (w.kind) {
    case "trend": {
      const variant = r.pick(["line", "line", "area"]);
      return {
        load: `timeseries(ctx, [${w.metrics.map(m).join(", ")}])`,
        jsx: `<TimeseriesWidget ${base} data={data.${key}} variant="${variant}" span={${span}} />`,
        uses: ["TimeseriesWidget"],
        insights: [
          `trendInsight(${str(label(w.metrics[0]))}, data.${key}, "${good(w.metrics[0])}")`,
          `spikeInsight(${str(label(w.metrics[0]))}, data.${key})`,
        ],
      };
    }
    case "cumulative":
      return {
        load: `{ series: timeseries(ctx, ${m(w.metric)}, { cumulative: true }), target: kpis(ctx, [${m(w.target)}])[0].value }`,
        jsx: `<TimeseriesWidget ${base} subtitle="Running total against the range's target" data={data.${key}.series} target={data.${key}.target} span={${span}} summarize={false} />`,
        uses: ["TimeseriesWidget"],
        insights: [],
      };
    case "bars":
      return {
        load: `timeseries(ctx, ${m(w.metric)})`,
        jsx: `<TimeseriesWidget ${base} data={data.${key}} variant="bar" span={${span}} />`,
        uses: ["TimeseriesWidget"],
        insights: [`spikeInsight(${str(label(w.metric))}, data.${key})`],
      };
    case "stack": {
      const top = r.pick([5, 6, 6, 8]);
      return {
        load: `timeseries(ctx, ${m(w.metric)}, { breakdown: ${dim(w.by)}, top: ${top} })`,
        jsx: `<TimeseriesWidget ${base} subtitle=${str(`Top ${top} by ${lc(dimLabel(area, w.by))}`)} data={data.${key}} variant="${w.variant}" span={${span}} />`,
        uses: ["TimeseriesWidget"],
        insights: [],
      };
    }
    case "combo":
      return {
        load: `{ bars: timeseries(ctx, ${m(w.bar)}), line: timeseries(ctx, ${m(w.line)}) }`,
        jsx: `<ComboWidget ${base} subtitle=${str(`${label(w.bar)} (bars) and ${lc(label(w.line))} (line)`)} bars={data.${key}.bars} line={data.${key}.line} span={${span}} />`,
        uses: ["ComboWidget"],
        insights: [`trendInsight(${str(label(w.bar))}, data.${key}.bars, "${good(w.bar)}")`],
      };
    case "ranked":
    case "donut": {
      const top = w.kind === "donut" ? 6 : r.pick([6, 8, 10]);
      const what = `${lc(label(w.metric))} by ${lc(dimLabel(area, w.by))}`;
      return {
        load: `breakdown(ctx, ${m(w.metric)}, ${dim(w.by)}, { top: ${top} })`,
        jsx: `<BreakdownWidget ${base} data={data.${key}} variant="${w.kind === "donut" ? "donut" : "ranked"}" span={${span}} />`,
        uses: ["BreakdownWidget"],
        insights: [
          `leaderInsight(${str(what)}, data.${key})`,
          `moverInsight(${str(what)}, data.${key}, "${good(w.metric)}")`,
        ],
      };
    }
    case "heatmap":
      return {
        load: `matrix(ctx, ${m(w.metric)}, ${dim(w.rows)}, ${dim(w.cols)})`,
        jsx: `<HeatmapWidget ${base} subtitle=${str(`${dimLabel(area, w.rows)} × ${lc(dimLabel(area, w.cols))}`)} data={data.${key}}${w.scheme ? ` scheme="${w.scheme}"` : ""} span={${span}} />`,
        uses: ["HeatmapWidget"],
        insights: [],
      };
    case "treemap":
      return {
        load: `{ tree: hierarchy(ctx, ${m(w.metric)}, ${dim(w.outer)}, ${dim(w.inner)}), unit: ${m(w.metric)}.unit }`,
        jsx: `<TreemapWidget ${base} data={data.${key}.tree} unit={data.${key}.unit} span={${span}} />`,
        uses: ["TreemapWidget"],
        insights: [],
      };
    case "sankey":
      return {
        load: `flow(ctx, ${m(w.metric)}, [${w.stages.map(dim).join(", ")}])`,
        jsx: `<SankeyWidget ${base} subtitle=${str(w.stages.map((s) => dimLabel(area, s)).join(" → "))} data={data.${key}} span={${span}} />`,
        uses: ["SankeyWidget"],
        insights: [],
      };
    case "funnel":
      return {
        load: `funnel(ctx, ${str(w.steps)}, ${w.top})`,
        jsx: `<FunnelWidget ${base} subtitle="Step and overall conversion" steps={data.${key}} span={${span}} />`,
        uses: ["FunnelWidget"],
        insights: [],
      };
    case "cohort":
      return {
        load: `cohorts(ctx, { periods: ${w.periods}, grain: "${w.grain}" })`,
        jsx: `<CohortWidget ${base} subtitle="Share of each cohort still active" rows={data.${key}} periodLabel="${w.grain === "week" ? "W" : "M"}" span={${span}} />`,
        uses: ["CohortWidget"],
        insights: [],
      };
    case "histogram":
      return {
        load: `distribution(ctx, ${m(w.metric)}, ${r.pick([300, 400, 500])})`,
        jsx: `<DistributionWidget ${base} data={data.${key}} span={${span}} />`,
        uses: ["DistributionWidget"],
        insights: [],
      };
    case "box":
      return {
        load: `groupedDistribution(ctx, ${m(w.metric)}, ${dim(w.by)})`,
        jsx: `<BoxPlotWidget ${base} subtitle=${str(`Quartiles and 1.5 IQR whiskers by ${lc(dimLabel(area, w.by))}`)} data={data.${key}} span={${span}} />`,
        uses: ["BoxPlotWidget"],
        insights: [],
      };
    case "scatter": {
      const opts = [
        w.size ? `size: ${m(w.size)}` : null,
        `pool: "${w.pool ?? "company"}"`,
        `n: ${r.pick([60, 80, 100])}`,
      ].filter(Boolean);
      return {
        load: `scatter(ctx, ${m(w.x)}, ${m(w.y)}, ${dim(w.by)}, { ${opts.join(", ")} })`,
        jsx: `<ScatterWidget ${base} subtitle=${str(`Colored by ${lc(dimLabel(area, w.by))}${w.size ? `, sized by ${lc(label(w.size))}` : ""}`)} data={data.${key}} span={${span}} />`,
        uses: ["ScatterWidget"],
        insights: [],
      };
    }
    case "gauge":
      return {
        load: `goal(ctx, ${m(w.metric)}, ${w.target})`,
        jsx: `<GaugeWidget ${base} value={data.${key}.value} target={data.${key}.target} unit={data.${key}.unit} label={data.${key}.label} span={${span}} />`,
        uses: ["GaugeWidget"],
        insights: [],
      };
    case "calendar":
      return {
        load: `{ days: daily(ctx, ${m(w.metric)}), unit: ${m(w.metric)}.unit }`,
        jsx: `<CalendarWidget ${base} subtitle="Last 12 months" days={data.${key}.days} unit={data.${key}.unit} span={${span}} />`,
        uses: ["CalendarWidget"],
        insights: [],
      };
    case "radar":
      return {
        load: `profile(ctx, [${w.metrics.map(m).join(", ")}], ${dim(w.by)})`,
        jsx: `<RadarWidget ${base} subtitle=${str(`Each score relative to the best ${lc(dimLabel(area, w.by))}`)} data={data.${key}} span={${span}} />`,
        uses: ["RadarWidget"],
        insights: [],
      };
    default:
      throw new Error(`unknown widget kind ${w.kind}`);
  }
}

const ENGINE_FN = {
  trend: ["timeseries"],
  cumulative: ["timeseries", "kpis"],
  bars: ["timeseries"],
  stack: ["timeseries"],
  combo: ["timeseries"],
  ranked: ["breakdown"],
  donut: ["breakdown"],
  heatmap: ["matrix"],
  treemap: ["hierarchy"],
  sankey: ["flow"],
  funnel: ["funnel"],
  cohort: ["cohorts"],
  histogram: ["distribution"],
  box: ["groupedDistribution"],
  scatter: ["scatter"],
  gauge: ["goal"],
  calendar: ["daily"],
  radar: ["profile"],
};

const sortedList = (xs) => [...new Set(xs)].sort();

// ---- one dashboard's folder ------------------------------------------------------------
function emitDashboard(d, index, related) {
  const { area, arch, scope } = d;
  const r = rng("dashboard", d.id);
  const scopeDims = new Set(Object.keys(scope));
  // A widget split by a dimension this dashboard is scoped to (e.g. "by region" on an
  // EMEA dashboard) is split by another of the area's dimensions instead.
  const spare = r.shuffle(Object.keys(area.dimensions).filter((k) => !scopeDims.has(k)));
  let rot = 0;
  const retarget = (w) => {
    if (!widgetDims(w).some((k) => scopeDims.has(k))) return w;
    const out = { ...w };
    for (const field of ["by", "rows", "cols", "outer", "inner", "stages"]) {
      const swap = (k) => {
        if (!scopeDims.has(k)) return k;
        const used = new Set(widgetDims(out));
        const alt = [...spare.slice(rot), ...spare.slice(0, rot)].find((s) => !used.has(s));
        rot = (rot + 1) % spare.length;
        if (!alt) return null;
        const [from, to] = [area.dimensions[k].label, area.dimensions[alt].label];
        // "Cost by region" names the "Cloud region" dimension by its last word
        const name = [lc(from), from, lc(from.split(" ").pop())].find((n) => out.title.includes(n));
        if (name) out.title = out.title.replace(name, lc(to));
        return alt;
      };
      if (field === "stages" && out.stages) out.stages = out.stages.map(swap);
      else if (out[field]) out[field] = swap(out[field]);
    }
    return widgetDims(out).some((k) => k === null) ? null : out;
  };
  // the archetype's widgets plus 0-2 optional ones
  const core = arch.widgets.map(retarget).filter(Boolean);
  const extra = r
    .shuffle(arch.optional.map(retarget).filter(Boolean))
    .slice(0, r.int(core.length < 4 ? 1 : 0, 2));
  const chosen = [...core, ...extra];
  const spans = pack(chosen.map((w) => baseSpan(area, w)));
  const keys = new Set();
  const widgets = chosen.map((w, i) => {
    let key = camel(w.title);
    while (keys.has(key)) key += "2";
    keys.add(key);
    return { w, key, ...emitWidget(d, w, key, spans[i], r) };
  });

  const kpiKeys = [...arch.kpis];
  if (r.chance(45)) {
    const spare = area.metrics.map((m) => m.key).filter((k) => !kpiKeys.includes(k));
    kpiKeys.push(r.pick(spare));
  }
  const entity = area.entities[arch.table.entity];
  const tableMetrics = [...arch.table.metrics];
  const rowsN = r.pick([36, 48, 60, 80]);
  const drill = r.chance(DRILL_PCT);
  const exportable = r.chance(EXPORT_PCT);
  const owner = r.pick(
    area.dimensions.rep?.values ?? [
      "A. Okafor",
      "J. Tanaka",
      "M. Rossi",
      "P. Patel",
      "S. Larsen",
      "H. Park",
      "L. Moreau",
      "N. Mensah",
    ],
  );
  const refresh = r.pick(REFRESH);
  const defaultRange = r.pick(["30d", "30d", "90d", "90d", "6m", "12m"]);
  const filterDims = Object.entries(area.filters).filter(([, dk]) => !scopeDims.has(dk));
  const scopeText = Object.values(scope).join(" · ");
  const description = `${arch.description} Scoped to ${Object.entries(scope)
    .map(([k, v]) => `${lc(area.dimensions[k].label)} ${v}`)
    .join(", ")}.`;
  const tableName = `${pascal(entity.plural)}Table`;

  // spec.ts
  emit(
    `${d.dir}/spec.ts`,
    `import type { DashboardMeta } from "@/viz/spec";

export const meta = {
  id: ${str(d.id)},
  title: ${str(d.title)},
  description: ${str(description)},
  area: ${str(area.key)},
  archetype: ${str(arch.key)},
  scope: ${JSON.stringify(scope)},
  href: ${str(d.href)},
  owner: ${str(owner)},
  refresh: ${str(refresh)},
  tags: ${JSON.stringify([...Object.values(scope), area.team])},
  defaultRange: "${defaultRange}",
} as const satisfies DashboardMeta;
`,
    "dashboards",
  );

  // queries.ts
  const engineFns = sortedList([
    "kpis",
    "records",
    ...widgets.flatMap(({ w }) => ENGINE_FN[w.kind]),
  ]);
  const needsDims = widgets.some(({ load }) => load.includes("dimensions."));
  emit(
    `${d.dir}/queries.ts`,
    `import { cache } from "react";
import { ${engineFns.join(", ")}, type Filters, type QueryContext } from "@/data";
import { ${needsDims ? "dimensions, " : ""}entities, metrics } from "@/areas/${area.key}";
import { meta } from "./spec";

/** Everything the dashboard shows, for one set of filters (once per request). */
export const loadDashboard = cache(async (filters: Filters) => {
  const ctx: QueryContext = { seed: meta.id, filters, scope: meta.scope };
  return {
    kpis: kpis(ctx, [${kpiKeys.map((k) => `metrics.${ident(k)}`).join(", ")}]),
${widgets.map(({ key, load, w }) => `    // ${w.title}\n    ${key}: ${load},`).join("\n")}
    rows: records(ctx, entities.${ident(arch.table.entity)}, [${tableMetrics.map((k) => `metrics.${ident(k)}`).join(", ")}], ${rowsN}),
  };
});

export type DashboardData = Awaited<ReturnType<typeof loadDashboard>>;
`,
    "dashboards",
  );

  // insights.ts
  const insightExprs = widgets.flatMap(({ insights }) => insights);
  const insightFns = sortedList([
    "kpiInsight",
    "rankInsights",
    ...insightExprs.map((e) => e.slice(0, e.indexOf("("))),
  ]);
  emit(
    `${d.dir}/insights.ts`,
    `import { ${insightFns.join(", ")}, type Insight } from "@/viz/insights";
import type { DashboardData } from "./queries";

export function dashboardInsights(data: DashboardData): Insight[] {
  return rankInsights(
    [
${[...insightExprs, "kpiInsight(data.kpis[0])", "kpiInsight(data.kpis[1])"].map((e) => `      ${e},`).join("\n")}
    ],
    ${r.pick([3, 4, 4])},
  );
}
`,
    "dashboards",
  );

  // Kpis.tsx
  const summaryKeys = kpiKeys.slice(0, 3);
  emit(
    `${d.dir}/Kpis.tsx`,
    `import Link from "next/link";
import { DEFAULT_FILTERS, kpis } from "@/data";
import { metrics } from "@/areas/${area.key}";
import { KpiGrid, KpiStrip } from "@/viz/kpi";
import type { DashboardData } from "./queries";
import { meta } from "./spec";

export function Kpis({ data }: { data: DashboardData }) {
  return <KpiGrid kpis={data.kpis} />;
}

/** This dashboard in one line, for pages that link to it. */
export function Summary() {
  const headline = kpis({ seed: meta.id, filters: DEFAULT_FILTERS, scope: meta.scope }, [
    ${summaryKeys.map((k) => `metrics.${ident(k)}`).join(",\n    ")},
  ]);
  return (
    <div className="related">
      <Link href={meta.href} className="related__title">
        {meta.title}
      </Link>
      <KpiStrip kpis={headline} />
    </div>
  );
}
`,
    "dashboards",
  );

  // Charts.tsx
  const uses = sortedList(widgets.flatMap((x) => x.uses));
  const fromRoot = r.chance(50);
  const chartImports = fromRoot
    ? `import { ${sortedList([...uses, "WidgetGrid"]).join(", ")} } from "@/viz";`
    : `import { ${uses.join(", ")} } from "@/viz/widgets";\nimport { WidgetGrid } from "@/viz/layout";`;
  emit(
    `${d.dir}/Charts.tsx`,
    `${chartImports}
import type { DashboardData } from "./queries";

export function Charts({ data }: { data: DashboardData }) {
  return (
    <WidgetGrid>
${widgets.map(({ jsx }) => `      ${jsx}`).join("\n")}
    </WidgetGrid>
  );
}
`,
    "dashboards",
  );

  // columns.tsx
  const colLines = [
    drill
      ? `nameColumn(${str(entity.label)}, (row) => \`${d.href}/\${row.id}\`)`
      : `nameColumn(${str(entity.label)})`,
    entity.pool === "person" ? null : `ownerColumn()`,
    `statusColumn()`,
    ...tableMetrics.map((k) => {
      const mm = metricOf(area, k);
      return `metricColumn(${str(k)}, ${str(mm.label)}, "${mm.unit}")`;
    }),
    `deltaColumn("Change", "${metricOf(area, tableMetrics[0]).good ?? "up"}")`,
    r.chance(70)
      ? `trendColumn("12-week trend", "${metricOf(area, tableMetrics[0]).good ?? "up"}")`
      : null,
  ].filter(Boolean);
  const colFns = sortedList(colLines.map((l) => l.slice(0, l.indexOf("("))));
  emit(
    `${d.dir}/columns.tsx`,
    `"use client";

import { ${colFns.join(", ")}, type RecordColumn } from "@/viz/table";

export const columns: RecordColumn[] = [
${colLines.map((l) => `  ${l},`).join("\n")}
];
`,
    "dashboards",
  );

  // Table.tsx
  emit(
    `${d.dir}/Table.tsx`,
    `"use client";

import { useCallback } from "react";
import type { RecordRow } from "@/data/types";
import { DataTable } from "@/viz/table";
import { columns } from "./columns";

export function ${tableName}({ rows }: { rows: RecordRow[] }) {
  const toCsvRow = useCallback(
    (row: RecordRow) => ({ id: row.id, name: row.name, owner: row.owner, status: row.status, ...row.values }),
    [],
  );
  return (
    <DataTable
      data={rows}
      columns={columns}
      pageSize={${r.pick([8, 10, 10, 12])}}
      initialSort={[{ id: ${str(tableMetrics[0])}, desc: true }]}
      searchPlaceholder=${str(`Search ${entity.plural.toLowerCase()}`)}
      csvName=${str(`${d.id}-${slug(entity.plural)}`)}
      toCsvRow={toCsvRow}
    />
  );
}
`,
    "dashboards",
  );

  // Filters.tsx
  emit(
    `${d.dir}/Filters.tsx`,
    `"use client";

import { FilterBar, type FilterDimension } from "@/viz/filters";

const dimensions: FilterDimension[] = [
${filterDims.map(([param, dk]) => `  { param: "${param}", label: ${str(area.dimensions[dk].label)}, values: ${JSON.stringify(area.dimensions[dk].values)} },`).join("\n")}
];

export function Filters() {
  return <FilterBar dimensions={dimensions} defaultRange="${defaultRange}"${r.chance(25) ? " grain={false}" : ""} />;
}
`,
    "dashboards",
  );

  // Dashboard.tsx
  const crumbs = `[{ label: ${str(area.label)}, href: "/${area.key}" }, { label: ${str(arch.label)}, href: "/${area.key}/${arch.key}" }, { label: ${str(scopeText)} }]`;
  const layoutImports = sortedList([
    "DashboardHeader",
    "InsightList",
    "Section",
    "Widget",
    ...(exportable ? ["ExportButton"] : []),
  ]);
  emit(
    `${d.dir}/Dashboard.tsx`,
    `import type { Filters as DashboardFilters } from "@/data";
import { ${layoutImports.join(", ")} } from "@/viz";
${related ? `import { Summary as Related${index} } from "${related.importPath}";\n` : ""}import { Charts } from "./Charts";
import { Filters } from "./Filters";
import { dashboardInsights } from "./insights";
import { Kpis } from "./Kpis";
import { loadDashboard } from "./queries";
import { meta } from "./spec";
import { ${tableName} } from "./Table";

export async function Dashboard({ filters }: { filters: DashboardFilters }) {
  const data = await loadDashboard(filters);
  return (
    <>
      <DashboardHeader
        title={meta.title}
        description={meta.description}
        crumbs={${crumbs}}
        owner={meta.owner}
        refresh={meta.refresh}
        tags={meta.tags}${exportable ? `\n        actions={<ExportButton href={\`\${meta.href}/export\`} />}` : ""}
      />
      <Filters />
      <InsightList insights={dashboardInsights(data)} />
      <Kpis data={data} />
      <Charts data={data} />
      <Section title=${str(arch.table.title)} description=${str(`${rowsN} ${entity.plural.toLowerCase()} in this scope`)}>
        <Widget title=${str(entity.plural)} span={12}>
          <${tableName} rows={data.rows} />
        </Widget>
      </Section>${
        related
          ? `
      <Section title="Related dashboards">
        <Related${index} />
      </Section>`
          : ""
      }
    </>
  );
}
`,
    "dashboards",
  );

  // index.ts
  emit(
    `${d.dir}/index.ts`,
    `export { Dashboard } from "./Dashboard";
export { Summary } from "./Kpis";
export { meta } from "./spec";
export { loadDashboard } from "./queries";
export type { DashboardData } from "./queries";
`,
    "dashboards",
  );

  // routes
  emit(
    `app/${area.key}/${arch.key}/${d.scopeSlug}/page.tsx`,
    `import type { Metadata } from "next";
import { parseFilters, type SearchParams } from "@/data";
import { Dashboard, meta } from "${d.importPath}";

export const metadata: Metadata = { title: meta.title, description: meta.description };

export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const filters = parseFilters(await searchParams, { range: meta.defaultRange });
  return (
    <main className="page">
      <Dashboard filters={filters} />
    </main>
  );
}
`,
  );
  if (drill) {
    const [a, b, c] = [...tableMetrics, ...kpiKeys.filter((k) => !tableMetrics.includes(k))];
    emit(
      `app/${area.key}/${arch.key}/${d.scopeSlug}/[entityId]/page.tsx`,
      `import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { kpis, parseFilters, records, timeseries, type SearchParams } from "@/data";
import { entities, metrics } from "@/areas/${area.key}";
import { meta } from "${d.importPath}";
import { DashboardHeader, KpiGrid, TimeseriesWidget, WidgetGrid } from "@/viz";

type Params = Promise<{ entityId: string }>;

const rowsOf = (filters: ReturnType<typeof parseFilters>) =>
  records({ seed: meta.id, filters, scope: meta.scope }, entities.${ident(arch.table.entity)}, [${tableMetrics.map((k) => `metrics.${ident(k)}`).join(", ")}], ${rowsN});

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { entityId } = await params;
  const row = rowsOf(parseFilters({})).find((r) => r.id === entityId);
  return { title: row ? \`\${row.name} · \${meta.title}\` : meta.title };
}

export default async function EntityPage({ params, searchParams }: { params: Params; searchParams: Promise<SearchParams> }) {
  const { entityId } = await params;
  const filters = parseFilters(await searchParams, { range: meta.defaultRange });
  const row = rowsOf(filters).find((r) => r.id === entityId);
  if (!row) notFound();
  const ctx = { seed: \`\${meta.id}/\${row.id}\`, filters, scope: meta.scope };
  return (
    <main className="page">
      <DashboardHeader
        title={row.name}
        description={\`${entity.label} in \${meta.title}\`}
        crumbs={[{ label: ${str(area.label)}, href: "/${area.key}" }, { label: ${str(arch.label)}, href: "/${area.key}/${arch.key}" }, { label: ${str(scopeText)}, href: meta.href }, { label: row.name }]}
        owner={row.owner}
        tags={[row.status, row.id]}
      />
      <KpiGrid kpis={kpis(ctx, [${[a, b, c]
        .filter(Boolean)
        .map((k) => `metrics.${ident(k)}`)
        .join(", ")}])} />
      <WidgetGrid>
        <TimeseriesWidget title=${str(metricOf(area, a).label)} data={timeseries(ctx, metrics.${ident(a)})} span={12} />
${[b, c]
  .filter(Boolean)
  .map(
    (k, i) =>
      `        <TimeseriesWidget title=${str(metricOf(area, k).label)} data={timeseries(ctx, metrics.${ident(k)})} variant="${i ? "area" : "bar"}" span={6} />`,
  )
  .join("\n")}
      </WidgetGrid>
    </main>
  );
}
`,
    );
  }
  if (exportable) {
    emit(
      `app/${area.key}/${arch.key}/${d.scopeSlug}/export/route.ts`,
      `import { flattenRecords, parseFilters, toCsv } from "@/data";
import { loadDashboard } from "@/dashboards/${area.key}/${arch.key}/${d.scopeSlug}/queries";
import { meta } from "@/dashboards/${area.key}/${arch.key}/${d.scopeSlug}/spec";

/** The dashboard's table under the request's filters, as CSV (default) or JSON. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const filters = parseFilters(Object.fromEntries(url.searchParams), { range: meta.defaultRange });
  const data = await loadDashboard(filters);
  const rows = flattenRecords(data.rows);
  if (url.searchParams.get("format") === "json")
    return Response.json({ dashboard: meta.id, filters, kpis: data.kpis, rows });
  return new Response(toCsv(rows), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": \`attachment; filename="\${meta.id}.csv"\`,
    },
  });
}
`,
    );
  }
  return { drill, exportable };
}

// ---- generate ------------------------------------------------------------------------
copyTemplate();

// areas
for (const area of AREAS) {
  const dir = `src/areas/${area.key}`;
  const metricLines = area.metrics.map((m) => {
    const fields = Object.entries(m).map(([k, v]) => `${k}: ${typeof v === "string" ? str(v) : v}`);
    return `  { ${fields.join(", ")} },`;
  });
  emit(
    `${dir}/metrics.ts`,
    `import { defineMetrics } from "@/data";

export const metrics = defineMetrics([
${metricLines.join("\n")}
] as const);
`,
    "areas",
  );
  emit(
    `${dir}/dimensions.ts`,
    `import { builtinDimensions, defineDimension } from "@/data";

export const dimensions = {
${Object.entries(area.dimensions)
  .map(
    ([k, d]) =>
      `  ${ident(k)}: defineDimension(${str(k)}, ${str(d.label)}, ${JSON.stringify(d.values)}),`,
  )
  .join("\n")}
  ...builtinDimensions,
};
`,
    "areas",
  );
  emit(
    `${dir}/entities.ts`,
    `import { defineEntity } from "@/data";

export const entities = {
${Object.entries(area.entities)
  .map(
    ([k, e]) =>
      `  ${ident(k)}: defineEntity({ key: ${str(k)}, label: ${str(e.label)}, plural: ${str(e.plural)}, pool: "${e.pool}", statuses: ${JSON.stringify(e.statuses)} }),`,
  )
  .join("\n")}
};
`,
    "areas",
  );
  const own = dashboards.filter((d) => d.area === area);
  emit(
    `${dir}/directory.ts`,
    `import type { DirectoryEntry } from "@/viz/spec";

export const directory: DirectoryEntry[] = [
${own.map((d) => `  { id: ${str(d.id)}, title: ${str(d.title)}, href: ${str(d.href)}, archetype: ${str(d.arch.key)}, scope: ${JSON.stringify(d.scope)} },`).join("\n")}
];
`,
    "areas",
  );
  emit(
    `${dir}/index.ts`,
    `export const area = {
  key: ${str(area.key)},
  label: ${str(area.label)},
  icon: ${str(area.icon)},
  accent: ${str(area.accent)},
  description: ${str(area.description)},
  team: ${str(area.team)},
  archetypes: [
${area.archetypes.map((a) => `    { key: ${str(a.key)}, label: ${str(a.label)}, description: ${str(a.description)}, lead: ${str(a.kpis[0])} },`).join("\n")}
  ],
} as const;

export { metrics } from "./metrics";
export { dimensions } from "./dimensions";
export { entities } from "./entities";
export { directory } from "./directory";
`,
    "areas",
  );
}

emit(
  "src/generated/areas.ts",
  `${AREAS.map((a) => `import * as ${ident(a.key)} from "@/areas/${a.key}";`).join("\n")}

export const AREAS = [
${AREAS.map(
  (a) =>
    `  { key: ${str(a.key)}, label: ${str(a.label)}, icon: ${str(a.icon)}, accent: ${str(a.accent)}, href: "/${a.key}", description: ${str(a.description)}, dashboards: ${ident(a.key)}.directory.length, headline: [${a.headline.map((k) => `${ident(a.key)}.metrics.${ident(k)}`).join(", ")}] },`,
).join("\n")}
];
`,
  "areas",
);
emit(
  "src/generated/directory.ts",
  `${AREAS.map((a) => `import { directory as ${ident(a.key)} } from "@/areas/${a.key}/directory";`).join("\n")}

export const DIRECTORY = [
${AREAS.map((a) => `  ...${ident(a.key)}.map((d) => ({ ...d, area: ${str(a.key)}, areaLabel: ${str(a.label)} })),`).join("\n")}
];
`,
  "areas",
);

// area layouts, overview pages and archetype index pages
for (const area of AREAS) {
  emit(
    `app/${area.key}/layout.tsx`,
    `import { area } from "@/areas/${area.key}";
import { AreaTabs } from "@/shell";

const tabs = [{ label: "Overview", href: "/${area.key}" }, ...area.archetypes.map((a) => ({ label: a.label, href: \`/${area.key}/\${a.key}\` }))];

export default function ${pascal(area.label)}Layout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ ["--accent" as string]: area.accent }}>
      <div className="page page--tabs">
        <AreaTabs tabs={tabs} />
      </div>
      {children}
    </div>
  );
}
`,
  );
  emit(
    `app/${area.key}/page.tsx`,
    `import type { Metadata } from "next";
import { DEFAULT_FILTERS, breakdown, kpis, timeseries } from "@/data";
import { area, dimensions, directory, metrics } from "@/areas/${area.key}";
import { DashboardCard } from "@/shell";
import { BreakdownWidget, DashboardHeader, KpiGrid, Section, TimeseriesWidget, WidgetGrid } from "@/viz";

export const metadata: Metadata = { title: area.label, description: area.description };

export default function ${pascal(area.label)}Overview() {
  const ctx = { seed: \`area:\${area.key}\`, filters: { ...DEFAULT_FILTERS, range: "12m" as const, grain: "month" as const } };
  return (
    <main className="page">
      <DashboardHeader title={area.label} description={area.description} owner={area.team} tags={[\`\${directory.length} dashboards\`]} />
      <KpiGrid kpis={kpis(ctx, [${area.headline.map((k) => `metrics.${ident(k)}`).join(", ")}])} />
      <WidgetGrid>
        <TimeseriesWidget title=${str(metricOf(area, area.headline[0]).label)} subtitle="Last 12 months" data={timeseries(ctx, metrics.${ident(area.headline[0])})} variant="area" span={8} />
        <BreakdownWidget title=${str(`${metricOf(area, area.headline[0]).label} by ${lc(area.dimensions[area.scopeAxes[0]].label)}`)} data={breakdown(ctx, metrics.${ident(area.headline[0])}, dimensions.${ident(area.scopeAxes[0])})} variant="donut" span={4} />
      </WidgetGrid>
      {area.archetypes.map((a) => (
        <Section key={a.key} title={a.label} description={a.description}>
          <div className="card-grid">
            {directory
              .filter((d) => d.archetype === a.key)
              .slice(0, 4)
              .map((d) => (
                <DashboardCard key={d.id} title={d.title} href={d.href} subtitle={Object.values(d.scope).join(" · ")} />
              ))}
          </div>
        </Section>
      ))}
    </main>
  );
}
`,
  );
  for (const arch of area.archetypes) {
    emit(
      `app/${area.key}/${arch.key}/page.tsx`,
      `import type { Metadata } from "next";
import { DEFAULT_FILTERS, kpis } from "@/data";
import { directory, metrics } from "@/areas/${area.key}";
import { DashboardCard } from "@/shell";
import { DashboardHeader } from "@/viz";

export const metadata: Metadata = { title: ${str(`${arch.label} · ${area.label}`)} };

const dashboards = directory.filter((d) => d.archetype === ${str(arch.key)});

export default function ${pascal(arch.label)}Index() {
  return (
    <main className="page">
      <DashboardHeader
        title=${str(arch.label)}
        description=${str(arch.description)}
        crumbs={[{ label: ${str(area.label)}, href: "/${area.key}" }, { label: ${str(arch.label)} }]}
        tags={[\`\${dashboards.length} scopes\`]}
      />
      <div className="card-grid">
        {dashboards.map((d) => (
          <DashboardCard
            key={d.id}
            title={Object.values(d.scope).join(" · ")}
            href={d.href}
            subtitle={d.title}
            kpi={kpis({ seed: d.id, filters: DEFAULT_FILTERS, scope: d.scope }, [metrics.${ident(arch.kpis[0])}])[0]}
            accent=${str(area.accent)}
          />
        ))}
      </div>
    </main>
  );
}
`,
    );
  }
}

// dashboards; a related-dashboard summary points at an earlier dashboard of the same
// area, weighted toward that area's first ones (the shared "core" views)
const firstOfArea = new Map();
dashboards.forEach((d, i) => {
  if (!firstOfArea.has(d.area.key)) firstOfArea.set(d.area.key, i);
});
let drilldowns = 0;
let exportsN = 0;
let relatedN = 0;
dashboards.forEach((d, i) => {
  const r = rng("related", d.id);
  const lo = firstOfArea.get(d.area.key);
  let related = null;
  if (i > lo && r.chance(RELATED_PCT)) {
    const span = i - lo;
    related = dashboards[lo + Math.min(span - 1, Math.floor(Math.pow(r.next(), 2.2) * span))];
    relatedN++;
  }
  const res = emitDashboard(d, i, related);
  drilldowns += res.drill ? 1 : 0;
  exportsN += res.exportable ? 1 : 0;
});

// project files
emit(
  "package.json",
  JSON.stringify(
    {
      name: "@demo/vizdash",
      version: "0.0.0",
      private: true,
      scripts: {
        dev: "next dev",
        build: "next build",
        "build:compile": "next build --experimental-build-mode=compile",
        start: "next start",
        typecheck: "tsc --noEmit",
      },
      dependencies: PINS.dependencies,
      devDependencies: PINS.devDependencies,
    },
    null,
    2,
  ) + "\n",
);
emit(
  "next.config.ts",
  `import type { NextConfig } from "next";

// MONOLITH_DIST_DIR lets parallel builds of one tree write separate outputs;
// MONOLITH_BUILD_ID pins the build id so two builds' outputs can be compared;
// MONOLITH_TP_FS_CACHE=0 turns off Turbopack's persistent cache for the build.
// (The names are shared with monolith-gen.mjs, so the gym drives both apps alike.)
const config: NextConfig = {
  distDir: process.env.MONOLITH_DIST_DIR || ".next",
  generateBuildId: async () => process.env.MONOLITH_BUILD_ID || null,
  typescript: { ignoreBuildErrors: true },
  experimental: { turbopackFileSystemCacheForBuild: process.env.MONOLITH_TP_FS_CACHE !== "0" },
};

export default config;
`,
);
emit(
  "tsconfig.json",
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        lib: ["dom", "dom.iterable", "esnext"],
        strict: true,
        noEmit: true,
        module: "esnext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        skipLibCheck: true,
        isolatedModules: true,
        esModuleInterop: true,
        allowJs: true,
        incremental: true,
        resolveJsonModule: true,
        paths: { "@/*": ["./src/*"] },
        plugins: [{ name: "next" }],
      },
      // what `next build` adds, so a build leaves the generated tree unchanged
      include: ["**/*.ts", "**/*.tsx", ".next/types/**/*.ts", ".next/dev/types/**/*.ts"],
      exclude: ["node_modules"],
    },
    null,
    2,
  ) + "\n",
);
emit(".gitignore", "node_modules/\n.next*/\nnext-env.d.ts\n");
if (existsSync(LOCKFILE)) {
  copyFileSync(LOCKFILE, join(OUT, "pnpm-lock.yaml"));
  files++;
}

const areaPages = AREAS.length;
const archPages = archetypes.length;
const pages = 2 + areaPages + archPages + dashboards.length + drilldowns; // "/" and "/search"
const summary = {
  generator: GENERATOR,
  out: OUT,
  files,
  tsFiles,
  tsFilesByPart: tsByPart,
  routes: pages + exportsN,
  pages,
  handlers: exportsN,
  layouts: 1 + AREAS.length,
  areas: AREAS.length,
  archetypes: archetypes.length,
  dashboards: dashboards.length,
  drilldowns,
  related: relatedN,
  options: {
    dashboards: DASHBOARDS,
    drilldownPct: DRILL_PCT,
    exportPct: EXPORT_PCT,
    relatedPct: RELATED_PCT,
  },
  seed: SEED,
  next: NEXT_VERSION,
  react: REACT_VERSION,
  dependencies: PINS.dependencies,
  lockfile: existsSync(LOCKFILE),
};
writeFileSync(join(OUT, "monolith.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary));
