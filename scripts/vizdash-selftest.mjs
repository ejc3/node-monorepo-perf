#!/usr/bin/env node
// Checks of scripts/vizdash-gen.mjs and of the generated app's data engine.
//
//   node scripts/vizdash-selftest.mjs --app <installed vizdash app> [--scratch <dir>]
//
// Generator: two generations are identical; --next other than the pinned release and a
// missing lockfile are refused; --clean writes into an empty directory it did not make; no generated widget splits by a dimension twice or by one the dashboard is
// scoped to (two seeds, at a size that needs three scope axes).
// Engine (the app's own TypeScript, loaded through a transpiling loader): an unknown
// ?range falls back to the dashboard's default; a truncated breakdown keeps its shares
// at 100% with an "Other" row; a gauge's goal carries the metric's direction; trend and
// spike insights compare partial buckets per day; entity ids do not depend on filters;
// numbers do not depend on the time zone; scopes stay below the whole; table totals
// follow the range; filters carry only applied fields; a repeated ?q does not break
// search.
// Source: browser-only fixes of the template (CSV download, sankey hover, range keys,
// gradient ids, drill-down link filters, the grain shown).
// Exit 0 when every check passes.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

const argv = process.argv.slice(2);
const arg = (k) => {
  const i = argv.indexOf(`--${k}`);
  return i === -1 ? undefined : argv[i + 1];
};
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GEN = join(REPO, "scripts", "vizdash-gen.mjs");
const APP = arg("app") && resolve(arg("app"));
if (!APP) {
  console.error("usage: vizdash-selftest.mjs --app <installed vizdash app> [--scratch <dir>]");
  process.exit(2);
}
// --dump <loader>: print engine output for one fixed query (the time-zone check runs this)
if (arg("dump")) {
  register(pathToFileURL(arg("dump")).href);
  const data = await import(pathToFileURL(join(APP, "src/data/index.ts")).href);
  const m = data.defineMetrics([{ key: "x", label: "X", unit: "count", base: 100 }]).x;
  const ctx = { seed: "tz", filters: data.parseFilters({ range: "90d" }), scope: { a: "b" } };
  console.log(
    JSON.stringify([data.timeseries(ctx, m), data.kpis(ctx, [m]), data.daily(ctx, m, 30)]),
  );
  process.exit(0);
}
const scratch = mkdtempSync(join(arg("scratch") ?? tmpdir(), "vizdash-selftest-"));

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`);
  if (!ok) failed++;
};

const gen = (out, ...args) =>
  spawnSync("node", [GEN, "--out", out, "--clean", ...args], { encoding: "utf8" });
const treeHash = (dir) => {
  const h = createHash("sha256");
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      if (e.name === "monolith.json") continue;
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(join(d, e.name), r);
      else h.update(`${r}\0`).update(readFileSync(join(d, e.name)));
    }
  };
  walk(dir, "");
  return h.digest("hex");
};

try {
  // ---- generator ----------------------------------------------------------------------
  const a = join(scratch, "a");
  const b = join(scratch, "b");
  gen(a, "--dashboards", "120");
  gen(b, "--dashboards", "120");
  check("generation is deterministic", treeHash(a) === treeHash(b));

  const bad = gen(join(scratch, "c"), "--next", "16.5.0");
  check(
    "--next other than the pinned release is refused",
    bad.status === 1 && /pins next/.test(bad.stderr),
    `exit ${bad.status}`,
  );

  // --clean writes into an empty directory it did not create rather than replacing it
  const empty = join(scratch, "empty");
  mkdirSync(empty);
  const inode = statSync(empty).ino;
  gen(empty, "--dashboards", "10");
  check("--clean keeps an empty directory it did not create", statSync(empty).ino === inode);

  // a layout without the lockfile: the generator refuses instead of an unpinned tree
  const bare = join(scratch, "bare");
  mkdirSync(join(bare, "scripts"), { recursive: true });
  cpSync(GEN, join(bare, "scripts", "vizdash-gen.mjs"));
  cpSync(join(REPO, "vizdash"), join(bare, "vizdash"), {
    recursive: true,
    filter: (src) => !src.endsWith("pnpm-lock.yaml"),
  });
  const nolock = spawnSync(
    "node",
    [join(bare, "scripts", "vizdash-gen.mjs"), "--out", join(scratch, "d"), "--clean"],
    { encoding: "utf8" },
  );
  check(
    "a missing lockfile is refused",
    nolock.status === 1 && /pnpm-lock\.yaml is missing/.test(nolock.stderr),
    `exit ${nolock.status}`,
  );

  // 5,000 dashboards need a third scope axis in every area, so some widgets have two
  // scoped dimensions to retarget (e.g. operations' category > carrier > lane sankey)
  const dupes = [];
  for (const seed of ["1", "2"]) {
    const out = join(scratch, `s${seed}`);
    const r = gen(out, "--dashboards", "5000", "--seed", seed);
    if (r.status !== 0) throw new Error(`generation failed: ${r.stderr}`);
    const root = join(out, "src", "dashboards");
    for (const area of readdirSync(root))
      for (const arch of readdirSync(join(root, area)))
        for (const scope of readdirSync(join(root, area, arch))) {
          const dir = join(root, area, arch, scope);
          const scoped = Object.keys(
            JSON.parse(readFileSync(join(dir, "spec.ts"), "utf8").match(/scope: (\{.*\}),/)[1]),
          );
          for (const line of readFileSync(join(dir, "queries.ts"), "utf8").split("\n")) {
            const used = [...line.matchAll(/dimensions\.(\w+)/g)].map((m) => m[1]);
            const twice = used.length !== new Set(used).size;
            const inScope = used.some((d) => scoped.includes(d));
            if (twice || inScope)
              dupes.push(`seed ${seed} ${area}/${arch}/${scope}: ${line.trim()}`);
          }
        }
    rmSync(out, { recursive: true, force: true });
  }
  check(
    "no widget splits by a dimension twice or by a scoped one",
    dupes.length === 0,
    `${dupes.length} widgets, e.g. ${dupes[0]}`,
  );

  // ---- engine -------------------------------------------------------------------------
  // a loader that resolves the app's extensionless and @/ imports and transpiles TS
  const loader = join(scratch, "loader.mjs");
  writeFileSync(
    loader,
    `import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const APP = ${JSON.stringify(APP)};
const ts = createRequire(APP + "/package.json")("typescript");
const exts = [".ts", ".tsx", "/index.ts", "/index.tsx"];
export async function resolve(spec, ctx, next) {
  let base = null;
  if (spec.startsWith("@/")) base = APP + "/src/" + spec.slice(2);
  else if (spec.startsWith(".") && ctx.parentURL?.startsWith("file:") && fileURLToPath(ctx.parentURL).startsWith(APP))
    base = fileURLToPath(new URL(spec, ctx.parentURL));
  if (base && !existsSync(base) || base && !/\\.[cm]?[jt]sx?$/.test(base))
    for (const e of exts) if (existsSync(base + e)) return { url: pathToFileURL(base + e).href, shortCircuit: true };
  if (spec.startsWith("@/")) return { url: pathToFileURL(base).href, shortCircuit: true };
  // bare imports of the app's sources (and of this script) resolve from the app; a
  // package's own imports resolve as usual
  const fromPkg = ctx.parentURL?.includes("/node_modules/");
  if (!fromPkg && !spec.startsWith(".") && !spec.startsWith("node:") && !spec.startsWith("file:"))
  {
    const app = { ...ctx, parentURL: pathToFileURL(APP + "/package.json").href };
    // subpaths without an exports map (next/link) resolve with ".js", as bundlers do
    try {
      return await next(spec, app);
    } catch (e) {
      if (e.code === "ERR_MODULE_NOT_FOUND" && spec.includes("/")) return next(spec + ".js", app);
      throw e;
    }
  }
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  if (!/\\.tsx?$/.test(url)) return next(url, ctx);
  const src = readFileSync(fileURLToPath(url), "utf8");
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: fileURLToPath(url),
  });
  return { format: "module", source: out.outputText, shortCircuit: true };
}
`,
  );
  register(pathToFileURL(loader).href);
  const data = await import(pathToFileURL(join(APP, "src/data/index.ts")).href);
  const insights = await import(pathToFileURL(join(APP, "src/viz/insights/index.tsx")).href);

  // the same numbers in every time zone (gym hosts differ): dump from child processes
  const dumps = ["UTC", "Asia/Tokyo", "America/Los_Angeles"].map((tz) => {
    const r = spawnSync("node", [fileURLToPath(import.meta.url), "--app", APP, "--dump", loader], {
      encoding: "utf8",
      env: { ...process.env, TZ: tz },
    });
    if (r.status !== 0) throw new Error(`dump under TZ=${tz} failed: ${r.stderr}`);
    return r.stdout;
  });
  check(
    "engine output does not depend on the time zone",
    dumps.every((d) => d === dumps[0]),
  );

  const keys = Object.keys(data.parseFilters({ q: "x", page: "2", sort: "a" }))
    .sort()
    .join();
  check(
    "filters carry only fields the app applies",
    keys === "compare,grain,range,region,segment",
    keys,
  );

  // the largest-share scope values: their product times the scoped boost stays below 1
  const share = (dim, v) =>
    data.sliceLevel({ seed: "", filters: data.DEFAULT_FILTERS, scope: { [dim]: v } });
  const top = (dim) =>
    Array.from({ length: 400 }, (_, i) => `v${i}`).reduce((a, b) =>
      share(dim, a) >= share(dim, b) ? a : b,
    );
  const level = data.sliceLevel({
    seed: "",
    filters: data.DEFAULT_FILTERS,
    scope: { a: top("a"), b: top("b") },
  });
  check("a scope is never larger than the whole business", level < 1, level.toFixed(3));

  const f = data.parseFilters({ range: "foo" }, { range: "90d" });
  check("an unknown ?range falls back to the dashboard default", f.range === "90d", f.range);

  const sales = data.defineMetrics([
    { key: "bookings", label: "Bookings", unit: "currency", base: 1000 },
    { key: "opex", label: "Opex", unit: "currency", base: 1000, good: "down" },
  ]);
  const region = data.defineDimension("region", "Region", ["A", "B", "C", "D", "E", "F", "G", "H"]);
  const ctx = { seed: "selftest", filters: data.DEFAULT_FILTERS, scope: { segment: "SMB" } };
  const br = data.breakdown(ctx, sales.bookings, region, { top: 5 });
  const shareSum = br.rows.reduce((s, r) => s + r.share, 0);
  check(
    "a truncated breakdown sums to 100% with an Other row",
    Math.abs(shareSum - 1) < 1e-9 && br.rows.at(-1).key === "other",
    `shares sum to ${shareSum.toFixed(3)}, last row ${br.rows.at(-1).key}`,
  );

  check(
    "a gauge goal carries the metric's direction",
    data.goal(ctx, sales.opex, 1.02).good === "down",
  );

  const week = (date, v, days) => ({ date, s: v, __days: days });
  const ts = {
    // twelve full weeks at 100 a day, then a two-day week at 100 a day
    rows: [
      ...Array.from({ length: 12 }, (_, i) =>
        week(`2026-04-${String(6 + i).padStart(2, "0")}`, 700, 7),
      ),
      week("2026-06-29", 200, 2),
    ],
    series: [{ key: "s", label: "S" }],
    unit: "count",
    agg: "sum",
    grain: "week",
    compare: false,
  };
  const trend = insights.trendInsight("S", ts, "up");
  check("a partial last week is not a drop", trend?.tone === "neutral", trend?.text);
  check("a partial last week is not a spike", insights.spikeInsight("S", ts) === null);

  const entity = data.defineEntity({
    key: "deal",
    label: "Deal",
    plural: "Deals",
    pool: "company",
    statuses: ["Open"],
  });
  const ids = (filters) =>
    data
      .records({ ...ctx, filters }, entity, [sales.bookings], 20)
      .map((r) => r.id)
      .sort()
      .join();
  const sumOf = (range) =>
    data
      .records({ ...ctx, filters: data.parseFilters({ range }) }, entity, [sales.bookings], 20)
      .reduce((s, r) => s + r.values.bookings, 0);
  const ratio = sumOf("12m") / sumOf("7d");
  check("table totals cover the selected range", ratio > 20, `12m / 7d = ${ratio.toFixed(2)}`);

  const search = await import(pathToFileURL(join(APP, "app/search/page.tsx")).href);
  let searchError = null;
  try {
    await search.default({ searchParams: Promise.resolve({ q: ["sales", "x"] }) });
  } catch (e) {
    searchError = e.message;
  }
  check("a repeated ?q does not break search", searchError === null, searchError);

  check(
    "entity ids do not depend on filters",
    ids(data.DEFAULT_FILTERS) === ids(data.parseFilters({ region: "EMEA", range: "7d" })),
  );

  // browser-only behavior, pinned at the source of the template the app was made from
  const src = (rel) => readFileSync(join(APP, rel), "utf8");
  const csv = src("src/viz/hooks/useCsvDownload.ts");
  check(
    "CSV download attaches its anchor and revokes the URL after the click",
    /appendChild\(a\)/.test(csv) && /setTimeout\(\(\) => URL\.revokeObjectURL/.test(csv),
  );
  check(
    "sankey hover does not re-render (and re-lay-out) the chart",
    !/useState/.test(src("src/viz/charts/SankeyChart.tsx")),
  );
  check(
    "area-chart gradient ids are unique per chart",
    /useId\(\)/.test(src("src/viz/charts/AreaChart.tsx")),
  );
  check(
    "drill-down links carry the dashboard filters",
    /useSearchParams\(\)/.test(
      src("src/viz/table/cells.tsx").slice(
        src("src/viz/table/cells.tsx").indexOf("export function LinkCell"),
      ),
    ),
  );
  check(
    "the filter bar shows the grain the server used",
    /effectiveGrain\(/.test(src("src/viz/filters/FilterBar.tsx")),
  );
  check(
    "the filter bar only accepts its own range keys",
    /Object\.hasOwn\(RANGES, asked\)/.test(src("src/viz/filters/FilterBar.tsx")),
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
