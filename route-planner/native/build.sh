#!/usr/bin/env bash
# The planner through Scriptc (pinned 0.4.0): checks it still compiles to native code with no
# blockers, builds the static library with profile.json's C interface, and links probe.c to it.
#   native/build.sh <out dir>     writes <out dir>/libdmengine.a and <out dir>/probe
# Scriptc is fetched once into $SCRIPTC_HOME (default ~/.cache/scriptc-<version>).
set -euo pipefail
cd "$(dirname "$0")"
VERSION=0.4.0
OUT="${1:?usage: native/build.sh <out dir>}"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) ASSET=linux-x64-gnu ;;
  Linux-aarch64) ASSET=linux-arm64-gnu ;;
  Darwin-arm64) ASSET=darwin-arm64 ;;
  *) echo "no Scriptc build for $(uname -s)-$(uname -m)" >&2; exit 2 ;;
esac
HOME_DIR="${SCRIPTC_HOME:-$HOME/.cache/scriptc-$VERSION}"
SCRIPTC="$HOME_DIR/bin/scriptc"
if [ ! -x "$SCRIPTC" ]; then
  mkdir -p "$HOME_DIR"
  curl -fsSL "https://github.com/vercel-labs/scriptc/releases/download/v$VERSION/scriptc-$VERSION-$ASSET.tar.gz" | tar -xz -C "$HOME_DIR"
fi
[ "$("$SCRIPTC" --version)" = "$VERSION" ] || { echo "expected Scriptc $VERSION" >&2; exit 2; }
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
"$SCRIPTC" coverage engine-lib.ts --tier static-only --fail-on blockers
"$SCRIPTC" build --lib --profile profile.json -o "$OUT/libdmengine.a" >/dev/null
cc -O2 probe.c "$OUT/libdmengine.a" -lm -lpthread -ldl -o "$OUT/probe"
ls -l "$OUT/libdmengine.a" "$OUT/probe"
