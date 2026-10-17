export interface Region {
  id: string;
  name: string;
  bbox: [number, number, number, number];
  geometry: GeoJSON.Polygon;
  simulated: boolean;
  description: string;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  blocking: boolean;
}

export interface PlanStep {
  op: string;
  detail: string;
}

export interface Plan {
  ok: boolean;
  checks: Check[];
  sensor: string;
  sensor_reason: string;
  steps: PlanStep[];
}

export type Task = "area_fraction" | "total" | "count" | "find_all" | "inspect";

export interface QueryIR {
  task: Task;
  target: "flooded_cropland" | "new_builtup" | "brick_kiln";
  region_id: string;
  start: string;
  end: string;
  baseline_start: string | null;
  baseline_end: string | null;
  sensor: string;
  precision: number;
  confidence: number;
  budget_seconds: number;
  budget_tiles: number;
  seed: number;
  question: string;
}

export interface CompileInfo {
  ir: QueryIR;
  parser: string;
  assumptions: string[];
  warnings: string[];
}

export interface EstimateView {
  value: number;
  lo: number;
  hi: number;
  halfwidth: number;
  method: string;
  n: number;
  proxy_r2?: number;
  total_km2?: number;
  base_km2?: number;
  // find-all
  confirmed_positive_tiles?: number;
  recall_lower_bound?: number;
  recall_estimate?: number;
  frontier_depth?: number;
  audit_tiles?: number;
  answers?: Record<string, number>;
  tiles?: number;
}

export interface TileEvent {
  tile_id: string;
  idx: number;
  stratum: number;
  value: number;
  cache: boolean;
  role?: "frontier" | "audit";
  latency_s: number;
  detail: Record<string, unknown>;
}

export interface ProgressEvent {
  type: "progress";
  batch: number;
  n: number;
  population: number;
  oracle_calls: number;
  cache_hits: number;
  elapsed_s: number;
  estimate: EstimateView;
  tiles: TileEvent[];
}

export interface PlanEvent {
  type: "plan";
  ok: boolean;
  checks: Check[];
  sensor: string;
  sensor_reason: string;
  oracle: { name: string; model_version: string; sensor: string; unit: string; description: string };
  scene_key: string;
  steps: PlanStep[];
  population: number;
  units: { value: string; short: string };
}

export interface ResultEvent {
  type: "result";
  estimate: EstimateView;
  units: { value: string; short: string };
  stop_reason: string;
  n: number;
  population: number;
  oracle_calls: number;
  cache_hits: number;
  compute_saved_by_cache_s: number;
  elapsed_s: number;
  mean_oracle_latency_s: number;
  projected_exhaustive_s: number;
  sampled_fraction: number;
  sensor: string;
  scene_key: string;
  answer: string;
  caveats: string[];
  selected_tile_ids?: string[];
}

export interface Session {
  id: string;
  projectId: string;
  question: string;
  regionId: string;
  status: string;
  answer: string | null;
  createdAt: string;
}

export interface ExhaustiveReport {
  oracle_answer: number;
  anytime_estimate: number;
  anytime_interval: [number, number];
  inside_interval: boolean;
  exhaustive_tiles: number;
  anytime_oracle_calls: number;
  call_reduction: number;
  achieved_recall?: number;
  simulated_reality?: number;
  oracle_error_vs_reality?: number;
}

export interface ReplayReport {
  identical: boolean;
  same_sample_order: boolean;
  replay_oracle_calls: number;
}
