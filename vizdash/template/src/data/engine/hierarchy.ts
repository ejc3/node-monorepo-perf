import { rng } from "../rng";
import type { DimensionDef, FlowResult, MetricDef, QueryContext, TreeNode } from "../types";
import { aggregate, dailyValues, intervalOf, streamKey } from "./model";

/** Two-level tree of the metric (e.g. region > product) for a treemap. */
export function hierarchy(
  ctx: QueryContext,
  metric: MetricDef,
  outer: DimensionDef,
  inner: DimensionDef,
): TreeNode {
  const r = rng(...streamKey(ctx, "tree", metric.key, outer.key, inner.key));
  const total = aggregate(metric, dailyValues(ctx, metric, intervalOf(ctx), "tree"));
  const ow = r.weights(outer.values.length, 0.8);
  return {
    name: metric.label,
    children: outer.values.map((o, i) => {
      const iw = r.weights(inner.values.length, 1.2);
      const order = r.shuffle(inner.values);
      return {
        name: o,
        children: order.map((name, j) => ({ name, value: total * ow[i] * iw[j] })),
      };
    }),
  };
}

/** Flow of the metric through consecutive stages (e.g. source > stage > outcome). */
export function flow(
  ctx: QueryContext,
  metric: MetricDef,
  stages: readonly DimensionDef[],
): FlowResult {
  const r = rng(...streamKey(ctx, "flow", metric.key, ...stages.map((s) => s.key)));
  const total = aggregate(metric, dailyValues(ctx, metric, intervalOf(ctx), "flow"));
  const nodes = stages.flatMap((s, stage) => s.values.map((name) => ({ name, stage })));
  const offset = (stage: number) => stages.slice(0, stage).reduce((n, s) => n + s.values.length, 0);
  const links: FlowResult["links"] = [];
  // inflow of every node of the current stage, starting from the first stage's shares
  let inflow = r.weights(stages[0].values.length, 0.8).map((w) => w * total);
  for (let st = 0; st + 1 < stages.length; st++) {
    const next = new Array(stages[st + 1].values.length).fill(0);
    inflow.forEach((amount, i) => {
      const split = r.weights(next.length, 0.6 + r.next());
      const order = r.shuffle(next.map((_, j) => j));
      order.forEach((j, k) => {
        const value = amount * split[k];
        if (value < total * 0.004) return;
        links.push({ source: offset(st) + i, target: offset(st + 1) + j, value });
        next[j] += value;
      });
    });
    inflow = next;
  }
  // drop nodes nothing flows through, and renumber the links
  const used = new Set(links.flatMap((l) => [l.source, l.target]));
  const keep = nodes.map((_, i) => i).filter((i) => used.has(i));
  const index = new Map(keep.map((old, i) => [old, i]));
  return {
    nodes: keep.map((i) => nodes[i]),
    links: links.map((l) => ({ ...l, source: index.get(l.source)!, target: index.get(l.target)! })),
    unit: metric.unit,
  };
}
