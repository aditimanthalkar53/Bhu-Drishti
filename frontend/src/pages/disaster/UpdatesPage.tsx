import { useState } from "react";
import { Link } from "react-router-dom";
import { post } from "../../api";
import { useAuth } from "../../auth";
import { Empty, ErrorNote, Page, Pill, useAction, useData } from "../common";

interface Update {
  id: string; title: string; body: string; area: string; severity: "info" | "advisory" | "warning" | "emergency"; expiresAt: string | null;
  status: "pending_approval" | "published" | "rejected"; authorId: string; authorName: string; approvedByName: string | null; publishedAt: string | null;
  createdAt: string; rejectedNote: string | null; delivery: { sent: number; failed: number; note: string | null } | null;
}
const TONE = { info: "info", advisory: "info", warning: "warn", emergency: "error" } as const;

/** Official bulletins: drafted by one authority, approved by a second, then published here and emailed. */
export function UpdatesPage() {
  const { user } = useAuth();
  const authority = user?.role === "authority";
  const list = useData<Update[]>("/api/updates");
  const groups = useData<{ id: string; name: string }[]>(authority ? "/api/groups" : null);
  const act = useAction();
  const [f, setF] = useState({ title: "", body: "", area: "", severity: "advisory", expiresAt: "", groupIds: [] as string[] });
  const published = (list.data ?? []).filter((u) => u.status === "published");
  const pending = (list.data ?? []).filter((u) => u.status === "pending_approval");

  const draft = () => act.run("draft", async () => {
    await post("/api/updates", { ...f, expiresAt: f.expiresAt ? new Date(f.expiresAt).toISOString() : null });
    setF({ title: "", body: "", area: "", severity: "advisory", expiresAt: "", groupIds: [] });
    await list.reload();
    return "Draft saved. A second authority must approve it before it is published.";
  });

  return (
    <Page title={authority ? "Updates & bulletins" : "Updates"} lead={<>Coordination bulletins from the response team, each approved by two officials. For official government warnings see <Link to="/app/sachet">SACHET alerts</Link>.</>}>
      <ErrorNote error={list.error ?? act.error} />
      {act.message && <p className="notice notice-ok">{act.message}</p>}
      {authority && (
        <section className="card">
          <h2>Draft a bulletin</h2>
          <div className="form-grid">
            <label className="field span-2"><span>Title</span><input value={f.title} maxLength={160} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
            <label className="field span-2"><span>Message</span><textarea value={f.body} maxLength={5000} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
            <label className="field"><span>Area</span><input value={f.area} maxLength={160} placeholder="e.g. Barpeta Road, wards 3-7" onChange={(e) => setF({ ...f, area: e.target.value })} /></label>
            <label className="field"><span>Severity</span>
              <select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>{["info", "advisory", "warning", "emergency"].map((s) => <option key={s}>{s}</option>)}</select></label>
            <label className="field"><span>Valid until</span><input type="datetime-local" value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} /></label>
            <fieldset className="field fieldset"><span>Email to groups <span className="muted">(<Link to="/app/recipients">manage</Link>)</span></span>
              {(groups.data ?? []).length === 0 && <span className="muted small">No groups yet: the bulletin is published to this feed only.</span>}
              {groups.data?.map((g) => (
                <label key={g.id} className="check"><input type="checkbox" checked={f.groupIds.includes(g.id)}
                  onChange={(e) => setF({ ...f, groupIds: e.target.checked ? [...f.groupIds, g.id] : f.groupIds.filter((x) => x !== g.id) })} /> {g.name}</label>
              ))}
            </fieldset>
          </div>
          <div className="row-actions"><button className="btn btn-primary" disabled={f.title.length < 3 || f.body.length < 3 || !!act.busy} onClick={() => void draft()}>Save draft for approval</button></div>
        </section>
      )}
      {authority && pending.length > 0 && (
        <section className="card">
          <h2>Waiting for a second approval ({pending.length})</h2>
          {pending.map((u) => (
            <article key={u.id} className="card">
              <div className="ev-head"><h3>{u.title}</h3><Pill tone={TONE[u.severity]}>{u.severity}</Pill></div>
              <p>{u.body}</p>
              <p className="muted small">Drafted by {u.authorName} · {u.area}</p>
              {u.authorId === user?.id ? <p className="muted small">You drafted this; another authority must approve it.</p> : (
                <div className="row-actions">
                  <button className="btn btn-primary btn-small" disabled={!!act.busy} onClick={() => void act.run(u.id, async () => {
                    const r = await post<Update>(`/api/updates/${u.id}/approve`); await list.reload();
                    return `Published. ${r.delivery?.note ?? `Emailed to ${r.delivery?.sent ?? 0}, failed ${r.delivery?.failed ?? 0}.`}`;
                  })}>Approve and publish</button>
                  <button className="btn btn-small" disabled={!!act.busy} onClick={() => void act.run(u.id, async () => {
                    const note = prompt("Why is it not approved?") ?? ""; await post(`/api/updates/${u.id}/reject`, { note }); await list.reload();
                  })}>Reject</button>
                </div>
              )}
            </article>
          ))}
        </section>
      )}
      {list.data && published.length === 0 && <Empty title="No current bulletins">Approved bulletins from the response team appear here.</Empty>}
      <div className="stack">
        {published.map((u) => (
          <article key={u.id} className="card alert-card">
            <div className="ev-head"><h2>{u.title}</h2><Pill tone={TONE[u.severity]}>{u.severity}</Pill></div>
            <p>{u.body}</p>
            <p className="muted small">{u.area} · published {u.publishedAt ? new Date(u.publishedAt).toLocaleString() : ""}{u.expiresAt ? ` · valid until ${new Date(u.expiresAt).toLocaleString()}` : ""}
              {" "}· approved by {u.authorName} and {u.approvedByName}</p>
          </article>
        ))}
      </div>
    </Page>
  );
}
