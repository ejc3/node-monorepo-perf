#!/usr/bin/env bash
# Builds the two Hermes releases the bench runs, from source, into <root>:
#   <root>/classic   Hermes 0.14.1 (tag hermes-v0.14.1): hermes, hermesc
#   <root>/v1        Hermes V1 (tag hermes-v250829098.0.4):
#                    hermes, hermesc, and shermes with the runtime it links (shermes-dep)
# Both Release, debugger and Intl off. Each tree is cloned at its tag (shallow) and kept; a
# finished build is not rebuilt while its inputs are the same: the tag, this script, the targets
# and the versions of the compiler, cmake and ninja (its .built file). Needs git, cmake, ninja, a C++ compiler, python3 and ICU
# (libicu-dev on Ubuntu: the Linux build links it with Intl off too).
#   route-planner/hermes/build-hermes.sh <root>
set -euo pipefail
ROOT="${1:?usage: build-hermes.sh <root>}"
mkdir -p "$ROOT"
ROOT="$(cd "$ROOT" && pwd)"
build() { # <name> <tag> <ninja targets...>
  local name=$1 tag=$2; shift 2
  local src="$ROOT/src-$name" out="$ROOT/$name"
  if [ ! -d "$src/.git" ]; then
    git clone --quiet --depth 1 --branch "$tag" https://github.com/facebook/hermes.git "$src"
  fi
  [ "$(git -C "$src" describe --tags --exact-match)" = "$tag" ] || { echo "$src is not at $tag" >&2; exit 1; }
  local inputs
  inputs="$(printf '%s\n' "$tag" "$*"; cat "$0"; c++ --version; cc --version; cmake --version; ninja --version)"
  if [ "$(cat "$out/.built" 2>/dev/null)" != "$inputs" ]; then
    # A fresh tree: CMake keeps the compiler an existing tree was configured with.
    rm -rf "$out"
    cmake -S "$src" -B "$out" -G Ninja -DCMAKE_BUILD_TYPE=Release -DHERMES_ENABLE_DEBUGGER=OFF -DHERMES_ENABLE_INTL=OFF > "$ROOT/cmake-$name.log"
    ninja -C "$out" "$@" > "$ROOT/ninja-$name.log"
    printf '%s' "$inputs" > "$out/.built"
  fi
  echo "$name: $tag at $(git -C "$src" rev-parse HEAD)"
}
build classic hermes-v0.14.1 hermes hermesc
build v1 hermes-v250829098.0.4 hermes hermesc shermes-dep
