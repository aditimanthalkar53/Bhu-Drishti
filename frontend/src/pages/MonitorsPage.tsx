import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { del, patch, post } from "../api";
import { ago, fmt, fmtDate } from "../format";
import type { AOI, Escalation, Group, Monitor, Recipient, Schedule, Threshold } from "../types";
import { Empty, ErrorNote, Page, Pill, useAction, useData } from "./common";

const QUESTIONS = [
  { label: "Flooded cropland share (last 14 days)", q: "What percentage of cropland was flooded in the last 14 days?", metric: "lo" as const, value: 10 },
  { label: "Fire detections (last 5 days)", q: "How many fire detections were there in the last 5 days?", metric: "value" as const, value: 50 },
  { label: "Burned cropland (last 30 days)", q: "How much cropland was burned in the last 30 days, within 25%?", metric: "lo" as const, value: 20 },
];

function scheduleText(s: Schedule) {
  switch (s.type) {
    case "interval": return `every ${s.hours} h`;
    case "daily": return `daily at ${s.time} IST`;
    case "new_pass": return "on every new Sentinel-1 pass";
    default: return "manual only";
  }
}

export function MonitorsPage() {
  const [params] = useSearchParams();
  const monitors = useData<Monitor[]>("/api/monitors");
  const aois = useData<AOI[]>("/api/aois");
  const recipients = useData<Recipient[]>("/api/recipients");
  const groups = useData<Group[]>("/api/groups");
  const act = useAction();

  const [name, setName] = useState("");
  const [aoiId, setAoiId] = useState(params.get("aoi") ?? "");
  const [question, setQuestion] = useState(QUESTIONS[0].q);
  const [schedType, setSchedType] = useState<Schedule["type"]>("new_pass");
  const [hours, setHours] = useState("24");
  const [time, setTime] = useState("08:00");
  const [useThreshold, setUseThreshold] = useState(true);
  const [threshold, setThreshold] = useState<Threshold>({ metric: "lo", op: ">=", value: 10 });
  const [recipientIds, setRecipientIds] = useState<string[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [autoReport, setAutoReport] = useState(false);
  const [requireApproval, setRequireApproval] = useState(true);
  const [esc, setEsc] = useState<Escalation>({ enabled: false, ackMinutes: 60, severeValue: null, criticalValue: null });

  useEffect(() => {
    if (!aoiId && aois.data?.length) setAoiId(aois.data[0].id);
  }, [aois.data, aoiId]);
  const aoi = aois.data?.find((a) => a.id === aoiId);
  useEffect(() => {
    if (aoi && !name) setName(`${aoi.name} watch`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aoi?.id]);

  // monitors refresh while one is running
  useEffect(() => {
    if (!monitors.data?.some((m) => m.lastStatus === "running")) return;
    const t = setInterval(() => void monitors.reload(), 8000);
    return () => clearInterval(t);
  }, [monitors.data, monitors]);

  const schedule: Schedule = schedType === "interval" ? { type: "interval", hours: Number(hours) || 24 }
    : schedType === "daily" ? { type: "daily", time } : schedType === "new_pass" ? { type: "new_pass" } : { type: "manual" };

  const create = () => act.run("create", async () => {
    if (!aoiId) throw new Error("Add an area of interest first.");
    await post("/api/monitors", { name, aoiId, question, schedule, threshold: useThreshold ? threshold : null, recipientIds, groupIds, autoReport, requireApproval,
      escalation: esc.enabled && useThreshold ? esc : null });
    setName("");
    await monitors.reload();
    return "Monitor created. It checks the question against the area now, and runs on its schedule.";
  });

  const toggle = (arr: string[], id: string) => (arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);

  return (
    <Page title="Monitors" lead="Questions that re-run on a schedule or whenever a new satellite pass lands, and raise an alert above a threshold.">
      <ErrorNote error={monitors.error ?? aois.error} />
      {aois.data && aois.data.length === 0 ? (
        <Empty title="Add an area first"><Link to="/app/areas">Create an area of interest</Link> — monitors run on one.</Empty>
      ) : (
        <section className="card">
          <h2>New monitor</h2>
          <div className="form-grid">
            <label className="field"><span>Area</span>
              <select value={aoiId} onChange={(e) => setAoiId(e.target.value)}>
                {aois.data?.map((a) => <option key={a.id} value={a.id}>{a.name}{a.kind === "demo" ? " (simulated)" : ""}</option>)}
              </select>
            </label>
            <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></label>
            <label className="field span-2"><span>Question</span>
              <textarea rows={2} value={question} onChange={(e) => setQuestion(e.target.value)} />
            </label>
            <div className="examples span-2">
              {QUESTIONS.map((x) => (
                <button key={x.label} type="button" className="chip" aria-pressed={question === x.q}
                  onClick={() => { setQuestion(x.q); setThreshold({ metric: x.metric, op: ">=", value: x.value }); }}>{x.label}</button>
              ))}
            </div>
            <label className="field"><span>Schedule</span>
              <select value={schedType} onChange={(e) => setSchedType(e.target.value as Schedule["type"])}>
                <option value="new_pass">On every new Sentinel-1 pass (checked every 30 min)</option>
                <option value="daily">Daily at a fixed time (IST)</option>
                <option value="interval">Every N hours</option>
                <option value="manual">Manual only</option>
              </select>
            </label>
            {schedType === "interval" && <label className="field"><span>Hours</span><input inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} /></label>}
            {schedType === "daily" && <label className="field"><span>Time (IST)</span><input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>}
            <fieldset className="field span-2 fieldset">
              <legend><label><input type="checkbox" checked={useThreshold} onChange={(e) => setUseThreshold(e.target.checked)} /> Raise an alert when</label></legend>
              {useThreshold && (
                <div className="inline-fields">
                  <select value={threshold.metric} onChange={(e) => setThreshold({ ...threshold, metric: e.target.value as Threshold["metric"] })} aria-label="Which number">
                    <option value="lo">the lower confidence bound (conservative)</option>
                    <option value="value">the estimate</option>
                    <option value="hi">the upper confidence bound (sensitive)</option>
                  </select>
                  <select value={threshold.op} onChange={(e) => setThreshold({ ...threshold, op: e.target.value as Threshold["op"] })} aria-label="Comparison">
                    {[">=", ">", "<=", "<"].map((o) => <option key={o}>{o}</option>)}
                  </select>
                  <input inputMode="decimal" value={String(threshold.value)} aria-label="Threshold value"
                    onChange={(e) => setThreshold({ ...threshold, value: Number(e.target.value) })} />
                </div>
              )}
              <p className="muted small">Using the lower bound means an alert fires only when the data are confident the value is above the threshold.</p>
            </fieldset>
            <fieldset className="field span-2 fieldset">
              <legend>Send reports to</legend>
              {(groups.data?.length ?? 0) + (recipients.data?.length ?? 0) === 0 && <p className="muted small">No recipients yet — <Link to="/app/recipients">add officials</Link>.</p>}
              <div className="check-grid">
                {groups.data?.map((g) => (
                  <label key={g.id}><input type="checkbox" checked={groupIds.includes(g.id)} onChange={() => setGroupIds(toggle(groupIds, g.id))} /> Group: {g.name}</label>
                ))}
                {recipients.data?.map((r) => (
                  <label key={r.id}><input type="checkbox" checked={recipientIds.includes(r.id)} onChange={() => setRecipientIds(toggle(recipientIds, r.id))} /> {r.name} <span className="muted small">{r.designation}</span></label>
                ))}
              </div>
            </fieldset>
            <fieldset className="field span-2 fieldset">
              <legend><label><input type="checkbox" checked={esc.enabled} disabled={!useThreshold} onChange={(e) => setEsc({ ...esc, enabled: e.target.checked })} /> Escalate to higher authorities</label></legend>
              {esc.enabled && (
                <div className="form-grid">
                  <label className="field"><span>If nobody confirms within (minutes)</span>
                    <input inputMode="numeric" value={String(esc.ackMinutes)} onChange={(e) => setEsc({ ...esc, ackMinutes: Number(e.target.value) || 60 })} /></label>
                  <label className="field"><span>Also tell one level up at or above <span className="muted">(optional)</span></span>
                    <input inputMode="decimal" value={esc.severeValue ?? ""} onChange={(e) => setEsc({ ...esc, severeValue: e.target.value === "" ? null : Number(e.target.value) })} /></label>
                  <label className="field"><span>Also tell two levels up at or above <span className="muted">(optional)</span></span>
                    <input inputMode="decimal" value={esc.criticalValue ?? ""} onChange={(e) => setEsc({ ...esc, criticalValue: e.target.value === "" ? null : Number(e.target.value) })} /></label>
                </div>
              )}
              <p className="muted small">The people ticked above are told first. Each of them reports to someone on the <Link to="/app/recipients">Recipients</Link> page, and that person is told next. Officials confirm with a link in the email.</p>
            </fieldset>
            <label className="check"><input type="checkbox" checked={requireApproval} onChange={(e) => setRequireApproval(e.target.checked)} /> Reports need human approval before they are sent (recommended)</label>
            <label className="check"><input type="checkbox" checked={autoReport} onChange={(e) => setAutoReport(e.target.checked)} /> Make a report after every run (not only on alerts)</label>
          </div>
          <div className="row-actions">
            <button className="btn btn-primary btn-inline" onClick={() => void create()} disabled={act.busy === "create"}>{act.busy === "create" ? "Checking the question…" : "Create monitor"}</button>
          </div>
          <ErrorNote error={act.error} />
          {act.message && <p className="notice notice-ok">{act.message}</p>}
        </section>
      )}

      <section className="card">
        <h2>Your monitors</h2>
        {monitors.data && monitors.data.length === 0 && <p className="muted small">None yet.</p>}
        {monitors.data && monitors.data.length > 0 && (
          <div className="table-scroll">
            <table className="tbl">
              <thead><tr><th>Monitor</th><th>Schedule</th><th>Alert when</th><th>Last run</th><th className="num">Last value</th><th>Next</th><th /></tr></thead>
              <tbody>
                {monitors.data.map((m) => (
                  <tr key={m.id} className={m.enabled ? "" : "row-off"}>
                    <td><strong>{m.name}</strong><div className="muted small">{m.question}</div>
                      {m.lastError && <div className="error-text small">{m.lastError}</div>}</td>
                    <td>{scheduleText(m.schedule)}</td>
                    <td>{m.threshold ? `${m.threshold.metric === "lo" ? "lower bound" : m.threshold.metric === "hi" ? "upper bound" : "estimate"} ${m.threshold.op} ${m.threshold.value}` : "–"}
                      {m.escalation?.enabled && <div className="muted small">escalates after {m.escalation.ackMinutes} min{m.escalation.severeValue != null ? `, severe at ${m.escalation.severeValue}` : ""}{m.escalation.criticalValue != null ? `, critical at ${m.escalation.criticalValue}` : ""}</div>}</td>
                    <td>{m.lastStatus ? <Pill tone={m.lastStatus === "triggered" ? "error" : m.lastStatus === "failed" ? "warn" : m.lastStatus === "running" ? "info" : "ok"}>{m.lastStatus}</Pill> : <Pill tone="muted">never</Pill>}
                      <div className="muted small">{ago(m.lastRunAt)}</div>
                      {m.lastQueryId && <Link className="small" to={`/app?open=${m.lastQueryId}`}>open run</Link>}</td>
                    <td className="num">{m.lastValue != null ? fmt(m.lastValue, 1) : "–"}</td>
                    <td className="small">{m.enabled ? (m.nextRunAt ? fmtDate(m.nextRunAt) : m.schedule.type === "new_pass" ? "next pass" : "–") : "paused"}</td>
                    <td className="row-actions">
                      <button className="btn btn-small" disabled={m.lastStatus === "running"} onClick={() => void act.run(`run-${m.id}`, async () => {
                        await post(`/api/monitors/${m.id}/run`);
                        setTimeout(() => void monitors.reload(), 1500);
                        return "Run started — live runs take a few minutes.";
                      })}>Run now</button>
                      {m.escalation?.enabled && (
                        <button className="btn btn-small" title="Rehearse the alert chain without running a satellite analysis" onClick={() => void act.run(`drill-${m.id}`, async () => {
                          const raw = prompt("Value to rehearse with (compare with the severe and critical levels):", String(m.escalation?.severeValue ?? m.threshold?.value ?? 0));
                          if (raw === null) return;
                          await post(`/api/monitors/${m.id}/drill`, { value: Number(raw) });
                          return "Drill started. See Alerts for who was told.";
                        })}>Drill</button>
                      )}
                      <button className="btn btn-small" onClick={() => void act.run(`tog-${m.id}`, async () => {
                        await patch(`/api/monitors/${m.id}`, { enabled: !m.enabled });
                        await monitors.reload();
                      })}>{m.enabled ? "Pause" : "Resume"}</button>
                      <button className="btn btn-small btn-danger" onClick={() => void act.run(`del-${m.id}`, async () => {
                        if (!confirm(`Delete monitor “${m.name}”?`)) return;
                        await del(`/api/monitors/${m.id}`);
                        await monitors.reload();
                      })}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Page>
  );
}
