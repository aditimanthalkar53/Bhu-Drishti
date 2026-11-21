import { useState } from "react";
import { post } from "../../api";
import { useAuth } from "../../auth";
import { Empty, ErrorNote, Page, Pill, useAction, useData } from "../common";
import { Status, type Task } from "./shared";

const TYPE: Record<Task["type"], string> = { field_check: "Field check", rescue: "Rescue", delivery: "Delivery", assessment: "Assessment", general: "Task" };

/** Volunteers claim open tasks; field checks record a household count (or "unreachable"), which feeds the Maun estimate. */
export function TasksPage() {
  const { user } = useAuth();
  const [filter, setFilter] = useState<"open" | "mine" | "all">("open");
  const tasks = useData<Task[]>("/api/tasks");
  const act = useAction();
  const list = (tasks.data ?? []).filter((t) => filter === "all" || (filter === "open" ? t.status === "open" : t.claimedBy === user?.id && t.status === "claimed"));
  const run = (t: Task, path: string, body?: unknown, msg?: string) => act.run(t.id, async () => { await post(`/api/tasks/${t.id}/${path}`, body); await tasks.reload(); return msg; });

  return (
    <Page title="Tasks" lead="Claim a task, do it, and report back. Field checks are chosen at random: please do not swap them for easier places.">
      <div className="seg" role="group" aria-label="Show">
        {(["open", "mine", "all"] as const).map((k) => <button key={k} className={filter === k ? "active" : ""} onClick={() => setFilter(k)}>{k === "mine" ? "Claimed by me" : k}</button>)}
      </div>
      <ErrorNote error={tasks.error ?? act.error} />
      {act.message && <p className="notice notice-ok">{act.message}</p>}
      {tasks.data && list.length === 0 && <Empty title="Nothing here">{filter === "open" ? "No open tasks right now." : "No tasks."}</Empty>}
      <div className="stack">
        {list.map((t) => (
          <article key={t.id} className="card">
            <div className="ev-head"><h2>{t.title}</h2><span><Pill tone={t.type === "field_check" ? "info" : "warn"}>{TYPE[t.type]}</Pill> <Status s={t.status} /></span></div>
            <p className="small">{t.description}</p>
            {t.lat != null && <p className="small"><a href={`https://maps.google.com/?q=${t.lat},${t.lng}`} target="_blank" rel="noreferrer">Open in maps</a> · {t.lat.toFixed(4)}, {t.lng!.toFixed(4)}</p>}
            {t.claimedByName && <p className="muted small">Claimed by {t.claimedByName}</p>}
            {t.status === "open" && <div className="row-actions"><button className="btn btn-primary btn-small" disabled={!!act.busy} onClick={() => void run(t, "claim")}>Claim</button></div>}
            {t.status === "claimed" && (t.claimedBy === user?.id || user?.role === "authority") && <Complete t={t} busy={!!act.busy} onDone={(body, msg) => void run(t, "complete", body, msg)} onRelease={() => void run(t, "release")} />}
            {t.result && <p className="muted small">Result: {JSON.stringify(t.result)}</p>}
          </article>
        ))}
      </div>
    </Page>
  );
}

function Complete({ t, busy, onDone, onRelease }: { t: Task; busy: boolean; onDone(body: unknown, msg: string): void; onRelease(): void }) {
  const [hh, setHh] = useState("");
  const [note, setNote] = useState("");
  if (t.type !== "field_check") return (
    <div className="row-actions">
      <input className="input" placeholder="What was done (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <button className="btn btn-primary btn-small" disabled={busy} onClick={() => onDone({ note }, "Marked done. Thank you.")}>Done</button>
      <button className="btn btn-small" disabled={busy} onClick={onRelease}>Release</button>
    </div>
  );
  return (
    <div className="stack">
      <label className="field"><span>Households in this cell that need rescue, food or water, shelter or medical help (0 if none)</span>
        <input type="number" min={0} value={hh} onChange={(e) => setHh(e.target.value)} /></label>
      <input className="input" placeholder="Notes (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="row-actions">
        <button className="btn btn-primary btn-small" disabled={busy || hh === ""} onClick={() => onDone({ note, result: { households: Number(hh) } }, "Recorded. The estimate updates now.")}>Submit count</button>
        <button className="btn btn-danger btn-small" disabled={busy} onClick={() => { if (confirm("Mark this cell unreachable? It stays in the sample and is flagged as a priority.")) onDone({ note, unreachable: true }, "Marked unreachable. The team is alerted."); }}>Cannot reach it</button>
        <button className="btn btn-small" disabled={busy} onClick={onRelease}>Release</button>
      </div>
    </div>
  );
}
