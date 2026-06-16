#!/usr/bin/env bash
# Per-app-workspace model, materialized live on AWS CodeArtifact (@ejc3).
#
# One repo, no app-spanning workspace. Each app is its OWN pnpm workspace root
# (own pnpm-workspace.yaml + own lockfile + own pnpm.overrides). This proves the
# two things a single shared root CANNOT do per-app:
#
#  (1) pnpm rewrites a `workspace:^` internal dep to a real range (^<ver>) when it
#      packs/publishes @ejc3/ui — the mechanic the diamond demo asserts but never
#      runs (its libs ship plain semver). Proven fresh each run via `pnpm pack`
#      (local, no registry write).
#
#  (2) Per-app divergence on a TRANSITIVE dep. Both apps pin @ejc3/ui at the SAME
#      version; @ejc3/util is named by NEITHER (it is ui's transitive dep). web's
#      OWN ROOT carries `pnpm.overrides {"@ejc3/util":"workspace:*"}`; admin's does
#      not. So web resolves the transitive util to LOCAL source and admin to the
#      REGISTRY copy. diamond-demo.sh §4 showed this same override in ONE shared
#      root moves EVERY consumer; here it is in web's root only, so admin is
#      untouched — possible only because each app is its own root.
#
# Published copies carry SOURCE="registry@1.0.0"; the local copy carries
# SOURCE="workspace-local", and @ejc3/ui re-exports the util SOURCE it resolved.
# Every claim is ASSERTED (hard fail on mismatch). Self-cleaning: each run
# pre-deletes any leftover version, publishes @ejc3/util + @ejc3/ui fresh (so the
# proof uses THIS run's bytes), and deletes them again on exit. Local scratch under
# examples/per-app-workspace (gitignored); touches no bench/*.json.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/examples/per-app-workspace"
DOMAIN=ejc3; OWNER=928413605543; REPO=npm; REGION=us-west-2
EP="https://${DOMAIN}-${OWNER}.d.codeartifact.${REGION}.amazonaws.com/npm/${REPO}/"
HOST="${DOMAIN}-${OWNER}.d.codeartifact.${REGION}.amazonaws.com/npm/${REPO}/"
PNPM_VER="$(pnpm --version)"
VER="1.0.0"   # fixed; pre-deleted then published fresh each run, deleted on exit

del_all_versions() { # pkg — best-effort delete of EVERY published version of @ejc3/<pkg>
  # (demo-owned throwaway), so a stray 1.0.x can't satisfy ui's ^1.0.0 past the exact assert.
  # Distinguishes "not published yet" (fine, silent) from a real list/delete failure (warns).
  local vers
  if ! vers=$(aws codeartifact list-package-versions --domain "$DOMAIN" --domain-owner "$OWNER" \
      --repository "$REPO" --region "$REGION" --format npm --namespace "$DOMAIN" \
      --package "$1" --query 'versions[].version' --output text 2>/tmp/dav-err.log); then
    grep -q ResourceNotFoundException /tmp/dav-err.log \
      || echo "WARN: could not list @ejc3/$1 versions: $(tail -1 /tmp/dav-err.log)" >&2
    return 0
  fi
  [ -n "$vers" ] || return 0
  # shellcheck disable=SC2086  # word-split the version list into separate --versions args
  aws codeartifact delete-package-versions --domain "$DOMAIN" --domain-owner "$OWNER" \
    --repository "$REPO" --region "$REGION" --format npm --namespace "$DOMAIN" \
    --package "$1" --versions $vers >/dev/null 2>&1 \
    || echo "WARN: could not delete @ejc3/$1 versions; remove manually" >&2
  return 0
}
cleanup() {
  for p in util ui; do del_all_versions "$p"; done
  rm -rf "$DIR"
}
trap cleanup EXIT
rm -rf "$DIR"

assert_eq() { # assert_eq "<label>" "<actual>" "<expected>"
  if [ "$2" != "$3" ]; then
    echo "ASSERT FAILED: $1" >&2; echo "  expected: $3" >&2; echo "  actual:   $2" >&2; exit 1
  fi
  echo "   ok  $1"
}
norm() { printf '%s' "$1" | tr -d '[:space:]'; }

echo "════════ auth to CodeArtifact (@ejc3) ════════"
TOKEN=$(aws codeartifact get-authorization-token --domain "$DOMAIN" --domain-owner "$OWNER" --region "$REGION" --query authorizationToken --output text)
AUTH=$(printf '@ejc3:registry=%s\n//%s:_authToken=%s\n//%s:always-auth=true\n' "$EP" "$HOST" "$TOKEN" "$HOST")

# ─────────────────────────────────────────────────────────────────────────────
# Part 1 — the libs workspace. publish-src is a libs-only pnpm workspace
# (packages: ["libs/*"]); @ejc3/ui declares @ejc3/util as "workspace:^".
# ─────────────────────────────────────────────────────────────────────────────
PUB="$DIR/publish-src"
mkdir -p "$PUB/libs/util" "$PUB/libs/ui"
printf 'packages:\n  - "libs/*"\n' > "$PUB/pnpm-workspace.yaml"
printf '%s\n' "$AUTH" > "$PUB/.npmrc"
printf '{ "name": "publish-src", "private": true, "packageManager": "pnpm@%s" }\n' "$PNPM_VER" > "$PUB/package.json"
printf '{ "name": "@ejc3/util", "version": "%s", "main": "index.js" }\n' "$VER" > "$PUB/libs/util/package.json"
printf 'module.exports = { SOURCE: "registry@%s" };\n' "$VER" > "$PUB/libs/util/index.js"
printf '{ "name": "@ejc3/ui", "version": "%s", "main": "index.js", "dependencies": { "@ejc3/util": "workspace:^" } }\n' "$VER" > "$PUB/libs/ui/package.json"
printf 'module.exports = { SOURCE: "registry@%s", util: require("@ejc3/util").SOURCE };\n' "$VER" > "$PUB/libs/ui/index.js"
( cd "$PUB" && pnpm install --config.confirm-modules-purge=false >/tmp/per-app-pub-install.log 2>&1 )

echo "════════ 1a. pnpm pack @ejc3/ui → prove the workspace:^ rewrite (no registry write) ════════"
( cd "$PUB/libs/ui" && pnpm pack >/tmp/per-app-pack.log 2>&1 ) || { echo "pnpm pack failed:" >&2; tail -8 /tmp/per-app-pack.log >&2; exit 1; }
TGZ="$PUB/libs/ui/ejc3-ui-$VER.tgz"   # pnpm pack names scoped tarballs <scope>-<name>-<ver>.tgz
[ -f "$TGZ" ] || { echo "expected tarball not found: $TGZ" >&2; ls "$PUB"/libs/ui/ >&2; exit 1; }
tar -xzf "$TGZ" -C "$PUB" package/package.json
PACKED=$(norm "$(node -p "JSON.stringify(require('$PUB/package/package.json').dependencies)")")
echo "   source spec: \"@ejc3/util\": \"workspace:^\"   ->   packed: $PACKED"
assert_eq "pnpm pack rewrote workspace:^ to ^$VER" "$PACKED" "{\"@ejc3/util\":\"^$VER\"}"

echo "════════ 1b. publish @ejc3/util + @ejc3/ui fresh (deleted on exit) ════════"
pubone() {
  del_all_versions "$1"   # clear every leftover so we publish THIS run's bytes only
  ( cd "$PUB/libs/$1" && pnpm publish --no-git-checks >/tmp/per-app-pub.log 2>&1 ) \
    || { echo "PUBLISH FAILED (@ejc3/$1@$VER):" >&2; tail -6 /tmp/per-app-pub.log >&2; exit 1; }
  echo "   published @ejc3/$1@$VER"
}
pubone util
pubone ui

# ─────────────────────────────────────────────────────────────────────────────
# Part 2 — two sibling app workspaces. BOTH pin @ejc3/ui at the SAME version.
# @ejc3/util is named by neither. web's OWN ROOT adds pnpm.overrides
# {"@ejc3/util":"workspace:*"} and hosts the local util (SOURCE="workspace-local")
# as a member; admin's root has neither. The repo root is a libs-only workspace;
# each app's own pnpm-workspace.yaml shadows it on install.
# ─────────────────────────────────────────────────────────────────────────────
mkdir -p "$DIR/libs/util" "$DIR/apps/web" "$DIR/apps/admin"
printf 'packages:\n  - "libs/*"\n' > "$DIR/pnpm-workspace.yaml"
printf '%s\n' "$AUTH" > "$DIR/.npmrc"
printf '{ "name": "per-app-libs", "private": true, "packageManager": "pnpm@%s" }\n' "$PNPM_VER" > "$DIR/package.json"
printf '{ "name": "@ejc3/util", "version": "%s", "main": "index.js" }\n' "$VER" > "$DIR/libs/util/package.json"
printf 'module.exports = { SOURCE: "workspace-local" };\n' > "$DIR/libs/util/index.js"

printf 'packages:\n  - "."\n  - "../../libs/util"\n' > "$DIR/apps/web/pnpm-workspace.yaml"
printf 'link-workspace-packages=false\n%s\n' "$AUTH" > "$DIR/apps/web/.npmrc"
printf '{ "name": "web", "private": true, "packageManager": "pnpm@%s", "dependencies": { "@ejc3/ui": "%s" }, "pnpm": { "overrides": { "@ejc3/util": "workspace:*" } } }\n' "$PNPM_VER" "$VER" > "$DIR/apps/web/package.json"

printf 'packages:\n  - "."\n' > "$DIR/apps/admin/pnpm-workspace.yaml"
printf 'link-workspace-packages=false\n%s\n' "$AUTH" > "$DIR/apps/admin/.npmrc"
printf '{ "name": "admin", "private": true, "packageManager": "pnpm@%s", "dependencies": { "@ejc3/ui": "%s" } }\n' "$PNPM_VER" "$VER" > "$DIR/apps/admin/package.json"

echo "════════ 2. two sibling app workspaces (identical \"@ejc3/ui\": \"$VER\") → two installs ════════"
( cd "$DIR/apps/web"   && pnpm install --config.confirm-modules-purge=false >/tmp/per-app-web.log   2>&1 ) || { echo "web install failed:" >&2; tail -8 /tmp/per-app-web.log >&2; exit 1; }; echo "   web   installed (own pnpm-lock.yaml)"
( cd "$DIR/apps/admin" && pnpm install --config.confirm-modules-purge=false >/tmp/per-app-admin.log 2>&1 ) || { echo "admin install failed:" >&2; tail -8 /tmp/per-app-admin.log >&2; exit 1; }; echo "   admin installed (own pnpm-lock.yaml)"

# ─────────────────────────────────────────────────────────────────────────────
# Part 3 — inspect + assert. require("@ejc3/ui") returns its own SOURCE plus the
# SOURCE of the util it resolved; that util field is the transitive-divergence
# proof. utilpath() shows where util physically resolved, as ui sees it.
# ─────────────────────────────────────────────────────────────────────────────
appui()    { cd "$DIR/apps/$1" && node -p "JSON.stringify(require('@ejc3/ui'))" 2>/dev/null || echo '{"error":"UNRESOLVED"}'; }
utilpath() { ( cd "$DIR/apps/$1" && node -e "const u=require('path').dirname(require.resolve('@ejc3/ui/package.json')); console.log(require.resolve('@ejc3/util',{paths:[u]}))" 2>/dev/null ) | sed "s#$DIR/##" || echo "UNRESOLVED"; }
# guard the thesis: each app must name @ejc3/ui and NOT @ejc3/util as a direct dep,
# so util is genuinely transitive (not the trivial direct case §5 calls trivial).
assert_transitive() { # app
  if node -e "const d=Object.keys((require('$DIR/apps/$1/package.json').dependencies)||{}); process.exit(d.includes('@ejc3/util') ? 1 : (d.includes('@ejc3/ui') ? 0 : 2))"; then
    echo "   ok  $1 names @ejc3/ui directly and @ejc3/util not at all (util is transitive)"
  else
    echo "ASSERT FAILED: $1 must depend on @ejc3/ui directly and @ejc3/util only transitively" >&2; exit 1
  fi
}

echo "════════ 3. per-app resolution (both pin @ejc3/ui; neither names @ejc3/util) ════════"
assert_transitive web
assert_transitive admin
WEB=$(appui web); ADMIN=$(appui admin)
printf '   web    require("@ejc3/ui") = %s\n' "$WEB"
printf '          @ejc3/util resolves at: %s\n' "$(utilpath web)"
printf '   admin  require("@ejc3/ui") = %s\n' "$ADMIN"
printf '          @ejc3/util resolves at: %s\n' "$(utilpath admin)"
echo
# fresh publish + clean registry → @ejc3/util resolves to exactly registry@$VER in admin
assert_eq "web: registry ui, transitive util redirected to LOCAL by web's own root override" \
  "$(norm "$WEB")" "{\"SOURCE\":\"registry@$VER\",\"util\":\"workspace-local\"}"
assert_eq "admin: registry ui, transitive util from the registry (no override)" \
  "$(norm "$ADMIN")" "{\"SOURCE\":\"registry@$VER\",\"util\":\"registry@$VER\"}"
echo
echo "   web   pnpm-lock.yaml: $(wc -l < "$DIR/apps/web/pnpm-lock.yaml") lines"
echo "   admin pnpm-lock.yaml: $(wc -l < "$DIR/apps/admin/pnpm-lock.yaml") lines   (distinct files)"
echo
echo "   Proven: both apps pin @ejc3/ui at the same version, yet the transitive"
echo "   @ejc3/util — named by neither — is local in web and from the registry in"
echo "   admin, because web's OWN ROOT carries the override and admin's does not."
echo "   One shared root has a single overrides block (diamond-demo §4), so it"
echo "   cannot make this per-app; separate workspace roots can."
echo
echo "(cleanup deletes @ejc3/util@$VER + @ejc3/ui@$VER from the registry and removes local scratch)"
