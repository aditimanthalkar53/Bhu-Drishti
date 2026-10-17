import { useState } from "react";
import type { CompileInfo, Plan, Region, Session } from "../types";
import { precisionLabel, targetLabel, taskLabel } from "../format";
import { RegionPicker } from "./RegionPicker";

/** Examples for the simulated demo districts (fixed 2017–2025 archive). */
export const EXAMPLES: { label: string; question: string }[] = [
  { label: "Flood share", question: "What percentage of cropland was flooded during 1-15 July 2023?" },
  { label: "Flooded area", question: "How many km² of cropland were flooded during 1-15 August 2022?" },
  { label: "New construction", question: "How much new built-up area appeared between 2020 and 2024?" },
  { label: "Kiln count", question: "How many brick kilns are there in 2024?" },
  { label: "Find kilns", question: "Find all brick kilns in 2024 with recall 90%" },
  { label: "Inspect a spot", question: "Is there flooding near 26.42, 91.05 in July 2022?" },
];

/** Examples for real districts (live Sentinel / NASA data). */
export const LIVE_EXAMPLES: { label: string; question: string }[] = [
  { label: "Recent flooding", question: "What percentage of cropland was flooded in the last 14 days?" },
  { label: "Past flood event", question: "What percentage of cropland was flooded during 1-15 July 2024, within 5 pp?" },
  { label: "Fires (10 days)", question: "How many fire detections were there in the last 10 days?" },
  { label: "Fire hotspots", question: "Identify areas with recent fire detections and prioritize them for review" },
  { label: "Burned cropland (experimental)", question: "How much cropland was burned between 15 October 2025 and 15 November 2025, within 25%?" },
  { label: "New construction", question: "How much new built-up area appeared between 2020 and 2025, within 25%?" },
];

/** A wider set of ready questions for live districts — type your own any way you like, these are just starting points. */
export const MORE_QUESTIONS: { group: string; items: string[] }[] = [
  { group: "Floods", items: [
    "Is any farmland under water right now?",
    "How many hectares of cropland were flooded in the last 30 days?",
    "What share of cropland was waterlogged during August 2024?",
    "Map the fields that were flooded between 1 and 20 July 2024",
  ] },
  { group: "Fires and stubble burning", items: [
    "How many fires were detected this week?",
    "Where were the stubble-burning hotspots in the last 5 days?",
    "How many crop fires were there between 15 October 2025 and 15 November 2025?",
    "Which villages had farm fires since 1 Oct?",
  ] },
  { group: "Construction", items: [
    "How much land was built on between 2020 and 2025?",
    "How many square kilometres of new buildings came up since 2021?",
  ] },
];

/** The engine's reply when a question is outside what Bhu-Drishti measures. */
export interface ScopeReply {
  kind: "out_of_scope";
  category: "help" | "related" | "off_topic";
  topic: string | null;
  message: string;
  suggestions: string[];
  supported: string[];
}

interface Props {
  scope?: ScopeReply | null;
  regions: Region[];
  regionId: string;
  onRegion: (id: string) => void;
  question: string;
  onQuestion: (q: string) => void;
  precision: string;
  onPrecision: (v: string) => void;
  budget: string;
  onBudget: (v: string) => void;
  preview: { compile: CompileInfo; plan: Plan } | null;
  previewError: string | null;
  checking: boolean;
  running: boolean;
  ready: boolean;
  onCheck: () => void;
  onRun: () => void;
  onStop: () => void;
  sessions: Session[];
  onOpenSession: (s: Session) => void;
  activeId: string | null;
}

export function QueryPanel(p: Props) {
  const [showHistory, setShowHistory] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const ir = p.preview?.compile.ir;
  const blocking = p.preview?.plan.checks.filter((c) => c.blocking && !c.ok) ?? [];
  const region = p.regions.find((r) => r.id === p.regionId);
  const examples = region && !region.simulated ? LIVE_EXAMPLES : EXAMPLES;

  return (
    <aside className="pane pane-query" aria-label="Ask a question">
      <form
        className="query-form"
        onSubmit={(e) => {
          e.preventDefault();
          p.onRun();
        }}
      >
        <RegionPicker regions={p.regions} value={p.regionId} onChange={p.onRegion} disabled={p.running} />

        <label className="field">
          <span>Question</span>
          <textarea
            rows={4}
            value={p.question}
            onChange={(e) => p.onQuestion(e.target.value)}
            placeholder="Ask in your own words, e.g. “Is farmland flooded this week?” or “Where were crop fires in the last 5 days?”"
            disabled={p.running}
          />
        </label>

        <div className="examples" role="group" aria-label="Example questions">
          {examples.map((ex) => (
            <button type="button" key={ex.label} className="chip" disabled={p.running}
              onClick={() => p.onQuestion(ex.question)} aria-pressed={p.question === ex.question}>
              {ex.label}
            </button>
          ))}
          {region && !region.simulated && (
            <button type="button" className="chip chip-ghost" onClick={() => setShowMore((v) => !v)} aria-expanded={showMore}>
              {showMore ? "Fewer ideas" : "More questions…"}
            </button>
          )}
        </div>
        {showMore && region && !region.simulated && (
          <div className="more-questions">
            {MORE_QUESTIONS.map((g) => (
              <div key={g.group}>
                <span className="side-label">{g.group}</span>
                <ul>
                  {g.items.map((q) => (
                    <li key={q}><button type="button" className="link-btn" disabled={p.running} onClick={() => p.onQuestion(q)}>{q}</button></li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        <div className="field-row">
          <label className="field">
            <span>Precision target</span>
            <input inputMode="decimal" value={p.precision} onChange={(e) => p.onPrecision(e.target.value)}
              placeholder="from question" disabled={p.running} aria-describedby="precision-help" />
          </label>
          <label className="field">
            <span>Time budget (s)</span>
            <input inputMode="numeric" value={p.budget} onChange={(e) => p.onBudget(e.target.value)}
              placeholder={region && !region.simulated ? "900" : "120"} disabled={p.running} />
          </label>
        </div>
        <p id="precision-help" className="muted small">
          Percentage points for a share, percent of the estimate for areas and counts, recall percent for “find every tile”.
        </p>

        <div className="actions">
          <button type="button" className="btn" onClick={p.onCheck} disabled={!p.ready || p.running || p.checking || !p.question.trim()}>
            {p.checking ? "Checking…" : "Check plan"}
          </button>
          {p.running ? (
            <button type="button" className="btn btn-stop" onClick={p.onStop}>Stop and keep answer</button>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={!p.ready || !p.question.trim() || blocking.length > 0}>
              Run analysis
            </button>
          )}
        </div>
      </form>

      {p.scope && (
        <section className={`scope-card scope-${p.scope.category}`} role="status" aria-live="polite">
          <strong>{p.scope.category === "help" ? "What you can ask" : p.scope.category === "off_topic" ? "This question isn't for Bhu-Drishti" : "Not available yet"}</strong>
          <p className="small">{p.scope.message}</p>
          {p.scope.suggestions.length > 0 && (
            <>
              <span className="muted small">Try instead:</span>
              <div className="examples">
                {p.scope.suggestions.map((s) => (
                  <button key={s} type="button" className="chip" onClick={() => p.onQuestion(s)}>{s}</button>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {p.previewError && <p className="notice notice-error" role="alert">{p.previewError}</p>}

      {p.preview && ir && (
        <section className="plan" aria-label="Interpreted query">
          <h2>How the engine reads it</h2>
          <dl className="kv">
            <dt>Task</dt><dd>{taskLabel(ir.task)}</dd>
            <dt>Measure</dt><dd>{targetLabel(ir)}</dd>
            <dt>Dates</dt>
            <dd>{ir.baseline_start ? `${ir.baseline_start.slice(0, 4)} → ` : ""}{ir.start} to {ir.end}</dd>
            <dt>Target</dt><dd>{precisionLabel(ir)} at {Math.round(ir.confidence * 100)}% confidence</dd>
            <dt>Sensor</dt><dd>{p.preview.plan.sensor}</dd>
            <dt>Parser</dt><dd>{p.preview.compile.parser === "rules" ? "rule-based (no LLM key set)" : p.preview.compile.parser}</dd>
          </dl>
          {p.preview.compile.assumptions.length > 0 && (
            <>
              <h3>Assumptions</h3>
              <ul className="assumptions">
                {p.preview.compile.assumptions.map((a) => <li key={a}>{a}</li>)}
              </ul>
            </>
          )}
          <h3>Input checks</h3>
          <ul className="checks">
            {p.preview.plan.checks.map((c) => (
              <li key={c.name} className={c.ok ? "ok" : c.blocking ? "fail" : "warn"}>
                <span className="check-mark" aria-hidden="true">{c.ok ? "✓" : c.blocking ? "✕" : "!"}</span>
                <span><strong>{c.name}</strong> <span className="muted">{c.detail}</span></span>
              </li>
            ))}
          </ul>
          {p.preview.compile.warnings?.length > 0 && (
            <ul className="assumptions">{p.preview.compile.warnings.map((w) => <li key={w} className="warn-text">{w}</li>)}</ul>
          )}
          {p.preview.compile.suggested_region && (
            <button type="button" className="btn btn-small" onClick={() => p.onRegion(p.preview!.compile.suggested_region!.id)}>
              Switch the area to {p.preview.compile.suggested_region.name}
            </button>
          )}
          {p.preview.plan.steps.length > 0 && (
            <>
              <h3>Execution plan</h3>
              <ol className="steps">
                {p.preview.plan.steps.map((s) => <li key={s.op}><strong>{s.op.replace(/_/g, " ")}</strong> {s.detail}</li>)}
              </ol>
            </>
          )}
        </section>
      )}

      <section className="history">
        <button type="button" className="link-btn" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory}>
          {showHistory ? "Hide" : "Show"} earlier questions ({p.sessions.length})
        </button>
        {showHistory && (
          <ul className="session-list">
            {p.sessions.length === 0 && <li className="muted small">Questions you run appear here.</li>}
            {p.sessions.map((s) => (
              <li key={s.id}>
                <button type="button" className={`session ${s.id === p.activeId ? "active" : ""}`} onClick={() => p.onOpenSession(s)}>
                  <span className="session-q">{s.question}</span>
                  <span className="muted small">{new Date(s.createdAt).toLocaleString()} · {s.status}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
