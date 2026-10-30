export interface Region {
  id: string;
  name: string;
  bbox: [number, number, number, number];
  geometry?: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  simulated: boolean;
  description: string;
  state?: string;
  kind?: "demo" | "district" | "custom";
  area_km2?: number | null;
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
  steps_pending?: boolean;
}

export type Task = "area_fraction" | "total" | "count" | "find_all" | "inspect";
export type Target = "flooded_cropland" | "new_builtup" | "brick_kiln" | "active_fire" | "burned_cropland";

export interface QueryIR {
  task: Task;
  target: Target;
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
  suggested_region?: Region | null;
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
  interval_method?: string;
  interval_confidence?: number;
  // find-all
  confirmed_positive_tiles?: number;
  recall_lower_bound?: number;
  recall_estimate?: number;
  frontier_depth?: number;
  audit_tiles?: number;
  answers?: Record<string, number>;
  tiles?: number;
  // census (fires)
  detections?: number;
  by_confidence?: Record<string, number>;
  on_cropland?: number;
  by_day?: Record<string, number>;
  tiles_with_detections?: number;
  newest_detection?: string | null;
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

export interface EvidenceItem {
  id: string;
  title: string;
  source: string;
  status: "ok" | "unavailable" | "not_configured" | "error";
  summary: string;
  role?: string;
  data?: any;
  provenance?: any[];
}

export interface AdvisoryItem {
  title: string;
  detail: string;
  who: string;
  when: string;
  reference?: string;
}

export interface Advisory {
  topic: string;
  headline: string;
  severity?: string;
  season?: string;
  state?: string;
  items: AdvisoryItem[];
  disclaimer: string;
}

export interface InputSummary {
  source: string;
  product: string;
  items: number;
  first: string | null;
  last: string | null;
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
  supporting_evidence?: EvidenceItem[];
  advisory?: Advisory | null;
  data_mode?: "live" | "simulated";
  region?: Region | null;
  inputs_summary?: InputSummary[];
  missing_data_tiles?: number;
  priority_tiles?: (Record<string, unknown> & { tile_id: string; bbox: number[]; detections?: number })[];
}

export interface Session {
  id: string;
  projectId: string;
  question: string;
  regionId: string;
  status: string;
  answer: string | null;
  createdAt: string;
  source?: "user" | "monitor";
  data_mode?: string | null;
  stop_reason?: string | null;
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

// ------------------------------------------------------------------ product records
export interface AOI { id: string; name: string; regionId: string; kind: "district" | "custom" | "demo"; state?: string; description?: string; areaKm2?: number | null; createdAt: string }
export type Schedule = { type: "interval"; hours: number } | { type: "daily"; time: string } | { type: "new_pass" } | { type: "manual" };
export interface Threshold { metric: "value" | "lo" | "hi"; op: ">" | ">=" | "<" | "<="; value: number }
export interface Escalation { enabled: boolean; ackMinutes: number; severeValue?: number | null; criticalValue?: number | null }
export const LEVELS: Record<number, string> = { 1: "Block / field", 2: "District", 3: "State", 4: "National" };
export interface Notified { at: string; recipientId: string; name: string; designation: string; level: number; email: string; status: "sent" | "failed"; error?: string; reason: string }
export interface Monitor {
  id: string; escalation?: Escalation | null; name: string; aoiId: string; regionId: string; question: string; schedule: Schedule; threshold?: Threshold | null;
  recipientIds: string[]; groupIds: string[]; autoReport: boolean; requireApproval: boolean; enabled: boolean;
  lastRunAt?: string | null; lastQueryId?: string | null; lastValue?: number | null; lastStatus?: string | null; lastError?: string | null;
  nextRunAt?: string | null; createdAt: string;
}
export interface Alert { drill?: boolean; escalation?: Escalation | null; lastEscalatedAt?: string | null; notified: Notified[]; confirmedBy?: { recipientId: string; name: string; at: string }[]; id: string; monitorId: string; queryId: string; regionId: string; title: string; message: string; value: number | null;
  threshold: Threshold; status: "open" | "acknowledged" | "resolved"; assignee?: string | null; history: { at: string; by: string; action: string; note?: string }[]; createdAt: string }
export interface Recipient { level?: number; reportsToId?: string | null; id: string; name: string; designation: string; department: string; state?: string; district?: string; regionIds: string[];
  email: string; phone?: string; channels: string[]; groupIds: string[]; active: boolean; createdAt: string }
export interface Group { id: string; name: string; description?: string; createdAt: string }
export interface Delivery { id: string; reportId: string; recipientId?: string | null; channel: string; to: string; status: string; via: string; error?: string | null; createdAt: string }
export interface Report { id: string; title: string; queryIds: string[]; regionId?: string | null; monitorId?: string | null; status: string; origin: string;
  summary: string; recipientIds: string[]; groupIds: string[]; approvedBy?: string | null; approvedAt?: string | null; sentAt?: string | null; note?: string; createdAt: string;
  deliveries?: Delivery[]; recipients?: Recipient[] }
export interface Webhook { id: string; url: string; events: string[]; active: boolean; description?: string; lastStatus?: number | null; lastError?: string | null; lastDeliveredAt?: string | null; secret?: string; createdAt: string }
export interface Notification { id: string; title: string; body: string; link?: string; level: "info" | "warning" | "critical"; read: boolean; createdAt: string }
export interface AuditEntry { id: string; actor: string; actorName?: string; action: string; target: string; detail?: Record<string, unknown>; createdAt: string }
export interface SourceStatus { id: string; name: string; homepage: string; status: string; status_label: string; detail: string; checked_at: string | null;
  requires: string[]; configured: boolean; capabilities: { product: string; kind: string; description: string; temporal: string; resolution_m: number | null; latency: string; limitations: string }[];
  steps: { step: string; ok: boolean; seconds: number; result?: unknown; error?: any }[]; last_error: any }
