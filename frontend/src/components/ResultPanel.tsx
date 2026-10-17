import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, authUrl, post, traceUrl } from "../api";
import { useAuth } from "../auth";
import { digitsFor, fmt, fmtInt, fmtSeconds, halfwidthPct, stopReasonLabel, unitFor } from "../format";
import { AdvisoryView, EvidenceList, InputsList } from "./Evidence";
import type { ExhaustiveReport, QueryIR, ReplayReport } from "../types";
import type { RunState } from "../useQueryRun";
import { ConvergenceChart } from "./ConvergenceChart";
import { IntervalRibbon } from "./IntervalRibbon";

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ResultPanel({ run }: { run: RunState }) {
  const [exhaustive, setExhaustive] = useState<ExhaustiveReport | null>(null);
  const [replay, setReplay] = useState<ReplayReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showTiles, setShowTiles] = useState(false);
  const { user } = useAuth();
  const [mailTo, setMailTo] = useState(user && !user.guest ? user.email : "");
  const [mailStatus, setMailStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const navigate = useNavigate();

  const ir: QueryIR | undefined = run.compile?.ir;
  const task = ir?.task;
  const target = ir?.target;
  const census = run.estimate?.method === "census";
  const e = run.estimate;
  const res = run.result;
  const pop = run.progress?.population ?? run.plan?.population ?? null;

  if (run.status === "idle") {
    return (
      <aside className="pane pane-result" aria-label="Result">
        <div className="empty">
          <h2>Ask a question to start</h2>
          <p className="muted">
            Pick an example or type your own. The engine samples only the tiles it needs, and the answer appears within
            seconds with a confidence interval that narrows while it keeps working. Stop it whenever the interval is good enough.
          </p>
          <ul className="how muted">
            <li>Cheap signals (a coarse radar overview, land cover, fire detections) score every tile.</li>
            <li>Expensive analysis of full-resolution imagery runs only on a statistically chosen sample.</li>
            <li>Rainfall, MODIS flood maps and forecasts are attached as context — never mixed into the number.</li>
            <li>Every step, tile, satellite scene and model output is recorded so the answer can be replayed.</li>
          </ul>
        </div>
      </aside>
    );
  }

  const digits = census ? 0 : task ? digitsFor(task) : 1;
  const unit = task ? unitFor(task, target) : "";
  const targetHw = ir && task === "area_fraction" ? ir.precision
    : ir && e && (task === "total" || task === "count") ? (ir.precision / 100) * Math.abs(e.value) : null;
  const running = run.status === "running";
  const budget = ir ? Math.min(ir.budget_tiles, pop ?? ir.budget_tiles) : null;

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const exportEvidence = () =>
    act("evidence", async () => {
      const fc = await api(`/api/queries/${run.id}/evidence`);
      download(`bhu-drishti-evidence-${run.id}.geojson`, JSON.stringify(fc), "application/geo+json");
    });

  const createReport = () =>
    act("report", async () => {
      const r = await post<{ id: string }>("/api/reports", { queryIds: [run.id] });
      navigate(`/app/reports/${r.id}`);
    });

  const emailReport = async () => {
    setBusy("email");
    setMailStatus(null);
    try {
      const r = await post<{ message: string }>(`/api/queries/${run.id}/email-report`, { email: mailTo.trim() });
      setMailStatus({ ok: true, text: r.message });
    } catch (err) {
      setMailStatus({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const exportCsv = () => {
    const rows = [["tile_id", "value", "stratum", "role", "from_cache"]];
    for (const t of run.sampled.values()) rows.push([t.tile_id, String(t.value), String(t.stratum), t.role ?? "", String(t.cache)]);
    download(`bhu-drishti-tiles-${run.id}.csv`, rows.map((r) => r.join(",")).join("\n"), "text/csv");
  };

  const lastTiles = [...run.sampled.values()].slice(-60).reverse();
  // Find-all starts with the trivial bound (anything from 0 to every tile); scale the
  // ribbon and chart from the first certified interval so the narrowing stays visible.
  const history = task === "find_all" && pop
    ? run.history.filter((h) => h.hi - h.lo < 0.5 * pop)
    : run.history;

  return (
    <aside className="pane pane-result" aria-label="Result" aria-busy={running}>
      <div className="status-line" role="status">
        {running ? (
          <>
            <span className="pulse" aria-hidden="true" />
            <span>
              {!run.progress && run.stage ? run.stage : !run.progress && !run.plan ? "Validating inputs and starting…" : (
                <>Analysing tiles — {fmtInt(run.progress?.n ?? 0)}{pop ? ` of ${fmtInt(pop)}` : ""} so far</>
              )}
            </span>
          </>
        ) : run.status === "failed" ? (
          <span className="error-text">Run failed</span>
        ) : (
          <span>{res ? stopReasonLabel(res.stop_reason) : "Finished"}</span>
        )}
      </div>
      {running && budget ? (
        <div className="progress" aria-hidden="true">
          <div style={{ width: `${Math.min(100, (100 * (run.progress?.n ?? 0)) / budget)}%` }} />
        </div>
      ) : null}

      {run.error && <p className="notice notice-error" role="alert">{run.error}</p>}

      {task === "inspect" && e?.answers ? (
        <section className="headline">
          <h2 className="question">{ir?.question}</h2>
          <ul className="answers">
            {Object.entries(e.answers).sort((a, b) => b[1] - a[1]).map(([a, k]) => (
              <li key={a}><strong>{k}</strong> tiles: {a}</li>
            ))}
          </ul>
        </section>
      ) : (
        <section className="headline">
          {res?.data_mode && (
            <span className={`mode-badge ${res.data_mode === "live" ? "mode-live" : "mode-sim"}`}>
              {res.data_mode === "live" ? "Live satellite data" : "Simulated demo data"}
            </span>
          )}
          <h2 className="question">{ir?.question}</h2>
          <p className="big-number">
            {e ? fmt(e.value, digits) : "…"}
            <span className="big-unit">{unit}</span>
          </p>
          <p className="ci-text">
            {e ? (census ? (
              <>Exact count over every tile <span className="muted">(no sampling)</span></>
            ) : (
              <>
                {Math.round((ir?.confidence ?? 0.95) * 100)}% interval {fmt(e.lo, digits)} – {fmt(e.hi, digits)}
                {task && task !== "find_all" ? <span className="muted"> ({halfwidthPct(task, e)})</span> : null}
              </>
            )) : "waiting for the first batch"}
          </p>
          {e?.interval_method && !census && <p className="muted small">{e.interval_method}</p>}
          {census && e?.by_confidence && (
            <p className="small">
              {fmtInt(e.by_confidence.high)} high · {fmtInt(e.by_confidence.nominal)} nominal · {fmtInt(e.by_confidence.low)} low confidence
              {e.on_cropland !== undefined && <> · {fmtInt(e.on_cropland)} on cropland</>}
              {e.newest_detection && <span className="muted"> · newest {e.newest_detection}</span>}
            </p>
          )}
          {task === "find_all" && e?.recall_lower_bound !== undefined && (
            <p className="recall">
              {fmtInt(e.confirmed_positive_tiles)} tiles confirmed. Certified recall ≥ {fmt(100 * e.recall_lower_bound, 0)}%
              <span className="muted"> (target {ir?.precision}%)</span>
            </p>
          )}
          {!census && (
            <IntervalRibbon history={history} digits={digits} unit={unit} targetHalfwidth={targetHw}
              clamp={task === "area_fraction" ? [0, 100] : [0, Infinity]} />
          )}
        </section>
      )}

      {res && <p className="answer">{res.answer}</p>}

      <dl className="stats">
        <div><dt>Tiles analysed</dt><dd>{fmtInt(run.progress?.n ?? res?.n ?? 0)}{pop ? <span className="muted"> / {fmtInt(pop)}</span> : null}</dd></div>
        <div><dt>Model runs · cache hits</dt><dd>{fmtInt(run.progress?.oracle_calls ?? 0)} · {fmtInt(run.progress?.cache_hits ?? 0)}</dd></div>
        <div><dt>Elapsed</dt><dd>{fmtSeconds(run.progress?.elapsed_s ?? 0)}</dd></div>
        {res && res.projected_exhaustive_s > 0 && (
          <div><dt>Every tile would take</dt><dd>{fmtSeconds(res.projected_exhaustive_s)}</dd></div>
        )}
        {e?.proxy_r2 !== undefined && <div><dt>Proxy model R²</dt><dd>{fmt(e.proxy_r2, 2)}</dd></div>}
        {run.plan && <div><dt>Specialist model</dt><dd className="small">{run.plan.oracle.name} <span className="muted">({run.plan.sensor})</span></dd></div>}
      </dl>

      {task !== "inspect" && !census && (
        <ConvergenceChart history={history} digits={digits} unit={unit} population={pop} />
      )}

      {res?.priority_tiles && res.priority_tiles.length > 0 && (
        <section className="caveats" aria-label="Priority tiles">
          <h3>Priority tiles for field review</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Tile (lon, lat)</th><th className="num">Detections</th><th className="num">High</th><th>Last seen (UTC)</th></tr></thead>
              <tbody>
                {res.priority_tiles.slice(0, 15).map((t) => (
                  <tr key={t.tile_id}>
                    <td>{t.bbox ? `${fmt(t.bbox[0] + 0.005, 3)}, ${fmt(t.bbox[1] + 0.005, 3)}` : t.tile_id}</td>
                    <td className="num">{fmtInt(Number(t.detections ?? 0))}</td>
                    <td className="num">{fmtInt(Number((t as any).high ?? 0))}</td>
                    <td>{String((t as any).last_seen ?? "–")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {res && res.caveats.length > 0 && (
        <section className="caveats" aria-label="What the interval does and doesn't cover">
          <h3>Read before quoting</h3>
          <ul>{res.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
        </section>
      )}

      {(run.evidence || res?.supporting_evidence) && (
        <EvidenceList items={run.evidence ?? res?.supporting_evidence ?? []} />
      )}
      {res?.inputs_summary && res.inputs_summary.length > 0 && <InputsList inputs={res.inputs_summary} />}
      {res?.advisory && <AdvisoryView advisory={res.advisory} />}

      {res && (
        <section className="evidence">
          <h3>Evidence and checks</h3>
          <div className="btn-grid">
            <button className="btn btn-accent" disabled={!!busy} onClick={createReport}>
              {busy === "report" ? "Creating…" : "Create report for officials"}
            </button>
            <a className="btn" href={authUrl(`/api/queries/${run.id}/report.pdf`)} download>Download PDF</a>
            {!census && <button className="btn" disabled={!!busy} onClick={() => act("exhaustive", async () =>
              setExhaustive(await post(`/api/queries/${run.id}/exhaustive`)))}>
              {busy === "exhaustive" ? "Analysing every tile…" : res.data_mode === "live" ? "Compare with every tile (slow)" : "Compare with every tile"}
            </button>}
            <button className="btn" disabled={!!busy} onClick={() => act("replay", async () =>
              setReplay(await post(`/api/queries/${run.id}/replay`)))}>
              {busy === "replay" ? "Replaying…" : "Replay and verify"}
            </button>
            <a className="btn" href={traceUrl(run.id!)} download>Download execution trace</a>
            <button className="btn" disabled={!!busy} onClick={exportEvidence}>Export map evidence (GeoJSON)</button>
            <button className="btn" onClick={exportCsv}>Export analysed tiles (CSV)</button>
          </div>
          <form className="email-report" onSubmit={(ev) => { ev.preventDefault(); void emailReport(); }}>
            <input type="email" required placeholder="you@example.com" aria-label="Email address for the PDF report"
              value={mailTo} onChange={(ev) => setMailTo(ev.target.value)} />
            <button className="btn" type="submit" disabled={!!busy || run.status !== "done"}>
              {busy === "email" ? "Sending…" : "Email PDF report"}
            </button>
          </form>
          {mailStatus && (
            <p className={`notice ${mailStatus.ok ? "notice-ok" : "notice-error"}`} role="status">{mailStatus.text}</p>
          )}
          {actionError && <p className="notice notice-error" role="alert">{actionError}</p>}
          {exhaustive && (
            <div className={`report ${exhaustive.inside_interval ? "report-ok" : "report-miss"}`}>
              <p>
                <strong>{exhaustive.inside_interval ? "Inside the interval." : "Outside the interval."}</strong>{" "}
                Running the model on all {fmtInt(exhaustive.exhaustive_tiles)} tiles gives {fmt(exhaustive.oracle_answer, digits)} {unit};
                the engine said {fmt(exhaustive.anytime_estimate, digits)} using {fmtInt(exhaustive.anytime_oracle_calls)} tiles
                ({fmt(exhaustive.call_reduction, 1)}× fewer model runs).
              </p>
              {exhaustive.achieved_recall !== undefined && (
                <p>Actual recall of the returned tiles: {fmt(100 * exhaustive.achieved_recall, 1)}%.</p>
              )}
              {exhaustive.simulated_reality !== undefined && (
                <p className="muted small">
                  Simulated ground truth: {fmt(exhaustive.simulated_reality, digits)} {unit}. The gap to the full model run
                  ({fmt(exhaustive.oracle_error_vs_reality, digits)}) is the model's own error, which no sampling interval covers.
                </p>
              )}
            </div>
          )}
          {replay && (
            <div className={`report ${replay.identical ? "report-ok" : "report-miss"}`}>
              <p>
                <strong>{replay.identical ? "Replay identical." : "Replay differs."}</strong>{" "}
                Same seed, same tile order, {fmtInt(replay.replay_oracle_calls)} new model runs (results came from cache).
              </p>
            </div>
          )}
        </section>
      )}

      {run.sampled.size > 0 && (
        <section className="tiles">
          <button type="button" className="link-btn" onClick={() => setShowTiles((v) => !v)} aria-expanded={showTiles}>
            {showTiles ? "Hide" : "Show"} the latest analysed tiles as a table
          </button>
          {showTiles && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Tile</th><th className="num">Value</th><th>Source</th></tr></thead>
                <tbody>
                  {lastTiles.map((t) => (
                    <tr key={t.tile_id}>
                      <td>{t.tile_id.split(":").pop()}</td>
                      <td className="num">{fmt(t.value, unit === "kilns" ? 0 : 3)}</td>
                      <td>{t.role === "audit" ? "random audit" : t.role === "frontier" ? "top-down" : `stratum ${t.stratum + 1}`}{t.cache ? ", cached" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </aside>
  );
}
