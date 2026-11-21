import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, authUrl, patch, post } from "../../api";
import { Empty, ErrorNote, Page, Pill, useAction, useData } from "../common";
import { boundsOf, LANGUAGES, MapFrame, OFFER_LABEL, REQUEST_LABEL, RequestDots, Severity, Status, type HelpRequest, type Offer } from "./shared";

const STATUSES = ["new", "verified", "assigned", "in_progress", "resolved", "cancelled"];
const SOURCES: Record<string, string> = { sos: "SOS", form: "Form", local_language: "Own words", drain_watch: "Drain Watch" };

/** Authority triage board: sorted by severity × confidence. Low confidence never hides a request. */
export function RequestsPage() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState("open");
  const [source, setSource] = useState("");
  const reqs = useData<HelpRequest[]>(`/api/requests?sort=priority${source ? `&source=${source}` : ""}`, [source]);
  const open = params.get("open");
  const list = (reqs.data ?? []).filter((r) => status === "all" || (status === "open" ? r.status !== "resolved" && r.status !== "cancelled" : r.status === status));
  const sel = (reqs.data ?? []).find((r) => r.id === open) ?? null;
  const pick = (id: string | null) => { const p = new URLSearchParams(params); if (id) p.set("open", id); else p.delete("open"); setParams(p, { replace: true }); };

  return (
    <Page title="Requests" lead="Every request, SOS and Drain Watch report. Sorted by severity × confidence; confidence comes from nearby reports, the hazard layer and the reporter's history."
      actions={<button className="btn btn-small" onClick={() => void reqs.reload()}>Refresh</button>}>
      <div className="row-actions">
        <div className="seg" role="group" aria-label="Status">
          {["open", ...STATUSES, "all"].map((s) => <button key={s} className={status === s ? "active" : ""} onClick={() => setStatus(s)}>{s.replace(/_/g, " ")}</button>)}
        </div>
        <select className="input" aria-label="Source" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">All sources</option>{Object.entries(SOURCES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <ErrorNote error={reqs.error} />
      <div className="dash-grid">
        <section className="card">
          <MapFrame height={360} bounds={boundsOf(list)}><RequestDots requests={list} onPick={(r) => pick(r.id)} /></MapFrame>
        </section>
        {sel ? <Detail r={sel} onChange={() => void reqs.reload()} onClose={() => pick(null)} /> : (
          <section className="card"><p className="muted small">Select a request in the list or on the map.</p></section>
        )}
      </div>
      {reqs.data && list.length === 0 && <Empty title="No requests in this view" />}
      {list.length > 0 && (
        <div className="table-scroll card">
          <table className="tbl">
            <thead><tr><th>Severity</th><th>Type</th><th>What</th><th>Source</th><th>Confidence</th><th>Status</th><th>When</th></tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id} aria-selected={r.id === open} onClick={() => pick(r.id)} style={{ cursor: "pointer" }}>
                  <td><Severity s={r.severity} /></td>
                  <td>{REQUEST_LABEL[r.type]}</td>
                  <td className="small">{(r.summaryEn || r.description).slice(0, 110)}{r.flags.length > 0 && <div>{r.flags.map((f) => <Pill key={f} tone={f === "possible_accidental" || f === "repeated" ? "warn" : "muted"}>{f.replace(/_/g, " ")}</Pill>)}</div>}</td>
                  <td>{SOURCES[r.source]}</td>
                  <td className="num">{r.confidence ? `${Math.round(r.confidence.score * 100)}%` : "–"}</td>
                  <td><Status s={r.status} /></td>
                  <td className="small">{new Date(r.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}

function Detail({ r, onChange, onClose }: { r: HelpRequest; onChange(): void; onClose(): void }) {
  const act = useAction();
  const suggest = useData<{ offer: Offer; km: number | null; score: number }[]>(`/api/matches/suggest?requestId=${r.id}`, [r.id]);
  const set = (body: Record<string, unknown>) => act.run("triage", async () => { await patch(`/api/requests/${r.id}`, body); onChange(); });
  const lang = r.originalLanguage ? LANGUAGES[r.originalLanguage] ?? r.originalLanguage : null;
  const photos = useMemo(() => [...(r.drain?.photos ?? []), ...(r.drain?.confirmations ?? []).flatMap((c) => c.photos)], [r.drain]);
  return (
    <section className="card">
      <div className="ev-head">
        <h2>{r.source === "sos" ? "SOS" : REQUEST_LABEL[r.type]} · {r.reporterName}</h2>
        <button className="link-btn" onClick={onClose}>Close</button>
      </div>
      <p><Severity s={r.severity} /> <Status s={r.status} /> {r.flags.map((f) => <Pill key={f} tone="warn">{f.replace(/_/g, " ")}</Pill>)}</p>
      {r.originalText && r.summaryEn ? (
        <div className="split">
          <div><span className="muted small">Original{lang ? ` (${lang})` : ""}</span><p>{r.originalText}</p></div>
          <div><span className="muted small">English summary{r.intake ? ` (AI, ${Math.round((r.intake.confidence ?? 0) * 100)}%${r.intake.edited ? ", edited by citizen" : ""})` : ""}</span><p>{r.summaryEn}</p></div>
        </div>
      ) : <p>{r.originalText || r.description}</p>}
      {r.needs.length > 0 && <p className="small">Needs: {r.needs.join(", ")}</p>}
      <p className="small">
        {r.lat != null ? <><a href={`https://maps.google.com/?q=${r.lat},${r.lng}`} target="_blank" rel="noreferrer">{r.lat.toFixed(5)}, {r.lng!.toFixed(5)}</a> (±{r.accuracyM ?? "?"} m)</> : "No location"}
        {r.area ? ` · ${r.area}` : ""}{r.peopleAffected != null ? ` · ${r.peopleAffected} people` : ""}{r.contact ? ` · ${r.contact}` : ""}
      </p>
      {r.confidence && <p className="muted small">Confidence {Math.round(r.confidence.score * 100)}%: nearby reports {Math.round(r.confidence.factors.corroboration * 100)}%,
        hazard {r.confidence.factors.hazard == null ? "not loaded" : `${Math.round(r.confidence.factors.hazard * 100)}%`}, reporter history {Math.round(r.confidence.factors.reporter * 100)}%</p>}
      {r.drain && (
        <div className="stack">
          <p className="small">Drain Watch: {r.drain.category.replace(/_/g, " ")} (chosen by {r.drain.categorySource === "ai" ? "AI suggestion" : "citizen"}) · {r.drain.confirmations.length} confirmation(s) ·
            forwarded: {r.drain.forwarded.status}{r.drain.forwarded.to ? ` to ${r.drain.forwarded.to}` : ""}</p>
          <div className="photo-row">{photos.map((p) => <a key={p} href={authUrl(`/api/drain/${r.id}/photos/${p}`)} target="_blank" rel="noreferrer"><img src={authUrl(`/api/drain/${r.id}/photos/${p}`)} alt="Drain Watch photo" /></a>)}</div>
          <div className="row-actions">
            <a className="btn btn-small" href={authUrl(`/api/drain/${r.id}/report.pdf`)} target="_blank" rel="noreferrer">PDF</a>
            <button className="btn btn-small" disabled={!!act.busy} onClick={() => void act.run("fwd", async () => { await post(`/api/drain/${r.id}/forward`); onChange(); return "Forwarded."; })}>Forward again</button>
          </div>
        </div>
      )}
      <div className="row-actions">
        <select className="input" aria-label="Status" value={r.status} onChange={(e) => void set({ status: e.target.value })}>{STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}</select>
        <select className="input" aria-label="Severity" value={r.severity} onChange={(e) => void set({ severity: Number(e.target.value) })}>{[4, 3, 2, 1].map((s) => <option key={s} value={s}>severity {s}</option>)}</select>
        <button className="btn btn-small" disabled={!!act.busy} onClick={() => void act.run("task", async () => {
          await api("/api/tasks", { method: "POST", body: JSON.stringify({ title: `${REQUEST_LABEL[r.type]}: ${r.reporterName}`, type: r.type === "rescue" ? "rescue" : "assessment", description: r.summaryEn || r.description, requestId: r.id }) });
          await set({ status: "assigned" });
          return "Task created for volunteers.";
        })}>Create volunteer task</button>
      </div>
      <h3>Suggested offers</h3>
      {suggest.data?.length === 0 && <p className="muted small">No available offers.</p>}
      <ul className="list">
        {suggest.data?.slice(0, 5).map((s) => (
          <li key={s.offer.id} className="row-actions">
            <span className="small"><strong>{OFFER_LABEL[s.offer.type] ?? s.offer.type}</strong> {s.offer.quantity} {s.offer.unit} · {s.offer.offeredByName}{s.km != null ? ` · ${s.km} km` : ""} · match {Math.round(s.score * 100)}%</span>
            <button className="btn btn-small" disabled={!!act.busy} onClick={() => void act.run("m", async () => { await post("/api/matches", { requestId: r.id, offerId: s.offer.id }); onChange(); await suggest.reload(); return "Matched; a delivery task was created."; })}>Match</button>
          </li>
        ))}
      </ul>
      <ErrorNote error={act.error} />
      {act.message && <p className="notice notice-ok">{act.message}</p>}
    </section>
  );
}

interface Person { id: string; email: string; name: string; role: string; phone: string | null; ward: string | null; language: string; skills: string[]; resources: string[]; allowListed: boolean }

export function VolunteersPage() {
  const [role, setRole] = useState("volunteer");
  const people = useData<Person[]>(`/api/admin/users${role ? `?role=${role}` : ""}`, [role]);
  const act = useAction();
  return (
    <Page title="People" lead="Volunteers and other accounts. Only an administrator listed in AUTHORITY_EMAILS can change roles.">
      <div className="seg" role="group" aria-label="Role">
        {[["volunteer", "Volunteers"], ["citizen", "Citizens"], ["authority", "Authorities"], ["", "Everyone"]].map(([k, v]) => <button key={k} className={role === k ? "active" : ""} onClick={() => setRole(k)}>{v}</button>)}
      </div>
      <ErrorNote error={people.error ?? act.error} />
      {act.message && <p className="notice notice-ok">{act.message}</p>}
      {people.data?.length === 0 && <Empty title="Nobody here yet" />}
      {!!people.data?.length && (
        <div className="table-scroll card">
          <table className="tbl">
            <thead><tr><th>Name</th><th>Ward</th><th>Phone</th><th>Skills / resources</th><th>Language</th><th>Role</th></tr></thead>
            <tbody>
              {people.data.map((p) => (
                <tr key={p.id}>
                  <td><strong>{p.name}</strong><div className="muted small">{p.email}</div></td>
                  <td>{p.ward ?? "–"}</td><td>{p.phone ?? "–"}</td>
                  <td className="small">{[...p.skills, ...p.resources].join(", ") || "–"}</td><td>{LANGUAGES[p.language] ?? p.language}</td>
                  <td>{p.allowListed ? <Pill tone="info">authority (allow-list)</Pill> : (
                    <select className="input" aria-label={`Role of ${p.name}`} value={p.role} onChange={(e) => void act.run(p.id, async () => {
                      await post(`/api/admin/users/${p.id}/role`, { role: e.target.value }); await people.reload(); return `${p.name} is now ${e.target.value}.`;
                    })}>{["citizen", "volunteer", "authority"].map((r) => <option key={r}>{r}</option>)}</select>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}
