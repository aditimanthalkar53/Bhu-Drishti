import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "./auth";
import { api, ApiError, post } from "./api";
import { MapView } from "./components/MapView";
import { EXAMPLES, LIVE_EXAMPLES, QueryPanel, type ScopeReply } from "./components/QueryPanel";
import { ResultPanel } from "./components/ResultPanel";
import { unitFor } from "./format";
import type { CompileInfo, Plan, Region, Session } from "./types";
import { useQueryRun } from "./useQueryRun";

const DEFAULT_REGION = "in-assam-barpeta";

export default function App() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [bootError, setBootError] = useState<string | null>(null);
  const [regions, setRegions] = useState<Region[]>([]);
  const [regionId, setRegionId] = useState(params.get("region") ?? "");
  const [geometry, setGeometry] = useState<Record<string, Region["geometry"]>>({});
  const [projectId, setProjectId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [engineInfo, setEngineInfo] = useState<{ provider: string; compiler: string; live_data?: boolean } | null>(null);

  const [question, setQuestion] = useState(params.get("q") ?? LIVE_EXAMPLES[1].question);
  const [precision, setPrecision] = useState("");
  const [budget, setBudget] = useState("");
  const [preview, setPreview] = useState<{ compile: CompileInfo; plan: Plan } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [scope, setScope] = useState<ScopeReply | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);

  const { state: run, attach } = useQueryRun();
  // the left panel shows either the question form or the answer; a new or reopened run jumps to the answer
  const [tab, setTab] = useState<"ask" | "result">(params.get("open") ? "result" : "ask");
  useEffect(() => { if (run.id) setTab("result"); }, [run.id]);

  const refreshSessions = useCallback(async (pid: string) => {
    setSessions(await api<Session[]>(`/api/projects/${pid}/queries`));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [rs, projects, health] = await Promise.all([
          api<Region[]>("/api/regions"),
          api<{ id: string; name: string }[]>("/api/projects"),
          api("/api/health"),
        ]);
        if (cancelled) return;
        setRegions(rs);
        setRegionId((cur) => (cur && rs.some((r) => r.id === cur) ? cur
          : rs.find((r) => r.id === DEFAULT_REGION)?.id ?? rs[0]?.id ?? ""));
        setEngineInfo(health.engine?.ok ? health.engine : null);
        const p = projects.find((x) => x.name !== "Monitors") ?? projects[0];
        if (p) {
          setProjectId(p.id);
          await refreshSessions(p.id);
        }
        const open = params.get("open");
        if (open) {
          const d = await api(`/api/queries/${open}`).catch(() => null);
          if (d?.engine) {
            setQuestion(d.session.question);
            setRegionId(d.session.regionId);
            attach(open, d.engine.compile);
          }
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

  // region outlines are fetched on demand (735 districts would be ~2 MB up front)
  useEffect(() => {
    if (!regionId || geometry[regionId]) return;
    api<Region>(`/api/regions/${encodeURIComponent(regionId)}`)
      .then((r) => setGeometry((g) => ({ ...g, [regionId]: r.geometry })))
      .catch(() => undefined);
  }, [regionId, geometry]);

  // switching between a demo and a live district swaps the example set
  const region = regions.find((r) => r.id === regionId);
  useEffect(() => {
    if (!region) return;
    const live = !region.simulated;
    const inLive = LIVE_EXAMPLES.some((e) => e.question === question);
    const inDemo = EXAMPLES.some((e) => e.question === question);
    if (live && inDemo) setQuestion(LIVE_EXAMPLES[1].question);
    if (!live && inLive) setQuestion(EXAMPLES[0].question);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region?.id]);

  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    setScope(null);
  }, [question, regionId, precision, budget]);

  /** Out-of-scope questions come back as a structured reply: show it as guidance, not as an error. */
  const showScope = (e: unknown): boolean => {
    const d = e instanceof ApiError ? e.body?.detail : null;
    if (d && typeof d === "object" && d.kind === "out_of_scope") {
      setScope(d as ScopeReply);
      return true;
    }
    return false;
  };

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
      if (!showScope(e)) setPreviewError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const start = async () => {
    if (!projectId) return;
    setPreviewError(null);
    setStarting(true);
    try {
      const r = await post(`/api/projects/${projectId}/queries`, { question, region_id: regionId, overrides });
      setPreview({ compile: r.compile, plan: r.plan });
      attach(r.session.id, r.compile);
      setParams((p) => { p.set("open", r.session.id); p.delete("q"); return p; }, { replace: true });
      void refreshSessions(projectId);
    } catch (e) {
      if (!showScope(e)) setPreviewError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    if (run.id) await post(`/api/queries/${run.id}/stop`).catch(() => undefined);
  };

  const openSession = async (s: Session) => {
    try {
      const d = await api(`/api/queries/${s.id}`);
      if (!d.engine) {
        setPreviewError("The engine was restarted, so this run's live details are gone. Its answer and report are kept in History.");
        return;
      }
      setQuestion(s.question);
      setRegionId(s.regionId);
      attach(s.id, d.engine.compile);
      setParams((p) => { p.set("open", s.id); return p; }, { replace: true });
    } catch (e) {
      setPreviewError((e as Error).message);
    }
  };

  useEffect(() => {
    if ((run.status === "done" || run.status === "stopped") && projectId) void refreshSessions(projectId);
  }, [run.status, projectId, refreshSessions]);

  const regionWithGeom = region ? { ...region, geometry: geometry[region.id] } : undefined;
  const confirmed = useMemo(() => new Set(run.result?.selected_tile_ids ?? []), [run.result]);
  const task = run.compile?.ir.task;
  const target = run.compile?.ir.target;

  if (bootError) {
    return (
      <main className="boot-error">
        <h1>Can't reach the Bhu-Drishti API</h1>
        <p>{bootError}</p>
        <p className="muted">Start the engine (port 8000) and the API (port 4000), then reload. The README has the commands.</p>
        <button className="btn" onClick={() => navigate("/")}>Back to home</button>
      </main>
    );
  }

  const running = run.status === "running";
  return (
    <div className="app explore">
      <section className="explore-panel" aria-label="Question and results">
        <div className="explore-head">
          <p className="muted small">Ask about any district in India — answers tighten as the engine works.</p>
          <div className="seg explore-tabs" role="tablist" aria-label="Panel">
            <button role="tab" id="tab-ask" aria-controls="panel-ask" aria-selected={tab === "ask"}
              className={tab === "ask" ? "active" : ""} onClick={() => setTab("ask")}>Ask a question</button>
            <button role="tab" id="tab-result" aria-controls="panel-result" aria-selected={tab === "result"}
              className={tab === "result" ? "active" : ""} onClick={() => setTab("result")}>
              Results{running && <span className="pulse" aria-label="running" />}
            </button>
          </div>
        </div>
        <div className="explore-body" id="panel-ask" role="tabpanel" aria-labelledby="tab-ask" hidden={tab !== "ask"}>
      <QueryPanel scope={scope}
        regions={regions} regionId={regionId} onRegion={setRegionId}
        question={question} onQuestion={setQuestion}
        precision={precision} onPrecision={setPrecision}
        budget={budget} onBudget={setBudget}
        preview={preview} previewError={previewError}
        checking={checking || starting} running={run.status === "running"} ready={!!projectId && regions.length > 0}
        onCheck={check} onRun={start} onStop={stop}
        sessions={sessions} onOpenSession={openSession} activeId={run.id}
      />
        </div>
        <div className="explore-body" id="panel-result" role="tabpanel" aria-labelledby="tab-result" hidden={tab !== "result"}>
          <ResultPanel key={run.id ?? "idle"} run={run} />
        </div>
      </section>
      <main className="pane pane-map" aria-label="Map">
        <MapView region={regionWithGeom} universe={run.universe} sampled={run.sampled} confirmedIds={confirmed}
          task={task} target={target} unit={task ? unitFor(task, target) : ""} runKey={run.id ?? "none"} />
        {region && (
          <div className={`map-info ${region.simulated ? "is-sim" : "is-live"}`}>
            <button type="button" className="map-info-btn" aria-describedby="map-info-tip"
              aria-label={region.simulated ? "About this simulated district" : "About the live data"}>
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="M12 11v6M12 7.5v.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
              </svg>
            </button>
            <p id="map-info-tip" role="tooltip" className="map-info-tip">
              {region.simulated ? (
                <><strong>Simulated district.</strong> Numbers come from a generated world with known ground truth so the engine's
                  claims can be checked. Pick a real district to use live Sentinel-1/2, WorldCover, DEM and NASA data.</>
              ) : (
                <><strong>Live data · {region.name}{region.state ? `, ${region.state}` : ""}.</strong> Satellite imagery is read from
                  Planetary Computer, Copernicus and NASA at run time — the first run in a district takes a few minutes.</>
              )}
              {engineInfo && (
                <span className="map-info-meta">
                  Engine: {engineInfo.live_data ? "live + demo data" : "demo data only"}, {engineInfo.compiler === "rules" ? "rule-based" : engineInfo.compiler} parser
                </span>
              )}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
