import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { patch, post } from "../api";
import { ago, fmt, fmtDate } from "../format";
import { LEVELS, type Alert } from "../types";
import { Empty, ErrorNote, Page, Pill, useAction, useData } from "./common";

export function AlertsPage() {
  const alerts = useData<Alert[]>("/api/alerts");
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const act = useAction();
  const [tick, setTick] = useState(0);
  // chains move on their own, so refresh while something is open and keep the countdowns moving
  useEffect(() => {
    const t = setInterval(() => { setTick((n) => n + 1); if (alerts.data?.some((a) => a.status === "open" && a.escalation?.enabled)) void alerts.reload(); }, 15_000);
    return () => clearInterval(t);
  }, [alerts]);
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
            {a.drill && <p className="notice notice-warn">Drill: a rehearsal of the alert chain. No satellite analysis was run.</p>}
            {a.notified?.length > 0 && <Chain a={a} tick={tick} />}
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
                {a.escalation?.enabled && <button className="btn btn-small" disabled={act.busy === a.id} onClick={() => void act.run(a.id, async () => { await post(`/api/alerts/${a.id}/escalate`); await alerts.reload(); })}>Escalate now</button>}
                <button className="btn btn-small" disabled={act.busy === a.id} onClick={() => void update(a, { status: "resolved" })}>Resolve</button>
              </div>
            )}
          </article>
        ))}
      </div>
    </Page>
  );
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

/** Who has been told, level by level, who confirmed, and when the next level will be told. */
function Chain({ a, tick }: { a: Alert; tick: number }) {
  void tick;
  const byLevel = new Map<number, Alert["notified"]>();
  for (const n of a.notified) byLevel.set(n.level, [...(byLevel.get(n.level) ?? []), n]);
  const confirmed = new Set((a.confirmedBy ?? []).map((c) => c.recipientId));
  const waitMs = a.status === "open" && a.escalation?.enabled
    ? Date.parse(a.lastEscalatedAt ?? a.createdAt) + a.escalation.ackMinutes * 60_000 - Date.now() : null;
  return (
    <div className="alert-chain" aria-label="Who has been told">
      <h3>Who has been told</h3>
      <ol>
        {[...byLevel.entries()].sort((x, y) => x[0] - y[0]).map(([level, rows]) => (
          <li key={level}>
            <span className="pill pill-info">{LEVELS[level] ?? `Level ${level}`}</span>
            <ul>
              {rows.map((n, i) => (
                <li key={`${n.recipientId}-${i}`}>
                  <strong>{n.name}</strong>{n.designation && <span className="muted"> · {n.designation}</span>}
                  <span className="muted small"> · {clock(n.at)} · </span>
                  {confirmed.has(n.recipientId) ? <span className="pill pill-ok">confirmed</span>
                    : n.status === "failed" ? <span className="pill pill-error" title={n.error}>email failed</span> : <span className="pill pill-warn">waiting for confirmation</span>}
                  <div className="muted small">{n.reason}</div>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      {waitMs !== null && (
        <p className="small">{waitMs > 0 ? `If nobody confirms, the next level up is told in ${Math.ceil(waitMs / 60_000)} min.` : "The next level up is due to be told now."}</p>
      )}
      {a.confirmedBy && a.confirmedBy.length > 0 && <p className="small">Confirmed by {a.confirmedBy.map((c) => `${c.name} (${clock(c.at)})`).join(", ")}. Escalation has stopped.</p>}
    </div>
  );
}
