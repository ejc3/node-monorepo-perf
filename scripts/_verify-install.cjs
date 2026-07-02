// Install-completeness verifier — the ONE copy of the contract both install benches
// gate on: every app and lib under <root>/apps and <root>/packages must resolve all its
// declared dependencies AND devDependencies (a partial/prod-mode install that dropped
// typescript/types must fail). Two layout modes:
//   nm  — walk node_modules upward from each package, stopping at <root> (an ambient
//         parent node_modules must not satisfy verification)
//   pnp — resolve every edge through <root>/.pnp.cjs (resolveToUnqualified; virtual
//         paths mapped back via resolveVirtual since they never exist literally on
//         disk; a null resolution — a Node-builtin name — fails closed), and the
//         resolved target must be an on-disk, NON-EMPTY zip or a real directory
//
// CJS so it can be require()d by a container-side runner AND spawned as a CLI by the
// host benches:  node _verify-install.cjs <root> <nm|pnp>   → prints "EDGES <n>",
// exits 1 with the missing list on stderr.

const { readFileSync, readdirSync, existsSync, statSync } = require("fs");
const { join, dirname } = require("path");

function collectEdges(root) {
  const edges = [];
  for (const group of ["apps", "packages"]) {
    const g = join(root, group);
    if (!existsSync(g)) continue;
    for (const name of readdirSync(g)) {
      const pkgDir = join(g, name);
      if (!existsSync(join(pkgDir, "package.json"))) continue;
      const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
      for (const dep of [
        ...Object.keys(pkg.dependencies || {}),
        ...Object.keys(pkg.devDependencies || {}),
      ])
        edges.push([pkgDir, dep]);
    }
  }
  // an empty walk would let every verifier pass vacuously — that is a wrong tree,
  // never a verified install
  if (edges.length === 0)
    throw new Error(`collectEdges found no dependency edges under ${root} — wrong/missing tree`);
  return edges;
}

function verifyNm(root) {
  const edges = collectEdges(root);
  const resolves = (dir, dep) => {
    let d = dir;
    for (;;) {
      if (existsSync(join(d, "node_modules", dep, "package.json"))) return true;
      if (d === root) return false;
      const u = dirname(d);
      if (u === d) return false;
      d = u;
    }
  };
  const missing = [];
  for (const [pkgDir, dep] of edges) {
    if (!resolves(pkgDir, dep) && missing.length < 10) missing.push(`${pkgDir} -> ${dep}`);
  }
  if (missing.length)
    throw new Error(`INCOMPLETE install, unresolved deps:\n${missing.join("\n")}`);
  return edges.length;
}

function verifyPnp(root) {
  const pnpFile = join(root, ".pnp.cjs");
  if (!existsSync(pnpFile)) throw new Error("PnP install left no .pnp.cjs — nothing to verify");
  const pnp = require(pnpFile);
  const edges = collectEdges(root);
  const missing = [];
  for (const [pkgDir, dep] of edges) {
    try {
      const loc = pnp.resolveToUnqualified(dep, pkgDir + "/");
      if (loc === null) throw new Error("resolved to null (Node-builtin name?)");
      const phys = typeof pnp.resolveVirtual === "function" ? pnp.resolveVirtual(loc) || loc : loc;
      const zi = phys.indexOf(".zip/");
      const target = zi === -1 ? phys : phys.slice(0, zi + 4);
      if (!existsSync(target)) throw new Error("resolved target missing on disk: " + target);
      if (zi !== -1 && statSync(target).size === 0)
        throw new Error("cache zip is empty: " + target);
    } catch (e) {
      if (missing.length < 10)
        missing.push(`${pkgDir} -> ${dep} (${String(e.message || e).slice(0, 120)})`);
    }
  }
  if (missing.length)
    throw new Error(`INCOMPLETE PnP install, unresolved deps:\n${missing.join("\n")}`);
  return edges.length;
}

module.exports = { collectEdges, verifyNm, verifyPnp };

if (require.main === module) {
  const [root, mode] = process.argv.slice(2);
  if (!root || !["nm", "pnp"].includes(mode)) {
    console.error("usage: node _verify-install.cjs <root> <nm|pnp>");
    process.exit(2);
  }
  try {
    const edges = (mode === "nm" ? verifyNm : verifyPnp)(root);
    console.log(`EDGES ${edges}`);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}
