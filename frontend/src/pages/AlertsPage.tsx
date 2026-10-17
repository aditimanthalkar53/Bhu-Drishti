import { useState } from "react";
import { Link } from "react-router-dom";
import { patch } from "../api";
import { ago, fmt, fmtDate } from "../format";
import type { Alert } from "../types";
import { Empty, ErrorNote, Page, Pill, useAction, useData } from "./common";

export function AlertsPage() {
  const alerts = useData<Alert[]>("/api/alerts");
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const act = useAction();
  const list = (alerts.data ?? []).filter((a) => filter === "all" || a.status !== "resolved");

  const update = (a: Alert, body: Record<string, unknown>) => act.run(a.id, async () => {
    await patch(`/api/alerts/${a.id}`, { ...body, note: notes[a.id] || undefined });
    setNotes((n) => ({ ...n, [a.id]: "" }));
    await alerts.reload();
  });

  return (
    <Page title="Alerts" lead="Raised when a monitor's result crosses its threshold. Acknowledge, add notes and resolve them here."
      actions={
        <div className="seg">
          <button className={filter === "open" ? "active" : ""} onClick={() => setFilter("open")}>Open</button>
          <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>All</button>
        </div>
      }>
      <ErrorNote error={alerts.error ?? act.error} />
      {alerts.data && list.length === 0 && <Empty title={filter === "open" ? "No open alerts" : "No alerts yet"}>Alerts appear when a <Link to="/app/monitors">monitor</Link> crosses its threshold.</Empty>}
      <div className="stack">
        {list.map((a) => (
          <article key={a.id} className={`card alert-card alert-${a.status}`}>
            <div className="ev-head">
              <h2>{a.title}</h2>
              <Pill tone={a.status === "open" ? "error" : a.status === "acknowledged" ? "warn" : "ok"}>{a.status}</Pill>
            </div>
            <p>{a.message}</p>
            <p className="muted small">
              Value {fmt(a.value, 1)} · rule: {a.threshold.metric === "lo" ? "lower bound" : a.threshold.metric === "hi" ? "upper bound" : "estimate"} {a.threshold.op} {a.threshold.value}
              {" · "}raised {ago(a.createdAt)} · <Link to={`/app?open=${a.queryId}`}>open the run</Link>
            </p>
            <details>
              <summary className="small">History ({a.history.length})</summary>
              <ul className="small">
                {a.history.map((h, i) => <li key={i}>{fmtDate(h.at)} — {h.by}: {h.action}{h.note ? ` — “${h.note}”` : ""}</li>)}
              </ul>
            </details>
            {a.status !== "resolved" && (
              <div className="row-actions">
                <input className="input" placeholder="Note (optional), e.g. field team dispatched" value={notes[a.id] ?? ""}
                  onChange={(e) => setNotes((n) => ({ ...n, [a.id]: e.target.value }))} aria-label="Note" />
                {a.status === "open" && <button className="btn btn-small" disabled={act.busy === a.id} onClick={() => void update(a, { status: "acknowledged" })}>Acknowledge</button>}
                <button className="btn btn-small" disabled={act.busy === a.id} onClick={() => void update(a, { status: "resolved" })}>Resolve</button>
              </div>
            )}
          </article>
        ))}
      </div>
    </Page>
  );
}
