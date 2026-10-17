import type { EstimateView, QueryIR, Task } from "./types";

export function fmt(v: number | undefined | null, digits = 1): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return "–";
  return v.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtInt(v: number | undefined | null): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return "–";
  return Math.round(v).toLocaleString("en-IN");
}

/** Digits to show for an estimate of this task. */
export function digitsFor(task: Task): number {
  return task === "count" || task === "find_all" ? 0 : 1;
}

export function unitFor(task: Task): string {
  switch (task) {
    case "area_fraction":
      return "% of cropland";
    case "total":
      return "km²";
    case "count":
      return "kilns";
    case "find_all":
      return "target tiles";
    default:
      return "";
  }
}

export function targetLabel(ir: Pick<QueryIR, "target">): string {
  return { flooded_cropland: "Flooded cropland", new_builtup: "New built-up area", brick_kiln: "Brick kilns" }[ir.target];
}

export function taskLabel(task: Task): string {
  return {
    area_fraction: "Share of an area",
    total: "Total area",
    count: "Object count",
    find_all: "Find every tile",
    inspect: "Inspect a location",
  }[task];
}

export function precisionLabel(ir: QueryIR): string {
  switch (ir.task) {
    case "area_fraction":
      return `±${ir.precision} percentage points`;
    case "total":
    case "count":
      return `±${ir.precision}% of the estimate`;
    case "find_all":
      return `recall ≥ ${ir.precision}%`;
    default:
      return "exact";
  }
}

export function stopReasonLabel(r: string): string {
  return (
    {
      precision_met: "Precision target reached",
      recall_certified: "Recall target certified",
      time_budget: "Time budget used up",
      tile_budget: "Tile budget used up",
      user_stop: "Stopped by you",
      census: "Every tile analysed",
      replay_complete: "Replay complete",
      exhausted: "Finished",
    } as Record<string, string>
  )[r] ?? r;
}

export function halfwidthPct(task: Task, e: EstimateView): string {
  if (task === "area_fraction") return `±${fmt(e.halfwidth, 1)} pp`;
  if (!e.value) return "–";
  return `±${fmt((100 * e.halfwidth) / Math.abs(e.value), 0)}%`;
}

export function fmtSeconds(s: number): string {
  if (!Number.isFinite(s)) return "–";
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s % 60)} s`;
}
