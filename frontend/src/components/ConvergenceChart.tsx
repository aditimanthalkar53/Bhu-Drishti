import { useMemo, useRef, useState } from "react";
import { fmt, fmtInt } from "../format";
import type { HistoryPoint } from "../useQueryRun";
import { niceTicks } from "./IntervalRibbon";

interface Props {
  history: HistoryPoint[];
  digits: number;
  unit: string;
  population: number | null;
}

const W = 380;
const H = 190;
const M = { top: 12, right: 12, bottom: 30, left: 44 };

/** Estimate and its confidence band against the number of tiles analysed. */
export function ConvergenceChart({ history, digits, unit, population }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const geo = useMemo(() => {
    if (history.length < 2) return null;
    const n0 = 0;
    const n1 = Math.max(...history.map((h) => h.n));
    let y0 = Math.min(...history.map((h) => h.lo));
    let y1 = Math.max(...history.map((h) => h.hi));
    const pad = (y1 - y0) * 0.06 || 1;
    y0 -= pad;
    y1 += pad;
    const sx = (n: number) => M.left + ((n - n0) / (n1 - n0 || 1)) * (W - M.left - M.right);
    const sy = (v: number) => M.top + (1 - (v - y0) / (y1 - y0 || 1)) * (H - M.top - M.bottom);
    const band =
      history.map((h, i) => `${i ? "L" : "M"}${sx(h.n).toFixed(1)},${sy(h.hi).toFixed(1)}`).join("") +
      [...history].reverse().map((h) => `L${sx(h.n).toFixed(1)},${sy(h.lo).toFixed(1)}`).join("") + "Z";
    const line = history.map((h, i) => `${i ? "L" : "M"}${sx(h.n).toFixed(1)},${sy(h.value).toFixed(1)}`).join("");
    return { sx, sy, band, line, yTicks: niceTicks(y0, y1, 4), xTicks: niceTicks(n0, n1, 4), y0, y1 };
  }, [history]);

  if (!geo) {
    return <div className="chart-empty muted small">The convergence chart starts after two batches.</div>;
  }

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    let bd = Infinity;
    history.forEach((h, i) => {
      const d = Math.abs(geo.sx(h.n) - px);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    setHover(best);
  };

  const h = hover !== null ? history[hover] : null;

  return (
    <figure className="chart">
      <figcaption className="chart-title">Estimate vs tiles analysed</figcaption>
      <div className="chart-box">
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img"
          aria-label={`Estimate converging to ${fmt(history[history.length - 1].value, digits)} ${unit}`}
          onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          {geo.yTicks.map((t) => (
            <g key={`y${t}`}>
              <line x1={M.left} x2={W - M.right} y1={geo.sy(t)} y2={geo.sy(t)} className="grid" />
              <text x={M.left - 6} y={geo.sy(t)} className="tick" textAnchor="end" dominantBaseline="middle">{fmt(t, digits)}</text>
            </g>
          ))}
          {geo.xTicks.map((t) => (
            <text key={`x${t}`} x={geo.sx(t)} y={H - 10} className="tick" textAnchor="middle">{fmtInt(t)}</text>
          ))}
          <path d={geo.band} className="band" />
          <path d={geo.line} className="line" />
          {h && (
            <g>
              <line x1={geo.sx(h.n)} x2={geo.sx(h.n)} y1={M.top} y2={H - M.bottom} className="crosshair" />
              <circle cx={geo.sx(h.n)} cy={geo.sy(h.value)} r={4} className="dot" />
            </g>
          )}
        </svg>
        {h && (
          <div className="tooltip" style={{ left: `${(geo.sx(h.n) / W) * 100}%` }} role="status">
            <strong>{fmt(h.value, digits)} {unit}</strong>
            <span>{fmt(h.lo, digits)} – {fmt(h.hi, digits)}</span>
            <span>{fmtInt(h.n)}{population ? ` of ${fmtInt(population)}` : ""} tiles · {fmt(h.t, 1)} s</span>
          </div>
        )}
      </div>
    </figure>
  );
}
