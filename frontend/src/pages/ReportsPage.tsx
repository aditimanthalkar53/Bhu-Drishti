import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { authUrl, del, patch, post } from "../api";
import { ago, fmtDate } from "../format";
import type { Group, Recipient, Report } from "../types";
import { Empty, ErrorNote, Page, Pill, ReportStatus, useAction, useData } from "./common";

export function ReportsPage() {
  const reports = useData<Report[]>("/api/reports");
  const [filter, setFilter] = useState("all");
  const act = useAction();
  const list = (reports.data ?? []).filter((r) => filter === "all" || r.status === filter);
  return (
    <Page title="Reports" lead="PDF reports built from analyses. Nothing reaches an official until someone approves it."
      actions={
        <button className="btn" disabled={act.busy === "gen"} onClick={() => void act.run("gen", async () => {
          const r = await post<{ created: number }>("/api/reports/generate", {});
          await reports.reload();
          return r.created ? `${r.created} bulletin(s) created from your monitors' latest runs.` : "No monitor has a finished run yet.";
        })}>{act.busy === "gen" ? "Generating…" : "Generate daily bulletin now"}</button>
      }>
      <ErrorNote error={reports.error ?? act.error} />
      {act.message && <p className="notice notice-ok">{act.message}</p>}
      <div className="seg">
        {["all", "pending_approval", "approved", "sent", "failed", "draft"].map((s) => (
          <button key={s} className={filter === s ? "active" : ""} onClick={() => setFilter(s)}>{s.replace(/_/g, " ")}</button>
        ))}
      </div>
      {reports.data && list.length === 0 && <Empty title="No reports here">Create one from a finished run in <Link to="/app">Explore</Link> (“Create report for officials”), or let a monitor make them.</Empty>}
      {list.length > 0 && (
        <section className="card">
          <table className="tbl">
            <thead><tr><th>Report</th><th>Status</th><th>Origin</th><th>Created</th></tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td><Link to={`/app/reports/${r.id}`}><strong>{r.title}</strong></Link><div className="muted small clamp-2">{r.summary}</div></td>
                  <td><ReportStatus status={r.status} /></td>
                  <td>{r.origin}</td>
                  <td className="small">{ago(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </Page>
  );
}

export function ReportDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const report = useData<Report>(`/api/reports/${id}`, [id]);
  const recipients = useData<Recipient[]>("/api/recipients");
  const groups = useData<Group[]>("/api/groups");
  const settings = useData<{ report_delivery: string; smtp_configured: boolean }>("/api/settings/integrations");
  const act = useAction();
  const [editing, setEditing] = useState(false);
  const r = report.data;
  const [pdfKey, setPdfKey] = useState(0);

  if (report.error) return <Page title="Report"><ErrorNote error={report.error} /></Page>;
  if (!r) return <Page title="Report"><p className="muted">Loading…</p></Page>;

  const canEdit = !["sending", "sent"].includes(r.status);
  const toggle = (key: "recipientIds" | "groupIds", v: string) => act.run("rcpt", async () => {
    const cur = r[key];
    await patch(`/api/reports/${r.id}`, { [key]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] });
    await report.reload();
  });

  return (
    <Page title={r.title} lead={<>Created {fmtDate(r.createdAt)} · {r.origin} · <ReportStatus status={r.status} /></>}
      actions={<Link className="btn" to="/app/reports">All reports</Link>}>
      <ErrorNote error={act.error} />
      {act.message && <p className="notice notice-ok">{act.message}</p>}
      <div className="report-layout">
        <div className="stack">
          <section className="card">
            <h2>Summary</h2>
            {editing ? (
              <EditSummary r={r} onDone={async () => { setEditing(false); await report.reload(); setPdfKey((k) => k + 1); }} />
            ) : (
              <>
                <p>{r.summary || <span className="muted">No summary.</span>}</p>
                {canEdit && <button className="link-btn" onClick={() => setEditing(true)}>Edit title / summary</button>}
              </>
            )}
            {r.note && <p className="muted small">Note: {r.note}</p>}
          </section>

          <section className="card">
            <h2>Approval and sending</h2>
            {r.status === "pending_approval" || r.status === "draft" ? (
              <>
                <p className="small">Check the figures, the data sources and the limitations in the PDF before approving. Approved reports can be emailed to the recipients below.</p>
                <div className="row-actions">
                  <button className="btn btn-primary btn-inline" disabled={!!act.busy} onClick={() => void act.run("approve", async () => {
                    await post(`/api/reports/${r.id}/approve`, {});
                    await report.reload();
                    return settings.data?.report_delivery === "n8n" ? "Approved and handed to n8n for delivery." : "Approved. You can send it now.";
                  })}>Approve</button>
                  {r.status === "pending_approval" && <button className="btn" disabled={!!act.busy} onClick={() => void act.run("reject", async () => {
                    const reason = prompt("Reason for rejecting (optional)") ?? "";
                    await post(`/api/reports/${r.id}/reject`, { reason });
                    await report.reload();
                  })}>Reject</button>}
                </div>
              </>
            ) : (
              <p className="small">{r.approvedAt ? `Approved ${fmtDate(r.approvedAt)}${r.approvedBy === "system" ? " (monitor set to auto-send)" : ""}.` : ""} {r.sentAt ? `Sent ${fmtDate(r.sentAt)}.` : ""}</p>
            )}
            {["approved", "partially_sent", "failed"].includes(r.status) && (
              <div className="row-actions">
                <button className="btn btn-primary btn-inline" disabled={!!act.busy || !(r.recipients?.length)} onClick={() => void act.run("send", async () => {
                  const res = await post<any>(`/api/reports/${r.id}/send`);
                  await report.reload();
                  return res.mode === "n8n" ? `Handed to n8n (${res.queued} recipients).` : `Sent to ${res.sent}, failed ${res.failed}.`;
                })}>{act.busy === "send" ? "Sending…" : `Email to ${r.recipients?.length ?? 0} recipient(s)`}</button>
                {settings.data && !settings.data.smtp_configured && settings.data.report_delivery === "smtp" && (
                  <span className="warn-text small">SMTP is not configured — see Settings.</span>
                )}
              </div>
            )}
            <p className="muted small">Delivery: {settings.data?.report_delivery === "n8n" ? "through n8n (webhook)" : "direct email (SMTP)"}.</p>
          </section>

          <section className="card">
            <h2>Recipients ({r.recipients?.length ?? 0})</h2>
            {(recipients.data?.length ?? 0) === 0 && <p className="muted small">No recipients yet — <Link to="/app/recipients">add officials</Link>.</p>}
            <div className="check-grid">
              {groups.data?.map((g) => (
                <label key={g.id}><input type="checkbox" disabled={!canEdit} checked={r.groupIds.includes(g.id)} onChange={() => void toggle("groupIds", g.id)} /> Group: {g.name}</label>
              ))}
              {recipients.data?.map((p) => (
                <label key={p.id}><input type="checkbox" disabled={!canEdit} checked={r.recipientIds.includes(p.id)} onChange={() => void toggle("recipientIds", p.id)} /> {p.name} <span className="muted small">{p.designation} · {p.email}{p.active ? "" : " · inactive"}</span></label>
              ))}
            </div>
          </section>

          <section className="card">
            <h2>Delivery log</h2>
            {(r.deliveries?.length ?? 0) === 0 ? <p className="muted small">Nothing sent yet.</p> : (
              <table className="tbl">
                <thead><tr><th>To</th><th>Status</th><th>Via</th><th>When</th></tr></thead>
                <tbody>
                  {r.deliveries!.map((d) => (
                    <tr key={d.id}><td>{d.to}</td><td><Pill tone={d.status === "sent" || d.status === "opened" ? "ok" : d.status === "failed" ? "error" : "info"}>{d.status}</Pill>
                      {d.error && <div className="error-text small">{d.error}</div>}</td><td>{d.via}</td><td className="small">{fmtDate(d.createdAt)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="card">
            <h2>Runs in this report</h2>
            <ul className="list">{r.queryIds.map((q) => <li key={q}><Link to={`/app?open=${q}`}>{q}</Link></li>)}</ul>
            {canEdit && <button className="btn btn-small btn-danger" onClick={() => void act.run("del", async () => {
              if (!confirm("Delete this report?")) return;
              await del(`/api/reports/${r.id}`);
              navigate("/app/reports");
            })}>Delete report</button>}
          </section>
        </div>
        <section className="card pdf-card">
          <div className="ev-head">
            <h2>PDF preview</h2>
            <a className="btn btn-small" href={authUrl(`/api/reports/${r.id}/pdf`)} target="_blank" rel="noreferrer">Open in new tab</a>
          </div>
          <iframe key={pdfKey} title="Report PDF" className="pdf-frame" src={authUrl(`/api/reports/${r.id}/pdf`)} />
        </section>
      </div>
    </Page>
  );
}

function EditSummary({ r, onDone }: { r: Report; onDone: () => Promise<void> }) {
  const [title, setTitle] = useState(r.title);
  const [summary, setSummary] = useState(r.summary);
  const act = useAction();
  return (
    <div className="form-grid">
      <label className="field span-2"><span>Title</span><input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="field span-2"><span>Summary (goes into the email body)</span><textarea rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} /></label>
      {r.status === "approved" && <p className="warn-text small span-2">Editing an approved report sends it back for approval.</p>}
      <div className="row-actions span-2">
        <button className="btn btn-primary btn-inline" disabled={!!act.busy} onClick={() => void act.run("save", async () => {
          await patch(`/api/reports/${r.id}`, { title, summary });
          await onDone();
        })}>Save</button>
        <button className="btn" onClick={() => void onDone()}>Cancel</button>
      </div>
      <ErrorNote error={act.error} />
    </div>
  );
}
