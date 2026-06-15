#!/usr/bin/env bash
# Reproducible end-to-end demo:
#   1. publish @ejc3/widget@1, @ejc3/alpha@1 (dep widget^1), @ejc3/widget@2,
#      @ejc3/beta@1 (dep widget^2) to AWS CodeArtifact   [timed]
#   2. a consumer depends on alpha + beta by SEMVER -> pnpm resolves a real
#      DIAMOND: widget@1 (under alpha) AND widget@2 (under beta) coexist
#   3. flip the shared lib to workspace: via root pnpm.overrides -> the diamond
#      COLLAPSES to one local version and the dependent built for the other API breaks
#
# Auth lives in LOCAL .npmrc files (scoped @ejc3) so the main workspace's installs
# are never hijacked. npm needs --userconfig (it does NOT walk ancestor .npmrc);
# pnpm reads the per-project .npmrc. Tokens are never committed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/examples/diamond"
TSC="$ROOT/node_modules/.bin/tsc"
DOMAIN=ejc3; OWNER=928413605543; REPO=npm; REGION=us-west-2
EP="https://${DOMAIN}-${OWNER}.d.codeartifact.${REGION}.amazonaws.com/npm/${REPO}/"
HOST="${DOMAIN}-${OWNER}.d.codeartifact.${REGION}.amazonaws.com/npm/${REPO}/"
NPMRC="$DIR/.npmrc"

echo "════════ 1. scaffold ════════"
node "$ROOT/scripts/diamond-scaffold.mjs"

echo "════════ 2. CodeArtifact auth → local .npmrc files (scoped @ejc3) ════════"
TOKEN=$(aws codeartifact get-authorization-token --domain "$DOMAIN" --domain-owner "$OWNER" --region "$REGION" --query authorizationToken --output text)
AUTH=$(printf '@ejc3:registry=%s\n//%s:_authToken=%s\n//%s:always-auth=true\n' "$EP" "$HOST" "$TOKEN" "$HOST")
printf '%s\n' "$AUTH" > "$NPMRC"
printf '%s\n' "$AUTH" > "$DIR/consumer/.npmrc"
printf 'link-workspace-packages=false\n%s\n' "$AUTH" > "$DIR/override/.npmrc"
echo "wrote scoped .npmrc (registry=$EP)"

echo "════════ cleanup prior versions (idempotent reruns) ════════"
for p in widget alpha beta; do
  aws codeartifact delete-package-versions --domain "$DOMAIN" --domain-owner "$OWNER" --repository "$REPO" --region "$REGION" \
    --format npm --namespace "$DOMAIN" --package "$p" --versions 1.0.0 2.0.0 >/dev/null 2>&1 || true
done

build() { ( cd "$DIR/$1"; [ "${2:-}" = withdeps ] && npm install --omit=dev --no-package-lock --userconfig "$NPMRC" >/dev/null 2>&1; "$TSC" ); }
pub() {
  ( cd "$DIR/$1"
    local t0 t1; t0=$(date +%s%3N)
    if ! npm publish --userconfig "$NPMRC" >/tmp/diamond-pub.log 2>&1; then
      if grep -q "already exists" /tmp/diamond-pub.log; then
        echo "    (version already published) $1"
      else
        echo "PUBLISH FAILED ($1):" >&2; tail -6 /tmp/diamond-pub.log >&2; exit 1
      fi
    fi
    grep -E 'notice (name|version|package size)|^\+ ' /tmp/diamond-pub.log | sed 's/^/    /' || true
    t1=$(date +%s%3N)
    echo "PUBLISH_MS $1 $((t1 - t0))" )
}

echo "════════ 3. build + publish (timed) ════════"
build registry/widget-v1;           pub registry/widget-v1
build registry/alpha withdeps;      pub registry/alpha
build registry/widget-v2;           pub registry/widget-v2
build registry/beta withdeps;       pub registry/beta

echo "════════ 4. DIAMOND: consumer depends on alpha+beta by semver ════════"
( cd "$DIR/consumer"
  rm -rf node_modules pnpm-lock.yaml
  # --ignore-workspace: consumer is nested under the main pnpm workspace; without
  # this pnpm grabs the parent root and installs nothing for the consumer.
  pnpm install --ignore-workspace --config.confirm-modules-purge=false 2>&1 | tail -5
  echo "--- pnpm why @ejc3/widget (two versions via the diamond) ---"
  pnpm why @ejc3/widget 2>&1 | grep -E 'widget|alpha|beta' | head -20 || true
  echo "--- widget versions materialized in the store ---"
  ls node_modules/.pnpm | grep '@ejc3+widget' || true
  echo "--- run consumer (BOTH versions coexist → both work) ---"
  node run.mjs )

echo "════════ 5. OVERRIDE: flip widget to workspace: → diamond collapses ════════"
rm -rf "$DIR/override/packages" "$DIR/override/consumer"
mkdir -p "$DIR/override/packages"
cp -r "$DIR/registry/widget-v2" "$DIR/override/packages/widget"   # local @ejc3/widget@2.0.0
( cd "$DIR/override/packages/widget"; "$TSC" )
cp -r "$DIR/consumer" "$DIR/override/consumer"; rm -rf "$DIR/override/consumer/node_modules" "$DIR/override/consumer/pnpm-lock.yaml" "$DIR/override/consumer/.npmrc"
( cd "$DIR/override"
  rm -rf node_modules pnpm-lock.yaml packages/widget/node_modules
  pnpm install --config.confirm-modules-purge=false 2>&1 | tail -5
  echo "--- widget versions now (collapsed to the single local copy) ---"
  ls node_modules/.pnpm | grep '@ejc3+widget' || true
  echo "--- run consumer (alpha was built for widget v1 API → expect a break) ---"
  ( cd consumer && node run.mjs ) || echo ">>> RUNTIME ERROR (EXPECTED): alpha needs widget v1's render(), but the override forced everyone onto local widget v2"
)

echo "════════ done ════════"
