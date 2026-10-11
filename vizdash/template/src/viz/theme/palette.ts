import { hsl } from "d3-color";

/** Categorical series colors, ordered so neighbors contrast. */
export const SERIES = [
  "#3b6fe0",
  "#e0773b",
  "#2fa37a",
  "#c2417a",
  "#8a62d6",
  "#d4a72c",
  "#2a9fbf",
  "#7c8a99",
  "#b85c38",
  "#5aa346",
] as const;

export const AXIS = "#7a8699";
export const GRID = "rgba(122, 134, 153, 0.18)";
export const GOOD = "#1f9d63";
export const BAD = "#d64545";
export const NEUTRAL = "#7a8699";

export function seriesColor(i: number): string {
  return SERIES[i % SERIES.length];
}

/** A lighter or darker variant of a color, for fills and hover states. */
export function shade(color: string, k: number): string {
  const c = hsl(color);
  c.l = Math.max(0, Math.min(1, c.l + k));
  return c.formatHex();
}

/** Accent colors of the product areas (sidebar, headers, the first series). */
export const AREA_ACCENTS: Record<string, string> = {
  sales: "#3b6fe0",
  marketing: "#c2417a",
  finance: "#2fa37a",
  operations: "#d4a72c",
  product: "#8a62d6",
  infrastructure: "#2a9fbf",
  support: "#e0773b",
  people: "#5aa346",
  commerce: "#b85c38",
};
