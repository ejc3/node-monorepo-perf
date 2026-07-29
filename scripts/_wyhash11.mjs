// Bit-exact JS port of bun's legacy Wyhash11 (oven-sh/bun src/wyhash/lib.rs:
// 32-byte rounds, 5 primes, seed-chained), the hash behind bun's
// semver::string::Builder::string_hash. bun keys workspace-name duplicate
// detection on the u32 TRUNCATION of this hash (src/install/lockfile/Package.rs,
// `TruncatedPackageNameHash`), so two distinct names whose 64-bit hashes agree
// in the low 32 bits make `bun install` fail with a false "Workspace name
// already exists" (oven-sh/bun#36386). generate.mjs pre-scans its name universe
// with `bunWorkspaceNameKey` to avoid emitting such a pair.
const M = (1n << 64n) - 1n;
const P = [
  0xa0761d6478bd642fn,
  0xe7037ed1a0b428dbn,
  0x8ebc6af09c88c6e3n,
  0x589965cc75374cc3n,
  0x1d8e4e27c47d124fn,
];
const mum = (a, b) => {
  const r = (a & M) * (b & M);
  return ((r >> 64n) ^ r) & M;
};
const mix0 = (a, b, seed) => mum(a ^ seed ^ P[0], b ^ seed ^ P[1]);
const mix1 = (a, b, seed) => mum(a ^ seed ^ P[2], b ^ seed ^ P[3]);

const u8 = (b, i) => BigInt(b[i]);
const u16le = (b, i) => BigInt(b[i] | (b[i + 1] << 8));
const u32le = (b, i) =>
  BigInt((b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0);
const u64le = (b, i) => u32le(b, i) | (u32le(b, i + 4) << 32n);
// wyhash11's 8-byte remainder read: two u32le loads packed high<<32|low
const swapped8 = (b, i) => ((u32le(b, i) << 32n) | u32le(b, i + 4)) & M;

// remainder value for 1..15 trailing bytes (the packing ladder both the 0..16
// `final_` arms and the 17..31 `final_long` tail arms share)
function packTail(b, i, n) {
  if (n === 1) return u8(b, i);
  if (n === 2) return u16le(b, i);
  if (n === 3) return (u16le(b, i) << 8n) | u8(b, i + 2);
  if (n === 4) return u32le(b, i);
  if (n === 5) return (u32le(b, i) << 8n) | u8(b, i + 4);
  if (n === 6) return (u32le(b, i) << 16n) | u16le(b, i + 4);
  if (n === 7) return (u32le(b, i) << 24n) | (u16le(b, i + 4) << 8n) | u8(b, i + 6);
  throw new Error(`packTail: bad n=${n}`);
}

function finalMix(seed, b, off, n) {
  // the 0..=16 arms of WyhashStateless::final_
  if (n === 0) return seed;
  if (n <= 7) return mix0(packTail(b, off, n), P[4], seed);
  if (n === 8) return mix0(swapped8(b, off), P[4], seed);
  if (n <= 15) return mix0(swapped8(b, off), packTail(b, off + 8, n - 8), seed);
  return mix0(swapped8(b, off), swapped8(b, off + 8), seed);
}

function finalLong(seed, b, off, n) {
  // the 17..=31 arms (final_long): head over first 16, mix1 tail over the rest
  const head = mix0(swapped8(b, off), swapped8(b, off + 8), seed);
  const m = n - 16;
  let tail;
  if (m <= 7) tail = mix1(packTail(b, off + 16, m), P[4], seed);
  else if (m === 8) tail = mix1(swapped8(b, off + 16), P[4], seed);
  else tail = mix1(swapped8(b, off + 16), packTail(b, off + 24, m - 8), seed);
  return head ^ tail;
}

export function wyhash11(seedIn, input) {
  const b = typeof input === "string" ? Buffer.from(input) : input;
  let seed = BigInt(seedIn) & M;
  const aligned = b.length - (b.length % 32);
  for (let off = 0; off < aligned; off += 32) {
    seed =
      mix0(u64le(b, off), u64le(b, off + 8), seed) ^
      mix1(u64le(b, off + 16), u64le(b, off + 24), seed);
  }
  const rem = b.length - aligned;
  seed = rem > 16 ? finalLong(seed, b, aligned, rem) : finalMix(seed, b, aligned, rem);
  return mum(seed ^ BigInt(b.length), P[4]);
}

// The u32 key bun's workspace-name duplicate check actually compares
// (`string_hash(name) as TruncatedPackageNameHash`).
export const bunWorkspaceNameKey = (name) => Number(wyhash11(0n, name) & 0xffffffffn);
