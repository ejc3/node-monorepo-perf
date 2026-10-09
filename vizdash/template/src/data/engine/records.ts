import { orderBy } from "lodash-es";
import { entityName, personName } from "../names";
import { rng } from "../rng";
import type {
  DimensionDef,
  EntityDef,
  MetricDef,
  ProfileResult,
  QueryContext,
  RecordRow,
  ScatterResult,
} from "../types";
import { differenceInCalendarDays } from "date-fns";
import { intervalOf, jitterRate, sliceLevel, streamKey } from "./model";

/** Rows of an entity table (accounts, campaigns, services...) with per-row metrics. */
export function records(
  ctx: QueryContext,
  entity: EntityDef,
  metrics: readonly MetricDef[],
  n = 60,
): RecordRow[] {
  // ids, names and owners depend only on the dashboard and its scope, so a row keeps
  // its id (and its drill-down link) under every filter; values follow the filters
  const scope = Object.entries(ctx.scope ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  const who = rng(ctx.seed, scope, "records-id", entity.key);
  // values cover the selected range: totals scale with its length
  const iv = intervalOf(ctx);
  const days = differenceInCalendarDays(iv.end, iv.start) + 1;
  const r = rng(...streamKey(ctx, "records", entity.key, ctx.filters.range));
  const level = sliceLevel(ctx);
  const rows = Array.from({ length: n }, (_, i): RecordRow => {
    const id = `${entity.key}-${(i + 1).toString(36)}${who.int(10, 99)}`;
    const name = entityName(entity.pool, who, i);
    const owner = personName(who);
    const size = r.lognormal(0, 0.9);
    const values = Object.fromEntries(
      metrics.map((m) => {
        if (m.unit === "percent") return [m.key, jitterRate(m.base, r.normal(0, 0.8))];
        const v =
          m.agg === "sum"
            ? (m.base * days * level * size) / Math.sqrt(n)
            : m.base * Math.max(0.2, 1 + r.normal(0, 0.18));
        return [m.key, v];
      }),
    );
    const drift = r.normal(0.02, 0.06);
    let t = 1;
    const trend = Array.from({ length: 12 }, () => (t *= 1 + drift + r.normal(0, 0.05)));
    return {
      id,
      name,
      owner,
      status: r.pick(entity.statuses),
      values,
      delta: trend[11] / trend[0] - 1,
      trend,
    };
  });
  const lead = metrics[0]?.key;
  return lead ? orderBy(rows, [(row) => row.values[lead]], ["desc"]) : rows;
}

/** Entities placed by two metrics, sized by a third, colored by a dimension. */
export function scatter(
  ctx: QueryContext,
  x: MetricDef,
  y: MetricDef,
  group: DimensionDef,
  opts: { size?: MetricDef; n?: number; correlation?: number; pool?: EntityDef["pool"] } = {},
): ScatterResult {
  const r = rng(...streamKey(ctx, "scatter", x.key, y.key, group.key));
  const n = opts.n ?? 80;
  const rho = opts.correlation ?? r.range(-0.4, 0.8);
  const points = Array.from({ length: n }, (_, i) => {
    const a = r.normal();
    const b = rho * a + Math.sqrt(1 - rho * rho) * r.normal();
    const xv = x.base * Math.exp(0.45 * a);
    const yv = y.base * Math.exp(0.35 * b);
    return {
      id: `p${i}`,
      label: entityName(opts.pool ?? "company", r, i),
      x: x.unit === "percent" ? jitterRate(x.base, a) : xv,
      y: y.unit === "percent" ? jitterRate(y.base, b) : yv,
      size: opts.size ? opts.size.base * r.lognormal(0, 0.6) : 1,
      group: r.pick(group.values),
    };
  });
  return {
    points,
    x: { label: x.label, unit: x.unit },
    y: { label: y.label, unit: y.unit },
    groups: group.values,
  };
}

/** Several metrics across the top values of a dimension, each scaled to its best value. */
export function profile(
  ctx: QueryContext,
  metrics: readonly MetricDef[],
  dim: DimensionDef,
  top = 4,
): ProfileResult {
  const r = rng(...streamKey(ctx, "profile", dim.key, ...metrics.map((m) => m.key)));
  const groups = r.shuffle(dim.values).slice(0, top);
  const raw = groups.map(() => metrics.map((m) => m.base * Math.max(0.15, 1 + r.normal(0, 0.22))));
  const best = metrics.map((m, j) => {
    const vals = raw.map((row) => row[j]);
    return m.good === "up" ? Math.max(...vals) : Math.min(...vals);
  });
  return {
    axes: metrics.map((m) => m.label),
    series: groups.map((label, i) => ({
      label,
      values: metrics.map((m, j) => (m.good === "up" ? raw[i][j] / best[j] : best[j] / raw[i][j])),
    })),
    unit: "percent",
  };
}
