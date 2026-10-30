import { useMemo, useState } from "react";
import { api, post } from "../api";
import { fmtDate } from "../format";
import { Empty, ErrorNote, Page, Pill, useAction, useData } from "./common";

interface SachetAlert {
  id: string; title: string; event: string; category: string;
  severity: string | null; urgency: string | null; certainty: string | null;
  areaDesc: string | null; sender: string | null;
  issuedAt: string | null; effective: string | null; expires: string | null;
  description: string | null; instruction: string | null; link: string | null;
  msgType: string | null; detailed: boolean;
}
interface SachetResult {
  state: "not_configured" | "live" | "unavailable";
  alerts: SachetAlert[];
  fetchedAt: string | null;
  error: string | null;
  portalUrl: string;
  feedHost: string | null;
}

const tone = (s: string | null): "ok" | "warn" | "error" | "info" | "muted" => {
  switch (s?.toLowerCase()) {
    case "extreme": case "severe": return "error";
    case "moderate": return "warn";
    case "minor": return "info";
    default: return "muted";
  }
};
const when = (iso: string | null) => (iso ? fmtDate(iso) : null);
const expired = (a: SachetAlert) => !!a.expires && Date.parse(a.expires) < Date.now();
// the CAP standard's category codes
const CATEGORY: Record<string, string> = {
  Geo: "Geological", Met: "Weather", Safety: "Safety", Security: "Security", Rescue: "Rescue", Fire: "Fire", Health: "Health",
  Env: "Environment", Transport: "Transport", Infra: "Infrastructure", CBRNE: "CBRNE", Other: "Other",
};
const catLabel = (c: string) => CATEGORY[c] ?? c;

export function SachetPage() {
  const res = useData<SachetResult>("/api/sachet/alerts");
  const act = useAction();
  const [cat, setCat] = useState("all");
  const data = res.data;
  const cats = useMemo(() => [...new Set((data?.alerts ?? []).map((a) => a.category))].sort(), [data]);
  const list = (data?.alerts ?? []).filter((a) => cat === "all" || a.category === cat);
  const refresh = () => act.run("refresh", async () => { res.setData(await api<SachetResult>("/api/sachet/alerts?refresh=1")); });

  return (
    <Page title="SACHET Disaster Alerts"
      lead={<>Official alerts published through NDMA's <a href={data?.portalUrl ?? "https://sachet.ndma.gov.in/"} target="_blank" rel="noopener noreferrer">SACHET</a> national alert portal.
        Bhu-Drishti only displays them; it does not issue or modify warnings.</>}
      actions={<button className="btn btn-small" disabled={res.loading || act.busy === "refresh"} onClick={() => void refresh()}>Refresh</button>}>
      <ErrorNote error={res.error ?? act.error} />
      {res.loading && !data && <p className="muted">Loading official alerts…</p>}

      {data?.state === "not_configured" && (
        <Empty title="SACHET feed not connected">
          No authorised SACHET data source is configured on this server, so no alerts are shown (nothing here is sample data).
          An administrator can set <code>SACHET_FEED_URL</code>. Until then, view live official alerts at{" "}
          <a href={data.portalUrl} target="_blank" rel="noopener noreferrer">sachet.ndma.gov.in</a>.
        </Empty>
      )}
      {data?.state === "unavailable" && <p className="notice notice-warn" role="alert">{data.error} <a href={data.portalUrl} target="_blank" rel="noopener noreferrer">Open SACHET</a></p>}
      {data && data.state !== "not_configured" && (
        <p className="muted small">
          Source: {data.feedHost ?? "configured feed"}{data.fetchedAt ? ` · fetched ${fmtDate(data.fetchedAt)}` : ""} · {data.alerts.length} alert{data.alerts.length === 1 ? "" : "s"}
          {data.alerts.some((a) => !a.detailed) && ` · ${data.alerts.filter((a) => a.detailed).length} with full details so far (refresh for more)`}
        </p>
      )}
      {act.message && <p className="notice notice-ok">{act.message}</p>}

      {cats.length > 1 && (
        <div className="seg" role="group" aria-label="Disaster category">
          <button className={cat === "all" ? "active" : ""} onClick={() => setCat("all")}>All</button>
          {cats.map((c) => <button key={c} className={cat === c ? "active" : ""} onClick={() => setCat(c)}>{catLabel(c)}</button>)}
        </div>
      )}

      {data?.state !== "not_configured" && data && list.length === 0 && !res.loading && (
        <Empty title="No active alerts">{data.state === "live" ? "The official feed currently lists no alerts." : "No alerts could be loaded."}</Empty>
      )}

      <div className="stack">
        {list.map((a) => (
          <article key={a.id} className="card alert-card">
            <div className="ev-head">
              <h2>{a.title}</h2>
              {a.severity && <Pill tone={tone(a.severity)}>{a.severity}</Pill>}
            </div>
            <p className="small">
              <Pill tone="info">{catLabel(a.category)}</Pill>{" "}
              <Pill tone="ok">Official · SACHET{a.sender ? ` · ${a.sender}` : ""}</Pill>
              {a.msgType === "Cancel" && <>{" "}<Pill tone="muted">Cancelled</Pill></>}
              {expired(a) && <>{" "}<Pill tone="muted">Expired</Pill></>}
            </p>
            {a.event !== a.title && <p><strong>{a.event}</strong></p>}
            {a.areaDesc && <p><strong>Affected area:</strong> {a.areaDesc}</p>}
            {a.description && <p>{a.description}</p>}
            {a.instruction && <p className="notice notice-warn"><strong>Instructions:</strong> {a.instruction}</p>}
            <p className="muted small">
              {when(a.issuedAt) && <>Issued {when(a.issuedAt)}</>}
              {a.expires && <> · Valid until {when(a.expires)}</>}
              {(a.urgency || a.certainty) && <> · {[a.urgency && `urgency ${a.urgency}`, a.certainty && `certainty ${a.certainty}`].filter(Boolean).join(", ")}</>}
            </p>
            <div className="row-actions">
              <a className="btn btn-small" href={a.link ?? data?.portalUrl} target="_blank" rel="noopener noreferrer">{a.link ? "Official alert" : "Open SACHET"}</a>
              <button className="btn btn-small" disabled={act.busy === a.id}
                onClick={() => void act.run(a.id, async () => `Copy emailed to ${(await post<{ to: string }>(`/api/sachet/alerts/${a.id}/email`)).to}`)}>
                Email me a copy
              </button>
            </div>
          </article>
        ))}
      </div>
    </Page>
  );
}
