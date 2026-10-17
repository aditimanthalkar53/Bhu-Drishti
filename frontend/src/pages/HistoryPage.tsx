import { useState } from "react";
import { Link } from "react-router-dom";
import { authUrl, post } from "../api";
import { fmtDate, stopReasonLabel } from "../format";
import type { Session } from "../types";
import { Empty, ErrorNote, Page, Pill, useAction, useData } from "./common";

export function HistoryPage() {
  const [source, setSource] = useState("");
  const hist = useData<Session[]>(`/api/history${source ? `?source=${source}` : ""}`, [source]);
  const [selected, setSelected] = useState<string[]>([]);
  const act = useAction();
  const done = (s: Session) => s.status === "done" || s.status === "stopped";

  return (
    <Page title="History" lead="Every analysis you or your monitors ran. Open one to see its map and evidence, or bundle several into a report."
      actions={
        <button className="btn btn-primary btn-inline" disabled={!selected.length || act.busy === "rep"} onClick={() => void act.run("rep", async () => {
          const r = await post<{ id: string }>("/api/reports", { queryIds: selected });
          window.location.assign(`/app/reports/${r.id}`);
        })}>Create report from {selected.length || "selected"} run{selected.length === 1 ? "" : "s"}</button>
      }>
      <ErrorNote error={hist.error ?? act.error} />
      <div className="seg">
        {[["", "All"], ["user", "Asked by people"], ["monitor", "From monitors"]].map(([v, l]) => (
          <button key={v} className={source === v ? "active" : ""} onClick={() => setSource(v)}>{l}</button>
        ))}
      </div>
      {hist.data && hist.data.length === 0 && <Empty title="No runs yet"><Link to="/app">Ask a question</Link> to get started.</Empty>}
      {hist.data && hist.data.length > 0 && (
        <section className="card">
          <div className="table-scroll">
            <table className="tbl">
              <thead><tr><th aria-label="Select" /><th>Question</th><th>Area</th><th>Data</th><th>Status</th><th>When</th><th /></tr></thead>
              <tbody>
                {hist.data.map((s) => (
                  <tr key={s.id}>
                    <td><input type="checkbox" disabled={!done(s)} checked={selected.includes(s.id)} aria-label="Include in report"
                      onChange={() => setSelected((x) => (x.includes(s.id) ? x.filter((y) => y !== s.id) : [...x, s.id]))} /></td>
                    <td><strong>{s.question}</strong>{s.answer && <div className="small clamp-2">{s.answer}</div>}</td>
                    <td className="small">{s.regionId}</td>
                    <td>{s.data_mode ? <Pill tone={s.data_mode === "live" ? "info" : "warn"}>{s.data_mode}</Pill> : "–"}</td>
                    <td><Pill tone={s.status === "done" ? "ok" : s.status === "failed" ? "error" : "muted"}>{s.status}</Pill>
                      {s.stop_reason && <div className="muted small">{stopReasonLabel(s.stop_reason)}</div>}</td>
                    <td className="small">{fmtDate(s.createdAt)}{s.source === "monitor" && <div className="muted">monitor</div>}</td>
                    <td className="row-actions">
                      <Link className="btn btn-small" to={`/app?open=${s.id}`}>Open</Link>
                      {done(s) && <a className="btn btn-small" href={authUrl(`/api/queries/${s.id}/report.pdf?style=simple`)}>Summary PDF</a>}
                      {done(s) && <a className="btn btn-small" href={authUrl(`/api/queries/${s.id}/report.pdf`)}>Technical PDF</a>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </Page>
  );
}
