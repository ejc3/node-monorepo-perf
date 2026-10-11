#!/usr/bin/env node
// Renders bench/ci-cache-network-bench.json as a heat table in the house chart
// grammar (the shared scripts/_chartstyle.mjs system): rows = tasks, columns =
// cold-compute + the three cache-restore profiles. Each cell shows its restore time and
// its multiple of the row's fastest, so the eye reads
// two things at once — every cache profile beats cold compute, and which restores
// the network slows. The headline is derived from the same cells (the shared
// scripts/_net-cache-finding.mjs summary), so it cannot name a cost the table does
// not show. Deterministic from the JSON (no hand numbers); missing fields throw.
// SVG + 300-DPI PNG in one step.
//   node scripts/net-cache-chart.mjs

import { readFileSync } from "node:fs";
import { heatChart, emitChart, mdDetails, writeDocBlock } from "./_chartstyle.mjs";
import {
  netCacheSummary,
  netCacheFinding,
  speedupRange,
  roundsToZero,
  cacheMB as mb,
} from "./_net-cache-finding.mjs";

const DATA = JSON.parse(readFileSync("bench/ci-cache-network-bench.json", "utf8"));
const need = (v, what) => {
  if (v === undefined || v === null) throw new Error(`ci-cache-network-bench.json missing ${what}`);
  return v;
};

const secs = (ms) => (ms >= 10000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 1000).toFixed(1)}s`);

// --- columns: cold + each profile, subtitles derived from the JSON's shaping ----
const rateLabel = (rate) => {
  const m = /^(\d+)mbit$/.exec(rate || "");
  if (!m) return rate || "";
  const n = Number(m[1]);
  return n >= 1000 ? `${n / 1000} Gbps` : `${n} Mbps`;
};
const profileSub = (p) =>
  p.rttMs === 0 ? "floor · no network" : `${rateLabel(p.rate)} · ${p.rttMs} ms`;
const COLS = [{ key: "__cold__", head: "cold compute", sub: "no shared cache" }].concat(
  need(DATA.profiles, "profiles").map((p) => ({ key: p.name, head: p.name, sub: profileSub(p) })),
);

const TASK_ORDER = Object.keys(need(DATA.results, "results"));

// --- headline -------------------------------------------------------------------
// The headline is derived from the cells it summarizes: the restore-vs-cold ratio
// range over every cell, and per task what the highest-RTT profile adds over the
// localhost floor (a restore inside the floor's own sample range is not called a cost). The
// title claims every restore beats cold compute, so that is asserted.
const SUMMARY = netCacheSummary(DATA);
if (!(SUMMARY.minSpeedup > 1))
  throw new Error(
    `a restore is not faster than cold compute (min ratio ${SUMMARY.minSpeedup.toFixed(2)}×) — the chart's headline no longer holds; update it to the measured outcome`,
  );
// the committed record's `finding` must be the sentence the derivation produces for
// its own cells (a record written after a failed derivation, or hand-edited, fails here)
if (need(DATA.finding, "finding") !== netCacheFinding(DATA))
  throw new Error(
    "ci-cache-network-bench.json `finding` is not what scripts/_net-cache-finding.mjs derives from the record's cells",
  );
const FAR = SUMMARY.farthest;
const farCost = SUMMARY.tasks
  .map((t) => {
    const p = t.shaped.find((x) => x.name === FAR.name);
    const what = `the ${mb(t.cacheBytes)} ${t.task} restore`;
    if (p.withinSpread) return `leaves ${what} within its floor's sample spread`;
    if (roundsToZero(p.deltaMs)) return `makes no measured difference to ${what}`;
    const d = `${(Math.abs(p.deltaMs) / 1000).toFixed(1)}s`;
    return p.deltaMs > 0 ? `adds ${d} to ${what}` : `takes ${d} off ${what}`;
  })
  .join(" and ");
const TITLE = "Remote cache restore: the network cost the localhost floor hides";
const FINDING = `A shared Turborepo cache beats cold compute on every link tested (${speedupRange(SUMMARY)}); the ${FAR.name} link (${profileSub(FAR)} RTT) ${farCost}.`;
const srcNote = `turbo ${DATA.versions?.turbo ?? "?"}, ${DATA.scale}, restore = median of ${DATA.samples}, ${DATA.env?.cores ?? "?"} cores. RTT = 2× the netem delay. Every restore asserted all-cached from the remote. Cold compute carries no cache.`;

const { svg, md } = heatChart({
  title: TITLE,
  lede: FINDING,
  sections: [
    {
      rowHead: "task, fresh CI runner",
      cols: COLS.map((c) => ({ label: c.head, sub: c.sub })),
      rows: TASK_ORDER.map((task) => {
        const r = DATA.results[task];
        const coldMs = need(r.coldNoRemoteMs, `${task}.coldNoRemoteMs`);
        const cells = COLS.map((c) =>
          c.key === "__cold__"
            ? coldMs
            : need(
                need(r.profiles[c.key], `${task}.profiles.${c.key}`).restoreMs,
                `${task}.profiles.${c.key}.restoreMs`,
              ),
        );
        const best = Math.min(...cells); // the row's fastest (a cache restore)
        return {
          label: task,
          sub: `${mb(need(r.bytesTransferred, `${task}.bytesTransferred`))} cache · ${need(r.totalTasks, `${task}.totalTasks`)} tasks`,
          cells: cells.map((ms) => ({ kind: "ranked", text: secs(ms), mult: ms / best })),
        };
      }),
      source: "bench/ci-cache-network-bench.json",
      note: srcNote,
    },
  ],
  labelW: 190,
  colW: 128,
  aria: `Remote cache restore versus cold compute across network profiles: rows are tasks with their cache size, columns are cold compute plus each shaped restore profile; each cell shows its time and its multiple of the row's fastest. ${FINDING}`,
});
emitChart("cache-network", svg);
writeDocBlock(
  "LIMITS.md",
  "cache-network",
  mdDetails("The chart as a table (fastest in bold)", md),
);
