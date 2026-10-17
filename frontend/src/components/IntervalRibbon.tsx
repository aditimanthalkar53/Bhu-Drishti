import { fmt } from "../format";
import type { HistoryPoint } from "../useQueryRun";

interface Props {
  history: HistoryPoint[];
  digits: number;
  unit: string;
  /** Allowed half-width in the same units as the value, if the target is absolute. */
  targetHalfwidth: number | null;
  clamp?: [number, number];
}

/**
 * A number line whose scale is fixed by the first interval, so you can watch the
 * confidence bracket close in as tiles are analysed.
 */
export function IntervalRibbon({ history, digits, unit, targetHalfwidth, clamp }: Props) {
  if (history.length === 0) {
    return (
      <div className="ribbon ribbon-empty">
        <div className="ribbon-track" />
        <p className="muted small">The interval appears after the first batch of tiles.</p>
      </div>
    );
  }
  const first = history[0];
  const cur = history[history.length - 1];
  let lo = Math.min(first.lo, cur.lo);
  let hi = Math.max(first.hi, cur.hi);
  const pad = Math.max((hi - lo) * 0.12, Math.abs(cur.value) * 0.02, 1e-6);
  lo -= pad;
  hi += pad;
  if (clamp) {
    lo = Math.max(clamp[0], lo);
    hi = Math.min(clamp[1], hi);
  }
  const x = (v: number) => `${(100 * (v - lo)) / (hi - lo || 1)}%`;
  const w = (a: number, b: number) => `${(100 * Math.max(b - a, 0)) / (hi - lo || 1)}%`;
  const ticks = niceTicks(lo, hi, 5);

  return (
    <figure className="ribbon" aria-label={`Estimate ${fmt(cur.value, digits)} ${unit}, interval ${fmt(cur.lo, digits)} to ${fmt(cur.hi, digits)}`}>
      <div className="ribbon-track">
        <div className="ribbon-first" style={{ left: x(first.lo), width: w(first.lo, first.hi) }} title="Interval after the first batch" />
        {targetHalfwidth !== null && (
          <div className="ribbon-target" style={{ left: x(cur.value - targetHalfwidth), width: w(cur.value - targetHalfwidth, cur.value + targetHalfwidth) }}
            title="Precision you asked for" />
        )}
        <div className="ribbon-ci" style={{ left: x(cur.lo), width: w(cur.lo, cur.hi) }} />
        <div className="ribbon-point" style={{ left: x(cur.value) }} />
      </div>
      <div className="ribbon-axis" aria-hidden="true">
        {ticks.map((t) => (
          <span key={t} style={{ left: x(t) }}>{fmt(t, digits && Math.abs(hi - lo) < 10 ? 1 : 0)}</span>
        ))}
      </div>
      <figcaption className="ribbon-key small muted">
        <span><i className="key key-ci" /> current interval</span>
        <span><i className="key key-first" /> after first batch</span>
        {targetHalfwidth !== null && <span><i className="key key-target" /> your precision target</span>}
      </figcaption>
    </figure>
  );
}

export function niceTicks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}
