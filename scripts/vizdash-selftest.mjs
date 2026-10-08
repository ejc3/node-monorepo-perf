#!/usr/bin/env node
// Checks of scripts/vizdash-gen.mjs and of the app it generates from the current
// template. Packages (and tsc) come from an installed vizdash app; the sources under test
// are always a fresh generation, never that app's own tree.
//
//   node scripts/vizdash-selftest.mjs --app <installed vizdash app> [--scratch <dir>]
//
// Generator: generations are deterministic and complete; --next other than the pinned
// release and a missing lockfile are refused; --clean replaces a signed tree and writes
// into an empty directory it did not make; no widget splits by a dimension twice or by
// one the dashboard is scoped to (at a size that needs three scope axes); package.json
// matches the lockfile; gauges get their direction and target subtitle; the generated
// tree typechecks.
// Engine and pages (TypeScript loaded through a transpiling loader): numbers do not
// depend on the time zone; filters carry only applied fields; a scope stays below the
// whole; an unknown ?range falls back to the dashboard default; a truncated breakdown
// sums to 100% with a marked remainder row, and a real "Other" value is not mistaken for
// it; goals carry the metric's direction; series carry bucket lengths and insights
// compare partial buckets per day; table totals follow the range; entity ids do not
// depend on filters; a repeated ?q does not break search.
// Source: browser-only behavior (CSV download, sankey hover, gradient ids, drill-down
// link filters, the grain and range shown, gauge colors, labels of averages).
// Exit 0 when every check passes.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
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
const PKG = arg("app") && resolve(arg("app"));
if (!PKG || !existsSync(join(PKG, "node_modules", "next"))) {
  console.error("usage: vizdash-selftest.mjs --app <installed vizdash app> [--scratch <dir>]");
  process.exit(2);
}
// --dump <loader> --src <tree>: print engine output for one fixed query (the time-zone
// check runs this in child processes)
if (arg("dump")) {
  register(pathToFileURL(arg("dump")).href);
  const data = await import(pathToFileURL(join(arg("src"), "src/data/index.ts")).href);
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
// a generation that must succeed: exit 0 and a summary
const genOk = (out, ...args) => {
  const r = gen(out, ...args);
  if (r.status !== 0 || !existsSync(join(out, "monolith.json")))
    throw new Error(`vizdash-gen ${args.join(" ")} failed (${r.status}): ${r.stderr}`);
  return JSON.parse(readFileSync(join(out, "monolith.json"), "utf8"));
};
const treeHash = (dir) => {
  const h = createHash("sha256");
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      if (e.name === "monolith.json" || e.name === "node_modules") continue;
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(join(d, e.name), r);
      else h.update(`${r}\0`).update(readFileSync(join(d, e.name)));
    }
  };
  walk(dir, "");
  return h.digest("hex");
};
const dashboardDirs = (tree) => {
  const root = join(tree, "src", "dashboards");
  return readdirSync(root).flatMap((area) =>
    readdirSync(join(root, area)).flatMap((arch) =>
      readdirSync(join(root, area, arch)).map((scope) => join(root, area, arch, scope)),
    ),
  );
};

try {
  // ---- generator ----------------------------------------------------------------------
  const SRC = join(scratch, "a"); // the tree every engine and source check reads
  const b = join(scratch, "b");
  const sa = genOk(SRC, "--dashboards", "120");
  genOk(b, "--dashboards", "120");
  check(
    "generation is deterministic and complete",
    treeHash(SRC) === treeHash(b) && dashboardDirs(SRC).length === sa.dashboards,
  );

  const bad = gen(join(scratch, "c"), "--next", "16.5.0");
  check(
    "--next other than the pinned release is refused",
    bad.status === 1 && /pins next/.test(bad.stderr),
    `exit ${bad.status}`,
  );

  // --clean writes into an empty directory it did not create (same directory, its mode
  // kept) and replaces a tree it signed (no dashboards of the previous generation left)
  const empty = join(scratch, "empty");
  mkdirSync(empty);
  chmodSync(empty, 0o751);
  const before = statSync(empty, { bigint: true });
  genOk(empty, "--dashboards", "10");
  const after = statSync(empty, { bigint: true });
  check(
    "--clean keeps an empty directory it did not create",
    after.ino === before.ino && after.dev === before.dev && (Number(after.mode) & 0o777) === 0o751,
  );
  const s30 = join(scratch, "s30");
  genOk(s30, "--dashboards", "30");
  const s10 = genOk(s30, "--dashboards", "10");
  check(
    "--clean replaces a signed tree",
    dashboardDirs(s30).length === 10 && s10.dashboards === 10,
    `${dashboardDirs(s30).length} dashboard folders`,
  );

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

  // package.json's pins are the lockfile's importer specifiers
  const pkg = JSON.parse(readFileSync(join(SRC, "package.json"), "utf8"));
  const lock = readFileSync(join(SRC, "pnpm-lock.yaml"), "utf8");
  const importer = lock.slice(lock.indexOf("importers:"), lock.indexOf("\npackages:"));
  const specs = Object.fromEntries(
    [...importer.matchAll(/^ {6}'?([^':\n]+)'?:\n {8}specifier: (\S+)/gm)].map((m) => [m[1], m[2]]),
  );
  const pins = { ...pkg.dependencies, ...pkg.devDependencies };
  const off = Object.keys({ ...pins, ...specs }).filter((k) => pins[k] !== specs[k]);
  check("package.json matches the lockfile", off.length === 0, off.join(", "));

  // 5,000 dashboards need a third scope axis in every area, so some widgets have two
  // scoped dimensions to retarget (e.g. operations' category > carrier > lane sankey)
  const dupes = [];
  let observed = 0;
  for (const seed of ["1", "2"]) {
    const out = join(scratch, `s${seed}`);
    genOk(out, "--dashboards", "5000", "--seed", seed);
    for (const dir of dashboardDirs(out)) {
      const scoped = Object.keys(
        JSON.parse(readFileSync(join(dir, "spec.ts"), "utf8").match(/scope: (\{.*\}),/)[1]),
      );
      for (const line of readFileSync(join(dir, "queries.ts"), "utf8").split("\n")) {
        const used = [...line.matchAll(/dimensions\.(\w+)/g)].map((m) => m[1]);
        if (scoped.length === 3 && used.length >= 3) observed++;
        if (used.length !== new Set(used).size || used.some((d) => scoped.includes(d)))
          dupes.push(`seed ${seed} ${dir.split("/dashboards/")[1]}: ${line.trim()}`);
      }
    }
    rmSync(out, { recursive: true, force: true });
  }
  check(
    "no widget splits by a dimension twice or by a scoped one",
    dupes.length === 0 && observed > 0,
    dupes.length ? `${dupes.length} widgets, e.g. ${dupes[0]}` : "no three-stage widget seen",
  );

  const gauges = dashboardDirs(SRC)
    .map((d) => readFileSync(join(d, "Charts.tsx"), "utf8"))
    .flatMap((s) => s.split("\n").filter((l) => l.includes("<GaugeWidget")));
  check(
    "generated gauges pass their direction and name their target",
    gauges.length > 0 &&
      gauges.every((l) => /good=\{data\.\w+\.good\}/.test(l) && /subtitle="Target: /.test(l)),
    `${gauges.length} gauges`,
  );
  check(
    "generated apps ignore *.tsbuildinfo",
    readFileSync(join(SRC, ".gitignore"), "utf8").split("\n").includes("*.tsbuildinfo"),
  );

  // the generated tree typechecks against the installed packages
  symlinkSync(join(PKG, "node_modules"), join(SRC, "node_modules"));
  const tsc = spawnSync(
    "node",
    [
      join(PKG, "node_modules", "typescript", "bin", "tsc"),
      "--noEmit",
      "--incremental",
      "false",
      "-p",
      SRC,
    ],
    { encoding: "utf8" },
  );
  check("the generated tree typechecks", tsc.status === 0, tsc.stdout.split("\n")[0]);

  // ---- engine and pages ---------------------------------------------------------------
  // a loader that resolves the tree's extensionless and @/ imports, transpiles its TS,
  // and resolves bare imports from the installed app's packages
  const loader = join(scratch, "loader.mjs");
  writeFileSync(
    loader,
    `import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const SRC = ${JSON.stringify(SRC)};
const PKG = ${JSON.stringify(PKG)};
const ts = createRequire(PKG + "/package.json")("typescript");
const exts = [".ts", ".tsx", "/index.ts", "/index.tsx"];
export async function resolve(spec, ctx, next) {
  let base = null;
  if (spec.startsWith("@/")) base = SRC + "/src/" + spec.slice(2);
  else if (spec.startsWith(".") && ctx.parentURL?.startsWith("file:") && fileURLToPath(ctx.parentURL).startsWith(SRC + "/"))
    base = fileURLToPath(new URL(spec, ctx.parentURL));
  if (base && (!existsSync(base) || !/\\.[cm]?[jt]sx?$/.test(base)))
    for (const e of exts) if (existsSync(base + e)) return { url: pathToFileURL(base + e).href, shortCircuit: true };
  if (spec.startsWith("@/")) return { url: pathToFileURL(base).href, shortCircuit: true };
  const fromPkg = ctx.parentURL?.includes("/node_modules/");
  if (!fromPkg && !spec.startsWith(".") && !spec.startsWith("node:") && !spec.startsWith("file:")) {
    const app = { ...ctx, parentURL: pathToFileURL(PKG + "/package.json").href };
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
  const data = await import(pathToFileURL(join(SRC, "src/data/index.ts")).href);
  const insights = await import(pathToFileURL(join(SRC, "src/viz/insights/index.tsx")).href);

  // the same numbers in every time zone (gym hosts differ): dump from child processes
  const dumps = ["UTC", "Asia/Tokyo", "America/Los_Angeles"].map((tz) => {
    const r = spawnSync(
      "node",
      [fileURLToPath(import.meta.url), "--app", PKG, "--dump", loader, "--src", SRC],
      { encoding: "utf8", env: { ...process.env, TZ: tz } },
    );
    if (r.status !== 0) throw new Error(`dump under TZ=${tz} failed: ${r.stderr}`);
    return r.stdout;
  });
  check(
    "engine output does not depend on the time zone",
    dumps[0].length > 100 && dumps.every((d) => d === dumps[0]),
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
  const region = data.defineDimension("region", "Region", [
    "A",
    "B",
    "C",
    "D",
    "E",
    "F",
    "G",
    "Other",
  ]);
  const ctx = { seed: "selftest", filters: data.DEFAULT_FILTERS, scope: { segment: "SMB" } };
  const br = data.breakdown(ctx, sales.bookings, region, { top: 5 });
  const shareSum = br.rows.reduce((s, r) => s + r.share, 0);
  const last = br.rows.at(-1);
  check(
    "a truncated breakdown sums to 100% with a marked remainder row",
    Math.abs(shareSum - 1) < 1e-9 &&
      last.remainder === true &&
      new Set(br.rows.map((r) => r.key)).size === br.rows.length,
    `shares sum to ${shareSum.toFixed(3)}, last row ${last.key}`,
  );
  // a dimension value called "Other" is data, not the remainder
  const withOther = {
    rows: [
      { key: "other", label: "Other", value: 300, share: 0.5, delta: 0.3 },
      { key: "a", label: "A", value: 100, share: 0.17, delta: 0.1 },
      { key: "__rest", label: "Other (3)", value: 200, share: 0.33, delta: 0.9, remainder: true },
    ],
    unit: "count",
    total: 600,
    agg: "sum",
  };
  const leader = insights.leaderInsight("x", withOther)?.text ?? "";
  const mover = insights.moverInsight("x", withOther)?.text ?? "";
  check(
    'a real "Other" value is not mistaken for the remainder',
    leader.startsWith("Other leads") && /: Other \(\+30\.0%/.test(mover),
    `${leader} | ${mover}`,
  );

  check(
    "a gauge goal carries the metric's direction",
    data.goal(ctx, sales.opex, 1.02).good === "down",
  );

  const series = data.timeseries(
    { ...ctx, filters: data.parseFilters({ range: "90d" }) },
    sales.bookings,
  );
  check(
    "series rows carry their bucket length",
    series.rows.every((r) => r.__days >= 1 && r.__days <= 7) && series.rows.at(-1).__days < 7,
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
  const sumOf = (range) =>
    data
      .records({ ...ctx, filters: data.parseFilters({ range }) }, entity, [sales.bookings], 20)
      .reduce((s, r) => s + r.values.bookings, 0);
  const ratio = sumOf("12m") / sumOf("7d");
  check("table totals cover the selected range", ratio > 20, `12m / 7d = ${ratio.toFixed(2)}`);

  const ids = (filters) =>
    data
      .records({ ...ctx, filters }, entity, [sales.bookings], 20)
      .map((r) => r.id)
      .sort()
      .join();
  check(
    "entity ids do not depend on filters",
    ids(data.DEFAULT_FILTERS) === ids(data.parseFilters({ region: "EMEA", range: "7d" })),
  );

  const search = await import(pathToFileURL(join(SRC, "app/search/page.tsx")).href);
  let searchError = null;
  try {
    await search.default({ searchParams: Promise.resolve({ q: ["sales", "x"] }) });
  } catch (e) {
    searchError = e.message;
  }
  check("a repeated ?q does not break search", searchError === null, searchError);

  // ---- browser-only behavior, pinned at the source ------------------------------------
  const src = (rel) => readFileSync(join(SRC, rel), "utf8");
  const csv = src("src/viz/hooks/useCsvDownload.ts");
  check(
    "CSV download attaches its anchor and revokes the URL after the click",
    /appendChild\(a\);\s*a\.click\(\);\s*a\.remove\(\);/.test(csv) &&
      /setTimeout\(\(\) => URL\.revokeObjectURL\(url\)/.test(csv),
  );
  const sankey = src("src/viz/charts/SankeyChart.tsx");
  const css = src("app/globals.css");
  check(
    "sankey links highlight on link hover, in CSS, without re-rendering",
    !/useState/.test(sankey) &&
      /className="sankey"/.test(sankey) &&
      /className="sankey__link"/.test(sankey) &&
      /\.sankey:has\(\.sankey__link:hover\) \.sankey__link \{\s*stroke-opacity: 0\.12/.test(css) &&
      /\.sankey \.sankey__link:hover \{\s*stroke-opacity: 0\.7/.test(css),
  );
  const area = src("src/viz/charts/AreaChart.tsx");
  check(
    "area-chart gradient ids are unique per chart",
    /const uid = useId\(\)/.test(area) &&
      /`area-fill-\$\{uid\}-\$\{i\}`/.test(area) &&
      /fill=\{`url\(#\$\{id\(i\)\}\)`\}/.test(area),
  );
  const cells = src("src/viz/table/cells.tsx");
  const linkCell = cells.slice(cells.indexOf("export function LinkCell"));
  check(
    "drill-down links carry the dashboard filters",
    /useSearchParams\(\)/.test(linkCell) &&
      /href=\{qs \? `\$\{href\}\?\$\{qs\}` : href\}/.test(linkCell),
  );
  const bar = src("src/viz/filters/FilterBar.tsx");
  check(
    "the filter bar shows the grain the server used",
    /effectiveGrain\(range, askedGrain as Grain\)/.test(bar) &&
      /<GrainSelect value=\{shownGrain\}/.test(bar),
  );
  check(
    "the filter bar only accepts its own range keys",
    /Object\.hasOwn\(RANGES, asked\)/.test(bar),
  );
  check(
    "gauges color by the metric's direction",
    /good === "up" \? value >= target : value <= target/.test(src("src/viz/charts/Gauge.tsx")),
  );
  check(
    "averages are labeled overall, not total",
    /data\.agg === "sum" \? "total" : "overall"/.test(src("src/viz/widgets/BreakdownWidget.tsx")) &&
      /"Overall"/.test(src("src/viz/charts/DonutChart.tsx")),
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
