#!/usr/bin/env bash
# Builds the engine's WebAssembly and its JavaScript glue, twice:
#   pkg/node/  the `nodejs` target, which the parity harness and the bench load;
#   pkg/web/   the `web` target, for a browser worker.
# Neither is committed. The toolchain is rust-toolchain.toml's; wasm-bindgen-cli must be the
# exact version Cargo.toml pins for the wasm-bindgen crate (set WASM_BINDGEN to its path if it
# is not the one on PATH).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"

want="$(sed -n 's/^wasm-bindgen = "=\(.*\)"$/\1/p' Cargo.toml)"
[ -n "$want" ] || { echo "build-wasm.sh: no exact wasm-bindgen pin in Cargo.toml" >&2; exit 1; }
bindgen="${WASM_BINDGEN:-wasm-bindgen}"
have="$("$bindgen" --version 2>/dev/null | awk '{print $2}' || true)"
if [ "$have" != "$want" ]; then
  echo "build-wasm.sh: wasm-bindgen-cli ${have:-missing}, the crate needs $want exactly:" >&2
  echo "  cargo install wasm-bindgen-cli --version $want --locked" >&2
  exit 1
fi

cargo build --release --locked --target wasm32-unknown-unknown
wasm="${CARGO_TARGET_DIR:-$here/target}/wasm32-unknown-unknown/release/route_planner_engine.wasm"
for target in nodejs web; do
  out="pkg/${target/nodejs/node}"
  rm -rf "$out"
  "$bindgen" --target "$target" --out-dir "$out" "$wasm"
done
# engine-rs/package.json says "type": "module"; the nodejs glue is CommonJS, the web glue ESM.
echo '{ "type": "commonjs" }' > pkg/node/package.json
echo '{ "type": "module" }' > pkg/web/package.json
ls -l pkg/node/*.wasm pkg/web/*.wasm
