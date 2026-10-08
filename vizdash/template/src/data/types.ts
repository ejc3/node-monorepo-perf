// Shared shapes of the query engine. Charts, tables and KPI cards take these, so a
// dashboard's loader output can be handed to the viz library unchanged.

export type Unit =
  "currency" | "count" | "number" | "percent" | "duration" | "days" | "bytes" | "ratio";
export type Grain = "day" | "week" | "month";
export type RangeKey = "7d" | "30d" | "90d" | "6m" | "12m" | "ytd";
export type Direction = "up" | "down";

export interface MetricDef {
  key: string;
  label: string;
  unit: Unit;
  /** typical value of one day (sums) or of any bucket (averages) */
  base: number;
  /** relative growth over a year */
  trend: number;
  /** amplitude of the yearly cycle, relative */
  season: number;
  /** day-to-day noise, relative standard deviation */
  noise: number;
  /** which direction counts as an improvement */
  good: Direction;
  /** sum over a bucket, or average */
  agg: "sum" | "avg";
}

export interface DimensionDef {
  key: string;
  label: string;
  values: readonly string[];
}

export interface EntityDef {
  key: string;
  label: string;
  plural: string;
  pool: NamePool;
  statuses: readonly string[];
}

export type NamePool =
  | "company"
  | "person"
  | "campaign"
  | "product"
  | "service"
  | "invoice"
  | "shipment"
  | "ticket"
  | "feature"
  | "sku"
  | "vendor"
  | "role";

export interface Filters {
  range: RangeKey;
  grain: Grain;
  segment: string | null;
  region: string | null;
  compare: boolean;
  q: string;
  page: number;
  sort: string | null;
}

/** A dashboard's fixed slice of the data (e.g. region = EMEA, segment = Enterprise). */
export type Scope = Readonly<Record<string, string>>;

export interface QueryContext {
  /** stable id of the dashboard or page asking; seeds every number it gets */
  seed: string;
  filters: Filters;
  scope?: Scope;
}

export interface SeriesDef {
  key: string;
  label: string;
}

export type SeriesRow = { date: string } & Record<string, number | string>;

export interface TimeseriesResult {
  rows: SeriesRow[];
  series: SeriesDef[];
  unit: Unit;
  /** how the metric combines over time: totals can be summed, averages cannot */
  agg: "sum" | "avg";
  grain: Grain;
  compare: boolean;
}

export interface BreakdownRow {
  key: string;
  label: string;
  value: number;
  share: number;
  delta: number;
}

export interface BreakdownResult {
  rows: BreakdownRow[];
  unit: Unit;
  total: number;
}

export interface MatrixResult {
  rows: readonly string[];
  cols: readonly string[];
  cells: number[][];
  unit: Unit;
  max: number;
}

export interface TreeNode {
  name: string;
  value?: number;
  children?: TreeNode[];
}

export interface FlowNode {
  name: string;
  stage: number;
}

export interface FlowLink {
  source: number;
  target: number;
  value: number;
}

export interface FlowResult {
  nodes: FlowNode[];
  links: FlowLink[];
  unit: Unit;
}

export interface CohortRow {
  label: string;
  size: number;
  values: number[];
}

export interface FunnelStep {
  step: string;
  value: number;
  rate: number;
  overall: number;
}

export interface DistributionResult {
  values: number[];
  unit: Unit;
  mean: number;
  median: number;
  p90: number;
  stdev: number;
}

export interface GroupedDistribution {
  groups: { group: string; values: number[] }[];
  unit: Unit;
}

export interface ScatterPoint {
  id: string;
  label: string;
  x: number;
  y: number;
  size: number;
  group: string;
}

export interface ScatterResult {
  points: ScatterPoint[];
  x: { label: string; unit: Unit };
  y: { label: string; unit: Unit };
  groups: readonly string[];
}

export interface RecordRow {
  id: string;
  name: string;
  owner: string;
  status: string;
  values: Record<string, number>;
  delta: number;
  trend: number[];
}

export interface Kpi {
  key: string;
  label: string;
  unit: Unit;
  value: number;
  previous: number;
  delta: number;
  good: Direction;
  spark: number[];
}

export interface DailyPoint {
  date: string;
  value: number;
}

export interface ProfileResult {
  axes: string[];
  series: { label: string; values: number[] }[];
  unit: Unit;
}

export interface GoalResult {
  value: number;
  target: number;
  unit: Unit;
  label: string;
}
