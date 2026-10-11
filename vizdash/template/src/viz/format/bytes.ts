const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

export function formatBytes(v: number): string {
  if (!Number.isFinite(v)) return "–";
  let i = 0;
  let n = Math.abs(v);
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024;
    i++;
  }
  return `${v < 0 ? "−" : ""}${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${UNITS[i]}`;
}
