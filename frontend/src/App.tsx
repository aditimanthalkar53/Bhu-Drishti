import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "./auth";
import { api, post } from "./api";
import { MapView } from "./components/MapView";
import { EXAMPLES, QueryPanel } from "./components/QueryPanel";
import { ResultPanel } from "./components/ResultPanel";
import { unitFor } from "./format";
import type { CompileInfo, Plan, Region, Session } from "./types";
import { useQueryRun } from "./useQueryRun";

export default function App() {
  const { user, loginAsGuest } = useAuth();
  const navigate = useNavigate();
  const [bootError, setBootError] = useState<string | null>(null);
  const [regions, setRegions] = useState<Region[]>([]);
  const [regionId, setRegionId] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [engineInfo, setEngineInfo] = useState<{ provider: string; compiler: string } | null>(null);

  const [question, setQuestion] = useState(EXAMPLES[0].question);
  const [precision, setPrecision] = useState("");
  const [budget, setBudget] = useState("");
  const [preview, setPreview] = useState<{ compile: CompileInfo; plan: Plan } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const { state: run, attach } = useQueryRun();

  const refreshSessions = useCallback(async (pid: string) => {
    setSessions(await api<Session[]>(`/api/projects/${pid}/queries`));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // If no authenticated user yet, ensure a guest session exists so API calls work
        if (!user) await loginAsGuest().catch(() => undefined);
        const [rs, projects, health] = await Promise.all([
          api<Region[]>("/api/regions"),
          api<{ id: string }[]>("/api/projects"),
          api("/api/health"),
        ]);
        if (cancelled) return;
        setRegions(rs);
        setRegionId(rs[0]?.id ?? "");
        setEngineInfo(health.engine?.ok ? health.engine : null);
        if (projects[0]) {
          setProjectId(projects[0].id);
          await refreshSessions(projects[0].id);
        }
      } catch (e) {
        if (!cancelled) setBootError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSessions, user?.id]);

  // the preview is stale as soon as the inputs change
  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
  }, [question, regionId, precision, budget]);

  const overrides = useMemo(() => {
    const o: Record<string, unknown> = {};
    const p = parseFloat(precision);
    if (Number.isFinite(p) && p > 0) o.precision = p;
    const b = parseFloat(budget);
    if (Number.isFinite(b) && b > 0) o.budget_seconds = b;
    return o;
  }, [precision, budget]);

  const check = async () => {
    setChecking(true);
    setPreviewError(null);
    try {
      setPreview(await post("/api/compile", { question, region_id: regionId, overrides }));
    } catch (e) {
      setPreviewError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const start = async () => {
    if (!projectId) return;
    setPreviewError(null);
    try {
      const r = await post(`/api/projects/${projectId}/queries`, { question, region_id: regionId, overrides });
      setPreview({ compile: r.compile, plan: r.plan });
      attach(r.session.id, r.compile);
      void refreshSessions(projectId);
    } catch (e) {
      setPreviewError((e as Error).message);
    }
  };

  const stop = async () => {
    if (run.id) await post(`/api/queries/${run.id}/stop`).catch(() => undefined);
  };

  const openSession = async (s: Session) => {
    try {
      const d = await api(`/api/queries/${s.id}`);
      if (!d.engine) {
        setPreviewError("The engine was restarted, so this run's details are gone. Its answer is kept in your history.");
        return;
      }
      setQuestion(s.question);
      setRegionId(s.regionId);
      attach(s.id, d.engine.compile);
    } catch (e) {
      setPreviewError((e as Error).message);
    }
  };

  useEffect(() => {
    if ((run.status === "done" || run.status === "stopped") && projectId) void refreshSessions(projectId);
  }, [run.status, projectId, refreshSessions]);

  const region = regions.find((r) => r.id === regionId);
  const confirmed = useMemo(() => new Set(run.result?.selected_tile_ids ?? []), [run.result]);
  const task = run.compile?.ir.task;

  if (bootError) {
    return (
      <main className="boot-error">
        <h1>Can't reach the SatQuery API</h1>
        <p>{bootError}</p>
        <p className="muted">Start the engine (port 8000) and the API (port 4000), then reload. The README has the commands.</p>
        <button className="btn" onClick={() => navigate("/")}>Back to home</button>
      </main>
    );
  }

  return (
    <div className="app">
      <QueryPanel
        regions={regions} regionId={regionId} onRegion={setRegionId}
        question={question} onQuestion={setQuestion}
        precision={precision} onPrecision={setPrecision}
        budget={budget} onBudget={setBudget}
        preview={preview} previewError={previewError}
        checking={checking} running={run.status === "running"} ready={!!projectId && regions.length > 0}
        onCheck={check} onRun={start} onStop={stop}
        sessions={sessions} onOpenSession={openSession} activeId={run.id}
      />
      <main className="pane pane-map" aria-label="Map">
        <MapView region={region} universe={run.universe} sampled={run.sampled} confirmedIds={confirmed}
          task={task} unit={task ? unitFor(task) : ""} runKey={run.id ?? "none"} />
        {region?.simulated && (
          <p className="sim-banner">
            Simulated district. Numbers come from a procedurally generated world with known ground truth, so the engine's
            claims can be checked. Switch the engine to real Sentinel data with <code>AEQE_PROVIDER=planetary_computer</code>.
          </p>
        )}
        {engineInfo && (
          <p className="engine-info small">Engine on {engineInfo.provider} data, {engineInfo.compiler === "rules" ? "rule-based" : engineInfo.compiler} parser</p>
        )}
      </main>
      <ResultPanel key={run.id ?? "idle"} run={run} />
    </div>
  );
}
