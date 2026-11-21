import { Link } from "react-router-dom";
import { cssVar } from "../../theme";
import { isHiddenFor } from "../../hiddenPages";
import { ErrorNote, Pill, useData } from "../common";
import { boundsOf, Legend, MapFrame, OfferDots, REQUEST_LABEL, RequestDots, Severity, SilentCells, TaskDots,
  type HelpRequest, type Offer, type SilentZone, type Task } from "./shared";

/** Authority command view: one map with requests, offers, tasks and Maun's silent zones. */
export function CommandPage() {
  const reqs = useData<HelpRequest[]>("/api/requests?sort=priority");
  const offers = useData<Offer[]>("/api/offers");
  const tasks = useData<Task[]>("/api/tasks");
  const silent = useData<{ run: { name: string; simulated: boolean } | null; zones: SilentZone[] }>("/api/maun/silent-zones");
  const updates = useData<{ status: string }[]>(isHiddenFor("authority", "/app/updates") ? null : "/api/updates");
  const all = reqs.data ?? [];
  const live = all.filter((r) => r.status !== "resolved" && r.status !== "cancelled");
  const sos = live.filter((r) => r.source === "sos");
  const openTasks = (tasks.data ?? []).filter((t) => t.status === "open" || t.status === "claimed");
  const avail = (offers.data ?? []).filter((o) => o.status === "available");
  const zones = silent.data?.zones ?? [];
  const reload = () => { void reqs.reload(); void offers.reload(); void tasks.reload(); void silent.reload(); };

  return (
    <main className="page">
      <section className="hero">
        <div>
          <p className="eyebrow">Command view</p>
          <h1>Citizens ask. Volunteers act. You coordinate.</h1>
          <p>Requests, SOS, offers and tasks on one map, with the silent zones where need is likely but nobody is asking.</p>
        </div>
        <div className="page-actions"><button className="btn" onClick={reload}>Refresh</button></div>
      </section>
      <ErrorNote error={reqs.error ?? tasks.error} />
      <div className="kpis">
        <Kpi to="/app/requests?status=new" label="Active SOS" value={sos.length} tone={sos.length ? "error" : undefined} />
        <Kpi to="/app/requests" label="Open requests" value={live.length} tone={live.some((r) => r.severity >= 3 && r.status === "new") ? "warn" : undefined} />
        <Kpi to="/app/tasks" label="Open tasks" value={openTasks.length} />
        <Kpi to="/app/offers" label="Offers available" value={avail.length} />
        <Kpi to="/app/silent-zones" label="Silent zones" value={zones.length} tone={zones.length ? "warn" : undefined} />
        {!isHiddenFor("authority", "/app/updates") && <Kpi to="/app/updates" label="Bulletins awaiting approval" value={(updates.data ?? []).filter((u) => u.status === "pending_approval").length} />}
      </div>
      <section className="card">
        <MapFrame height={520} bounds={boundsOf([...live, ...avail], zones.map((z) => z.bbox))}>
          <SilentCells zones={zones} />
          <OfferDots offers={avail} />
          <TaskDots tasks={openTasks} />
          <RequestDots requests={live} />
        </MapFrame>
        <Legend items={[["Life in danger", cssVar("--error")], ["Urgent", cssVar("--ochre")], ["Request", cssVar("--water")], ["Offer", cssVar("--ok")],
          ["Task", cssVar("--cyan"), true], ["Silent zone", cssVar("--violet"), true]]} />
        {silent.data?.run?.simulated && <p className="notice notice-warn">Silent zones come from a SIMULATED demo run.</p>}
      </section>
      <div className="dash-grid">
        <section className="card">
          <h2>Highest priority</h2>
          <ul className="list">
            {live.slice(0, 8).map((r) => (
              <li key={r.id}>
                <Link to={`/app/requests?open=${r.id}`}>{r.source === "sos" ? "SOS" : REQUEST_LABEL[r.type]} · {r.reporterName}</Link> <Severity s={r.severity} />
                {r.flags.includes("possible_accidental") && <Pill tone="warn">possibly accidental</Pill>}
                <p className="small">{(r.summaryEn || r.description).slice(0, 140)}</p>
              </li>
            ))}
            {live.length === 0 && <li className="muted small">No open requests.</li>}
          </ul>
        </section>
        <section className="card">
          <h2>Silent zones</h2>
          {zones.length === 0 && <p className="muted small">None flagged. Start a run on the <Link to="/app/estimates">Estimates</Link> page to look for unreported need.</p>}
          <ul className="list">
            {zones.slice(0, 6).map((z) => <li key={z.id}><strong>{z.place ?? z.id}</strong> <span className="small">{z.reason}</span><p className="small muted">{z.action}</p></li>)}
          </ul>
        </section>
      </div>
    </main>
  );
}

function Kpi({ label, value, tone, to }: { label: string; value: number; tone?: "error" | "warn"; to: string }) {
  return (
    <Link to={to} className={`kpi ${tone ? `kpi-${tone}` : ""}`}>
      <span className="kpi-value">{value}</span>
      <span className="kpi-label">{label}</span>
    </Link>
  );
}
