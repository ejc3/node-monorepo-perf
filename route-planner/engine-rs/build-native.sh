#!/usr/bin/env bash
# Builds the engine as a static library with native/profile.json's C interface, and links
# native/probe.c (unchanged) against it:
#   pkg/native/libdmengine.a   the release static library (target-cpu left at its default)
#   pkg/native/probe           probe <pack.json> <calls.tsv>, which the parity harness runs
# Neither is committed. The toolchain is rust-toolchain.toml's.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"
cargo build --release --locked
lib="${CARGO_TARGET_DIR:-$here/target}/release/libroute_planner_engine.a"
mkdir -p pkg/native
cp "$lib" pkg/native/libdmengine.a
# The libraries Rust's standard library needs from the C side (`--print native-static-libs`);
# on glibc 2.34 and later libpthread, libdl and librt are libc itself.
cc -O2 ../native/probe.c pkg/native/libdmengine.a -lm -lpthread -ldl -o pkg/native/probe
ls -l pkg/native/libdmengine.a pkg/native/probe
