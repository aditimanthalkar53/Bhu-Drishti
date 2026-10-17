import { useCallback, useEffect, useRef, useState } from "react";
import { api, eventsUrl } from "./api";
import type { CompileInfo, EstimateView, PlanEvent, ProgressEvent, ResultEvent, TileEvent } from "./types";

export interface HistoryPoint {
  n: number;
  t: number;
  value: number;
  lo: number;
  hi: number;
}

export interface RunState {
  id: string | null;
  status: "idle" | "running" | "done" | "stopped" | "failed";
  compile: CompileInfo | null;
  plan: PlanEvent | null;
  progress: ProgressEvent | null;
  estimate: EstimateView | null;
  history: HistoryPoint[];
  sampled: Map<string, TileEvent>;
  result: ResultEvent | null;
  universe: GeoJSON.FeatureCollection | null;
  error: string | null;
}

const empty: RunState = {
  id: null, status: "idle", compile: null, plan: null, progress: null, estimate: null,
  history: [], sampled: new Map(), result: null, universe: null, error: null,
};

/** Subscribes to an engine run over Server-Sent Events and accumulates its state. */
export function useQueryRun() {
  const [state, setState] = useState<RunState>(empty);
  const esRef = useRef<EventSource | null>(null);

  const close = () => {
    esRef.current?.close();
    esRef.current = null;
  };
  useEffect(() => close, []);

  const reset = useCallback(() => {
    close();
    setState(empty);
  }, []);

  const attach = useCallback((id: string, compile: CompileInfo | null) => {
    close();
    setState({ ...empty, id, status: "running", compile, sampled: new Map() });
    const es = new EventSource(eventsUrl(id));
    esRef.current = es;

    es.addEventListener("plan", (m) => {
      const ev = JSON.parse((m as MessageEvent).data) as PlanEvent;
      setState((s) => ({ ...s, plan: ev }));
      // the tile universe (with proxy scores) exists as soon as the plan does
      api<GeoJSON.FeatureCollection>(`/api/queries/${id}/universe`)
        .then((u) => setState((s) => (s.id === id ? { ...s, universe: u } : s)))
        .catch(() => undefined);
    });
    es.addEventListener("progress", (m) => {
      const ev = JSON.parse((m as MessageEvent).data) as ProgressEvent;
      setState((s) => {
        const sampled = new Map(s.sampled);
        for (const t of ev.tiles) sampled.set(t.tile_id, t);
        const e = ev.estimate;
        const history = e && Number.isFinite(e.value)
          ? [...s.history, { n: ev.n, t: ev.elapsed_s, value: e.value, lo: e.lo, hi: e.hi }]
          : s.history;
        return { ...s, progress: ev, estimate: e ?? s.estimate, history, sampled };
      });
    });
    es.addEventListener("result", (m) => {
      const ev = JSON.parse((m as MessageEvent).data) as ResultEvent;
      setState((s) => ({ ...s, result: ev, estimate: ev.estimate, status: ev.stop_reason === "user_stop" ? "stopped" : "done" }));
    });
    es.addEventListener("error", (m) => {
      const data = (m as MessageEvent).data;
      if (data) {
        const ev = JSON.parse(data);
        setState((s) => ({ ...s, status: "failed", error: ev.message ?? "The engine reported an error." }));
      }
    });
    es.addEventListener("end", () => close());
    es.onerror = () => {
      // EventSource reconnects by itself; only give up if the run is clearly over
      setState((s) => (s.status === "running" && es.readyState === EventSource.CLOSED
        ? { ...s, status: "failed", error: "Lost the connection to the engine." } : s));
    };
  }, []);

  return { state, attach, reset };
}
