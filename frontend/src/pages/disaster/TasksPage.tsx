import { useEffect, useMemo, useState } from "react";
import { post } from "../../api";
import { useAuth } from "../../auth";
import { Empty, ErrorNote, Page, Pill, useAction, useData } from "../common";
import { getFix, lastFix, type Fix, type Task } from "./shared";

const TYPE: Record<Task["type"], string> = { field_check: "Area check", rescue: "Rescue", delivery: "Delivery", assessment: "Assessment", general: "Task" };
const PAGE = 10;

const km = (a: Fix, lat: number, lng: number) => {
  const toR = Math.PI / 180, dLat = (lat - a.lat) * toR, dLng = (lng - a.lng) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(lat * toR) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
};

/** "Field check: cell c006_005 (North-west)" → { name: "Area c006_005", area: "North-west" } */
function label(t: Task): { name: string; area: string | null } {
  if (t.type !== "field_check") return { name: t.title, area: null };
  const m = /cell (\S+) \(([^)]+)\)/.exec(t.title);
  return m ? { name: `Area ${m[1]}`, area: m[2] } : { name: t.title, area: null };
}

/** Volunteers pick a task, do it, and report back. Area checks feed the estimate of unreported need. */
export function TasksPage() {
  const { user } = useAuth();
  const tasks = useData<Task[]>("/api/tasks");
  const act = useAction();
  const [tab, setTab] = useState<"todo" | "mine" | "done">("todo");
  const [fix, setFix] = useState<Fix | null>(lastFix());
  useEffect(() => { void getFix(8000).then((f) => { if (f) setFix(f); }); }, []);

  const all = tasks.data ?? [];
  const mine = all.filter((t) => t.status === "claimed" && t.claimedBy === user?.id);
  const todo = all.filter((t) => t.status === "open");
  const done = all.filter((t) => (t.status === "done" || t.status === "unreachable") && (user?.role === "authority" || t.claimedBy === user?.id));
  useEffect(() => { if (tasks.data && mine.length > 0 && tab === "todo" && todo.length === 0) setTab("mine"); }, [tasks.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const near = (xs: Task[]) => (fix ? [...xs].sort((a, b) => (a.lat == null ? 1e9 : km(fix, a.lat, a.lng!)) - (b.lat == null ? 1e9 : km(fix, b.lat, b.lng!))) : xs);
  const run = (t: Task, path: string, body?: unknown, msg?: string) => act.run(t.id, async () => { await post(`/api/tasks/${t.id}/${path}`, body); await tasks.reload(); return msg; });
  const claim = (t: Task) => act.run(t.id, async () => { await post(`/api/tasks/${t.id}/claim`); await tasks.reload(); setTab("mine"); return `“${label(t).name}” is yours. Report back here when it is done.`; });

  const help = near(todo.filter((t) => t.type !== "field_check"));
  const checks = near(todo.filter((t) => t.type === "field_check"));

  return (
    <Page title="Tasks" lead="Pick a task, do it, and report back here.">
      <div className="seg" role="tablist" aria-label="Tasks">
        <button role="tab" aria-selected={tab === "todo"} className={tab === "todo" ? "active" : ""} onClick={() => setTab("todo")}>To do ({todo.length})</button>
        <button role="tab" aria-selected={tab === "mine"} className={tab === "mine" ? "active" : ""} onClick={() => setTab("mine")}>My tasks ({mine.length})</button>
        <button role="tab" aria-selected={tab === "done"} className={tab === "done" ? "active" : ""} onClick={() => setTab("done")}>Done ({done.length})</button>
      </div>
      <ErrorNote error={tasks.error ?? act.error} />
      {act.message && <p className="notice notice-ok">{act.message}</p>}
      {!tasks.data && !tasks.error && <p className="muted">Loading…</p>}

      {tab === "todo" && tasks.data && (
        todo.length === 0 ? <Empty title="No open tasks right now">New tasks appear here when the response team creates them.</Empty> : (
          <>
            {help.length > 0 && <TaskGroup title="Help people" tasks={help} fix={fix} busy={act.busy} onClaim={claim} />}
            {checks.length > 0 && (
              <TaskGroup title="Area checks" tasks={checks} fix={fix} busy={act.busy} onClaim={claim}
                intro={<HowAreaCheck />} />
            )}
          </>
        )
      )}

      {tab === "mine" && tasks.data && (
        mine.length === 0 ? <Empty title="You have no tasks">Pick one from “To do”.</Empty> : (
          <section className="card task-group">
            {mine.some((t) => t.type === "field_check") && <HowAreaCheck />}
            <ul className="task-list">
              {near(mine).map((t) => (
                <li key={t.id} className="task-row task-row-mine">
                  <TaskLine t={t} fix={fix} />
                  <Complete t={t} busy={!!act.busy} onDone={(body, msg) => void run(t, "complete", body, msg)} onRelease={() => void run(t, "release", undefined, "Released: someone else can take it.")} />
                </li>
              ))}
            </ul>
          </section>
        )
      )}

      {tab === "done" && tasks.data && (
        done.length === 0 ? <Empty title="Nothing done yet" /> : (
          <section className="card task-group">
            <ul className="task-list">
              {done.map((t) => (
                <li key={t.id} className="task-row">
                  <TaskLine t={t} fix={null} />
                  <span className="task-result">
                    {t.status === "unreachable" ? <Pill tone="error">couldn’t reach</Pill>
                      : t.result && typeof t.result.households === "number" ? <Pill tone="ok">{String(t.result.households)} households</Pill>
                      : <Pill tone="ok">done</Pill>}
                    {user?.role === "authority" && t.claimedByName && <span className="muted small"> by {t.claimedByName}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )
      )}
    </Page>
  );
}

function HowAreaCheck() {
  return (
    <div className="task-how small">
      <strong>How an area check works:</strong> go to the area (use <em>Map</em>), count the households that need rescue, food or water, shelter or
      medical help, and enter the number (0 is fine). Areas are picked at random, so please don’t check a different place instead.
      Can’t get there? Tap <em>Can’t reach</em>.
    </div>
  );
}

function TaskGroup({ title, tasks, fix, busy, onClaim, intro }: { title: string; tasks: Task[]; fix: Fix | null; busy: string | null; onClaim(t: Task): void; intro?: React.ReactNode }) {
  const [shown, setShown] = useState(PAGE);
  return (
    <section className="card task-group">
      <div className="ev-head"><h2>{title} <span className="muted small">({tasks.length})</span></h2>{fix && <span className="muted small">nearest first</span>}</div>
      {intro}
      <ul className="task-list">
        {tasks.slice(0, shown).map((t) => (
          <li key={t.id} className="task-row">
            <TaskLine t={t} fix={fix} />
            <button className="btn btn-small btn-primary btn-inline" disabled={!!busy} onClick={() => onClaim(t)}>{busy === t.id ? "…" : "Claim"}</button>
          </li>
        ))}
      </ul>
      {tasks.length > shown && <button className="link-btn" onClick={() => setShown(shown + PAGE * 2)}>Show {Math.min(PAGE * 2, tasks.length - shown)} more</button>}
    </section>
  );
}

function TaskLine({ t, fix }: { t: Task; fix: Fix | null }) {
  const { name, area } = label(t);
  const dist = fix && t.lat != null ? km(fix, t.lat, t.lng!) : null;
  return (
    <div className="task-main">
      <div className="task-title">{t.type !== "field_check" && <Pill tone="warn">{TYPE[t.type]}</Pill>} {name}</div>
      <div className="task-meta muted small">
        {[area, dist != null ? `${dist < 10 ? dist.toFixed(1) : Math.round(dist)} km away` : null].filter(Boolean).join(" · ")}
        {t.lat != null && <>{(area || dist != null) ? " · " : ""}<a href={`https://maps.google.com/?q=${t.lat},${t.lng}`} target="_blank" rel="noreferrer">Map</a></>}
      </div>
      {t.type !== "field_check" && t.description && <div className="task-desc small">{t.description}</div>}
    </div>
  );
}

function Complete({ t, busy, onDone, onRelease }: { t: Task; busy: boolean; onDone(body: unknown, msg: string): void; onRelease(): void }) {
  const [hh, setHh] = useState("");
  const [note, setNote] = useState("");
  const isCheck = useMemo(() => t.type === "field_check", [t.type]);
  if (!isCheck) return (
    <div className="task-actions">
      <input className="input" placeholder="What was done (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <button className="btn btn-primary btn-small btn-inline" disabled={busy} onClick={() => onDone({ note }, "Marked done. Thank you.")}>Done</button>
      <button className="btn btn-small" disabled={busy} onClick={onRelease}>Give back</button>
    </div>
  );
  return (
    <div className="task-actions">
      <input className="input task-count" type="number" min={0} inputMode="numeric" placeholder="Households" aria-label="Households that need help (0 if none)"
        value={hh} onChange={(e) => setHh(e.target.value)} />
      <button className="btn btn-primary btn-small btn-inline" disabled={busy || hh === ""} onClick={() => onDone({ note, result: { households: Number(hh) } }, "Thank you. The count is recorded.")}>Submit</button>
      <button className="btn btn-small" disabled={busy} onClick={() => { if (confirm("You could not reach this area? It stays on the list and the team is told.")) onDone({ note, unreachable: true }, "Noted: the team is told you could not reach it."); }}>Can’t reach</button>
      <button className="btn btn-small" disabled={busy} onClick={onRelease}>Give back</button>
    </div>
  );
}
