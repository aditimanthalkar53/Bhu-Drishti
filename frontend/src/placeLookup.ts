import { useEffect, useRef, useState } from "react";
import { post } from "./api";
import type { AlertLike } from "./sachetLink";

/** A district the server found for some text, by location (see engine/aeqe/places.py). */
export interface Resolved { id: string; name: string; state: string; via: "name" | "location"; place: string }

const cache = new Map<string, Promise<Resolved[]>>();
const queue: (() => void)[] = [];
let running = 0;
const MAX_PARALLEL = 3;   // the lookups call a free public geocoder: keep it gentle

function turn(): Promise<() => void> {
  return new Promise((go) => {
    const start = () => { running++; go(() => { running--; queue.shift()?.(); }); };
    if (running < MAX_PARALLEL) start(); else queue.push(start);
  });
}

/** Districts meant by `text`. alert = text of an official alert (needs a state in it); search = a phrase typed by a person. Never rejects. */
export function resolveText(text: string, mode: "alert" | "search" = "alert"): Promise<Resolved[]> {
  const key = `${mode}|${text}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const done = await turn();
      try { return (await post<{ districts: Resolved[] }>("/api/regions/resolve", { text, mode })).districts; }
      catch { cache.delete(key); return []; }   // try again next time
      finally { done(); }
    })();
    cache.set(key, p);
  }
  return p;
}

export const alertQuery = (a: AlertLike & { description?: string | null }) =>
  [a.areaDesc, a.title, (a.description ?? "").slice(0, 500)].filter(Boolean).join(". ").slice(0, 2500);

export const resolveAlert = (a: AlertLike & { description?: string | null }) => resolveText(alertQuery(a), "alert");

/** True once the element is (nearly) on screen, so 100 alert cards do not all start lookups at once. */
export function useInView<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

/** Districts for an alert: the server's answer (by location) once it arrives. */
export function useAlertDistricts(a: AlertLike & { description?: string | null }, enabled: boolean): { found: Resolved[]; loading: boolean } {
  const [found, setFound] = useState<Resolved[]>([]);
  const [loading, setLoading] = useState(false);
  const q = alertQuery(a);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setLoading(true);
    resolveText(q, "alert").then((r) => { if (live) { setFound(r); setLoading(false); } });
    return () => { live = false; };
  }, [q, enabled]);
  return { found, loading };
}
