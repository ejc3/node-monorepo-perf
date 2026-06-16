#!/usr/bin/env bash
# Show — on the real AWS CodeArtifact (@ejc3) — how an app resolves an internal lib
# that exists BOTH published to the private registry AND in the workspace, under
# three specs. The published copy and the workspace copy carry different SOURCE
# markers, so the resolved source is provable, and each case is ASSERTED (hard fail
# on mismatch), not just printed:
#   a) pinned semver "1.0.0"                  -> resolves the PUBLISHED (registry) copy
#   b) pinned semver + root override ws:*      -> resolves the LOCAL workspace copy
#   c) "workspace:*"                           -> resolves the LOCAL workspace copy
# Self-cleaning: each run pre-deletes any leftover, publishes @ejc3/reslib fresh
# (so the proof uses THIS run's bytes), and deletes it again on exit. Local scratch
# under examples/resolution (gitignored); touches no bench/*.json.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/examples/resolution"
DOMAIN=ejc3; OWNER=928413605543; REPO=npm; REGION=us-west-2
EP="https://${DOMAIN}-${OWNER}.d.codeartifact.${REGION}.amazonaws.com/npm/${REPO}/"
HOST="${DOMAIN}-${OWNER}.d.codeartifact.${REGION}.amazonaws.com/npm/${REPO}/"
PNPM_VER="$(pnpm --version)"
VER="1.0.0"   # fixed; pre-deleted then published fresh each run, deleted on exit

del_all_versions() { # pkg — best-effort delete of EVERY published version of @ejc3/<pkg>
  # (demo-owned throwaway), so the registry holds only this run's 1.0.0. Distinguishes
  # "not published yet" (fine, silent) from a real list/delete failure (warns).
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
cleanup() { del_all_versions reslib; rm -rf "$DIR"; }
trap cleanup EXIT
rm -rf "$DIR"; mkdir -p "$DIR/published" "$DIR/ws/packages/reslib" "$DIR/ws/apps/web"

assert_eq() { # assert_eq "<label>" "<actual>" "<expected>"
  if [ "$2" != "$3" ]; then
    echo "ASSERT FAILED: $1" >&2; echo "  expected: $3" >&2; echo "  actual:   $2" >&2; exit 1
  fi
  echo "   ok  $1"
}

echo "== auth to CodeArtifact (@ejc3) =="
TOKEN=$(aws codeartifact get-authorization-token --domain "$DOMAIN" --domain-owner "$OWNER" --region "$REGION" --query authorizationToken --output text)
AUTH=$(printf '@ejc3:registry=%s\n//%s:_authToken=%s\n//%s:always-auth=true\n' "$EP" "$HOST" "$TOKEN" "$HOST")

echo "== publish @ejc3/reslib@$VER fresh (SOURCE=registry@$VER; deleted on exit) =="
printf '{ "name": "@ejc3/reslib", "version": "%s", "main": "index.js" }\n' "$VER" > "$DIR/published/package.json"
printf 'module.exports = { SOURCE: "registry@%s" };\n' "$VER" > "$DIR/published/index.js"
printf '%s\n' "$AUTH" > "$DIR/published/.npmrc"
del_all_versions reslib   # clear every leftover so we publish THIS run's bytes only
( cd "$DIR/published" && npm publish --userconfig .npmrc >/tmp/reslib-pub.log 2>&1 ) \
  || { echo "PUBLISH FAILED (@ejc3/reslib@$VER):"; tail -6 /tmp/reslib-pub.log; exit 1; }
echo "   published."

echo "== workspace with a LOCAL @ejc3/reslib (same name+version, SOURCE=workspace-local) + app 'web' =="
printf 'packages:\n  - "apps/*"\n  - "packages/*"\n' > "$DIR/ws/pnpm-workspace.yaml"
printf '{ "name": "@ejc3/reslib", "version": "%s", "main": "index.js" }\n' "$VER" > "$DIR/ws/packages/reslib/package.json"
printf 'module.exports = { SOURCE: "workspace-local" };\n' > "$DIR/ws/packages/reslib/index.js"
# scoped @ejc3 → CodeArtifact, and link-workspace-packages=false so a plain semver
# resolves from the registry (the §1 "gate"), not the local workspace copy.
printf 'link-workspace-packages=false\n%s\n' "$AUTH" > "$DIR/ws/.npmrc"

# write the app manifest with a given @ejc3/reslib spec; root with optional override
app() { printf '{ "name": "web", "private": true, "dependencies": { "@ejc3/reslib": "%s" } }\n' "$1" > "$DIR/ws/apps/web/package.json"; }
root() { printf '%s\n' "$1" > "$DIR/ws/package.json"; }
ROOT_PLAIN=$(printf '{ "name": "reslib-demo", "private": true, "packageManager": "pnpm@%s" }' "$PNPM_VER")
ROOT_OVERRIDE=$(printf '{ "name": "reslib-demo", "private": true, "packageManager": "pnpm@%s", "pnpm": { "overrides": { "@ejc3/reslib": "workspace:*" } } }' "$PNPM_VER")
reinstall() { find "$DIR/ws" -name node_modules -type d -prune -exec rm -rf {} + 2>/dev/null || true; rm -f "$DIR/ws/pnpm-lock.yaml"; ( cd "$DIR/ws" && pnpm install --config.confirm-modules-purge=false >/tmp/reslib-install.log 2>&1 ); }
resolved() { cd "$DIR/ws/apps/web" && node -p "require('@ejc3/reslib').SOURCE" 2>/dev/null || echo "UNRESOLVED"; }
showlink() { ( cd "$DIR/ws/apps/web/node_modules/@ejc3" 2>/dev/null && readlink reslib 2>/dev/null | sed "s#.*/node_modules/##" || echo "real-dir" ); }

echo; echo "== case a: app pins \"@ejc3/reslib\": \"$VER\" (plain semver) =="
app "$VER"; root "$ROOT_PLAIN"; reinstall
A=$(resolved); printf '   SOURCE = %-22s | node_modules/@ejc3/reslib -> %s\n' "$A" "$(showlink)"
assert_eq "case a: plain semver resolves the registry copy" "$A" "registry@$VER"

echo; echo "== case b: same pin + root pnpm.overrides \"@ejc3/reslib\": \"workspace:*\" =="
app "$VER"; root "$ROOT_OVERRIDE"; reinstall
B=$(resolved); printf '   SOURCE = %-22s | node_modules/@ejc3/reslib -> %s\n' "$B" "$(showlink)"
assert_eq "case b: pin + override resolves the local workspace copy" "$B" "workspace-local"

echo; echo "== case c: app declares \"@ejc3/reslib\": \"workspace:*\" =="
app "workspace:*"; root "$ROOT_PLAIN"; reinstall
C=$(resolved); printf '   SOURCE = %-22s | node_modules/@ejc3/reslib -> %s\n' "$C" "$(showlink)"
assert_eq "case c: workspace:* resolves the local workspace copy" "$C" "workspace-local"

echo; echo "(cleanup deletes @ejc3/reslib@$VER from the registry and removes local scratch)"
