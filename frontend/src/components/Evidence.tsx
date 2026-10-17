import { useState } from "react";
import type { Advisory, EvidenceItem, InputSummary } from "../types";

const STATUS_LABEL: Record<string, string> = { ok: "available", unavailable: "unavailable", not_configured: "not configured", error: "error" };
const SOURCE_LABEL: Record<string, string> = {
  planetary_computer: "Planetary Computer", copernicus: "Copernicus Data Space", earth_engine: "Earth Engine",
  firms: "NASA FIRMS", earthdata: "NASA Earthdata", open_meteo: "Open-Meteo",
};

/** Context from other sources. Never part of the estimate — the UI says so. */
export function EvidenceList({ items }: { items: EvidenceItem[] }) {
  if (!items.length) return null;
  return (
    <section className="caveats" aria-label="Supporting evidence">
      <h3>Supporting evidence <span className="muted small">(context — not used in the number)</span></h3>
      <ul className="evidence-list">
        {items.map((it) => (
          <li key={it.id} className={`ev ev-${it.status}`}>
            <div className="ev-head">
              <strong>{it.title}</strong>
              <span className={`pill pill-${it.status}`}>{STATUS_LABEL[it.status] ?? it.status}</span>
            </div>
            <p className="small">{it.summary}</p>
            {it.role && <p className="muted small">{it.role}</p>}
            {it.id === "rainfall" && Array.isArray(it.data?.series) && it.data.series.length > 0 && <RainBars series={it.data.series} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function RainBars({ series }: { series: { date: string; mm: number | null }[] }) {
  const max = Math.max(1, ...series.map((s) => s.mm ?? 0));
  return (
    <div className="rain-bars" role="img" aria-label={`Daily rainfall, up to ${Math.round(max)} mm`}>
      {series.map((s) => (
        <span key={s.date} title={`${s.date}: ${s.mm ?? "no data"} mm`} style={{ height: `${Math.max(2, (100 * (s.mm ?? 0)) / max)}%` }}
          className={s.mm === null ? "nodata" : ""} />
      ))}
    </div>
  );
}

export function InputsList({ inputs }: { inputs: InputSummary[] }) {
  return (
    <section className="caveats" aria-label="Data sources used">
      <h3>Data sources used</h3>
      <ul>
        {inputs.map((s) => (
          <li key={`${s.source}-${s.product}`}>
            <strong>{SOURCE_LABEL[s.source] ?? s.source}</strong> · {s.product}: {s.items} item{s.items === 1 ? "" : "s"}
            {s.first && <span className="muted"> ({s.first.slice(0, 10)}{s.last && s.last.slice(0, 10) !== s.first.slice(0, 10) ? ` … ${s.last.slice(0, 10)}` : ""})</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AdvisoryView({ advisory }: { advisory: Advisory }) {
  const [open, setOpen] = useState(true);
  if (!advisory?.items?.length) return null;
  return (
    <section className="advisory" aria-label="What can be done next">
      <div className="ev-head">
        <h3>What can be done next</h3>
        <button type="button" className="link-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? "Hide" : "Show"}</button>
      </div>
      <p className="advisory-headline">{advisory.headline}</p>
      {open && (
        <>
          <ol className="advisory-items">
            {advisory.items.map((it) => (
              <li key={it.title}>
                <strong>{it.title}</strong>
                <p className="small">{it.detail}</p>
                <p className="muted small">Who: {it.who} · When: {it.when}{it.reference ? ` · See: ${it.reference}` : ""}</p>
              </li>
            ))}
          </ol>
          <p className="muted small">{advisory.disclaimer}</p>
        </>
      )}
    </section>
  );
}
