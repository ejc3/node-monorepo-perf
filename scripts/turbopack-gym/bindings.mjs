// Native bindings live in an immutable, content-addressed store:
//
//   $GYM_ROOT/bindings/.store/<sha of the .node>/{next-swc.<triple>.node, candidate.diff, source.json}
//   $GYM_ROOT/bindings/<name> -> .store/<sha>        (a symlink, replaced by rename())
//
// A store directory is written once and never changed, and a name moves to new code
// only by an atomic symlink flip, so a run that resolves a name once holds code that
// cannot change under it. resolveBinding re-hashes the module against its store name.

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { BINDINGS, BINDING_FILE, ensureDir } from "./lib.mjs";

export const STORE = join(BINDINGS, ".store");
export const sha16 = (data) => createHash("sha256").update(data).digest("hex").slice(0, 16);
let seq = 0;

// Point `name` at store entry `id` atomically.
function flip(name, id) {
  const link = join(BINDINGS, name);
  // a binding directory from before the store cannot be replaced by rename(): move it
  // into the store first
  if (existsSync(link) && !lstatSync(link).isSymbolicLink()) {
    const moved = join(BINDINGS, `.${name}.migrate-${process.pid}-${seq++}`);
    renameSync(link, moved);
    if (existsSync(join(moved, BINDING_FILE))) storeDir(moved);
    else rmSync(moved, { recursive: true, force: true });
  }
  const tmp = join(BINDINGS, `.${name}.link-${process.pid}-${seq++}`);
  symlinkSync(join(".store", id), tmp);
  renameSync(tmp, link);
}

// Move a directory of binding files into the store under its module's hash.
export function storeDir(dir) {
  const id = sha16(readFileSync(join(dir, BINDING_FILE)));
  ensureDir(STORE);
  const dest = join(STORE, id);
  if (existsSync(dest)) rmSync(dir, { recursive: true, force: true });
  else renameSync(dir, dest);
  return id;
}

// Install freshly built files (a directory) as binding `name`.
export function installBinding(name, dir) {
  const id = storeDir(dir);
  flip(name, id);
  return id;
}

// The immutable store directory `name` points to now, verified: the module's hash
// must equal the store name. A legacy plain directory is moved into the store first.
export function resolveBinding(name) {
  const link = join(BINDINGS, name);
  if (!existsSync(link)) throw new Error(`no binding ${name} in ${BINDINGS}`);
  if (!lstatSync(link).isSymbolicLink()) {
    // a binding directory from before the store: hand it over (one-time)
    const moved = join(BINDINGS, `.${name}.migrate-${process.pid}-${seq++}`);
    renameSync(link, moved);
    const id = storeDir(moved);
    flip(name, id);
  }
  const id = readlinkSync(link).split("/").at(-1);
  const dir = join(STORE, id);
  const nodeSha = sha16(readFileSync(join(dir, BINDING_FILE)));
  if (nodeSha !== id)
    throw new Error(`binding ${name}: module hash ${nodeSha} is not its store id ${id}`);
  const src = join(dir, "source.json");
  const diff = join(dir, "candidate.diff");
  return {
    id,
    dir,
    source: {
      head: existsSync(src) ? JSON.parse(readFileSync(src, "utf8")).head : null,
      diffSha256: sha16(existsSync(diff) ? readFileSync(diff) : Buffer.alloc(0)),
      nodeSha256: nodeSha,
    },
  };
}

// For hosts.sync: the remote commands that install store entry `id` as `name`
// once its files are in place (atomic flip; a legacy directory is removed first).
export function remoteFlipCommand(root, name, id) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const link = `${root}/bindings/${name}`;
  const tmp = `${root}/bindings/.${name}.link-${process.pid}-${Date.now()}`;
  return [
    `if [ -d ${q(link)} ] && [ ! -L ${q(link)} ]; then rm -rf ${q(link)}; fi`,
    `ln -sfn ${q(`.store/${id}`)} ${q(tmp)}`,
    `mv -T ${q(tmp)} ${q(link)}`,
  ].join(" && ");
}

// Re-hash a resolved binding's module against its store id (before every run).
export function verifyResolved(r) {
  const got = sha16(readFileSync(join(r.dir, BINDING_FILE)));
  if (got !== r.id) throw new Error(`binding store ${r.dir}: module hash ${got} is not ${r.id}`);
  return r;
}
