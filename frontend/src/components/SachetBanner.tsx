import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { resolveAlert } from "../placeLookup";
import { alertsForRegion, suggestedQuestion } from "../sachetLink";
import type { Region } from "../types";

interface Alert { id: string; title: string; event: string; severity: string | null; areaDesc: string | null; description: string | null; msgType: string | null; expires: string | null; instruction: string | null }

const TONE: Record<string, string> = { extreme: "notice-error", severe: "notice-error", moderate: "notice-warn" };
const active = (a: Alert) => a.msgType !== "Cancel" && !(a.expires && Date.parse(a.expires) < Date.now());

/**
 * Explore ↔ SACHET: when the selected district is named in an active official alert, say so above the question form.
 * It only reads the alerts the SACHET page already shows (nothing is invented: no feed, no banner). An alert counts when it
 * names the district by its list name, or when the place it names lies inside the district (so "Balasore" finds Baleshwar).
 */
export function SachetBanner({ region, onAsk }: { region: Region | undefined; onAsk(question: string): void }) {
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [byLocation, setByLocation] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    api<{ state: string; alerts: Alert[] }>("/api/sachet/alerts")
      .then((r) => { if (live) setAlerts(r.state === "live" ? r.alerts : []); })
      .catch(() => { if (live) setAlerts([]); });
    return () => { live = false; };
  }, []);

  // only the few active alerts are looked up (cached, so reopening Explore costs nothing)
  useEffect(() => {
    setByLocation(new Set());
    if (!region || region.kind !== "district" || !alerts) return;
    let live = true;
    for (const a of alerts.filter(active)) {
      void resolveAlert(a).then((ds) => {
        if (live && ds.some((d) => d.id === region.id)) setByLocation((s) => new Set(s).add(a.id));
      });
    }
    return () => { live = false; };
  }, [region, alerts]);

  const hits = useMemo(() => {
    const byName = alertsForRegion(region, alerts ?? []);
    const ids = new Set(byName.map((a) => a.id));
    return [...byName, ...(alerts ?? []).filter((a) => active(a) && byLocation.has(a.id) && !ids.has(a.id))];
  }, [region, alerts, byLocation]);

  if (!region || hits.length === 0) return null;
  const q = suggestedQuestion(hits[0]);
  return (
    <section className={`notice ${TONE[(hits[0].severity ?? "").toLowerCase()] ?? "notice-warn"}`} role="status" aria-label="Official SACHET alerts for this area">
      <strong>Official SACHET alert{hits.length > 1 ? `s (${hits.length})` : ""} for {region.name}:</strong>
      <ul className="small">
        {hits.slice(0, 3).map((a) => (
          <li key={a.id}>{a.title}{a.severity ? ` · ${a.severity}` : ""}{a.expires ? ` · valid until ${new Date(a.expires).toLocaleString()}` : ""}</li>
        ))}
      </ul>
      <div className="row-actions">
        {q && <button type="button" className="btn btn-small" onClick={() => onAsk(q)}>Use the matching question</button>}
        <Link className="btn btn-small" to="/app/sachet">All SACHET alerts</Link>
      </div>
    </section>
  );
}
