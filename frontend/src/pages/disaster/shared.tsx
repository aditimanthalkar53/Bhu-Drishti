import "leaflet/dist/leaflet.css";
import type { Map as LeafletMap } from "leaflet";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CircleMarker, MapContainer, Rectangle, Tooltip, useMap } from "react-leaflet";
import { BaseLayers } from "../../components/BaseLayers";
import { cssVar } from "../../theme";
import { Pill } from "../common";

// ---------------------------------------------------------------------------- shapes returned by the API
export type RequestType = "rescue" | "medical" | "food_water" | "shelter" | "road_blocked" | "power" | "drain_or_sewer" | "waterlogging" | "other";
export type RequestStatus = "new" | "verified" | "assigned" | "in_progress" | "resolved" | "cancelled";
export interface HelpRequest {
  id: string; ownerId: string; createdAt: string; type: RequestType; description: string; originalText: string | null; originalLanguage: string | null;
  summaryEn: string | null; needs: string[]; lat: number | null; lng: number | null; accuracyM: number | null; area: string | null;
  severity: 1 | 2 | 3 | 4; peopleAffected: number | null; contact: string | null; source: "form" | "sos" | "local_language" | "drain_watch";
  status: RequestStatus; priority: number | null; assigneeId: string | null; offerIds: string[]; flags: string[]; reporterName: string;
  intake?: { provider: string; confidence: number | null; edited: boolean } | null;
  drain?: { category: string; categorySource: "citizen" | "ai"; photos: string[]; vision: { provider: string; category: string; confidence: number; description: string } | null;
    confirmations: { at: string; photos: string[] }[]; forwarded: { to: string | null; status: string; at: string | null; error?: string | null } } | null;
  confidence?: { score: number; factors: { corroboration: number; hazard: number | null; reporter: number } };
  history: { at: string; action: string }[];
}
export interface Offer {
  id: string; ownerId: string; createdAt: string; type: string; quantity: number; unit: string; description: string; lat: number | null; lng: number | null;
  availableFrom: string | null; availableTo: string | null; contact: string | null; status: "available" | "matched" | "used" | "withdrawn"; offeredByName: string;
}
export interface Task {
  id: string; createdAt: string; title: string; type: "field_check" | "rescue" | "delivery" | "assessment" | "general"; description: string;
  requestId: string | null; runId: string | null; cellId: string | null; lat: number | null; lng: number | null;
  status: "open" | "claimed" | "done" | "unreachable" | "cancelled"; claimedBy: string | null; claimedByName: string | null; note: string | null; result: Record<string, unknown> | null;
}
export interface HazardCell { cell_id: string; bbox: [number, number, number, number]; hazard_score: number; layers: Record<string, { value: number | null; norm: number | null; unit: string; observed_at: string | null }> }
export interface HazardSource { id: string; name: string; state: string; observed_at: string | null; age_s: number | null; latency_s: number | null; note: string; area_level?: boolean; kind?: string }
export interface HazardGrid { bbox: [number, number, number, number] | null; cells: HazardCell[]; sources: HazardSource[]; score_doc?: string; generated_at?: string }
export interface SilentZone { id: string; bbox: [number, number, number, number] | null; hazard: number; reported: number; expected_reports: number; reason: string; status: string; action: string }

// ---------------------------------------------------------------------------- labels
export const REQUEST_LABEL: Record<RequestType, string> = {
  rescue: "Rescue", medical: "Medical", food_water: "Food / water", shelter: "Shelter", road_blocked: "Road blocked", power: "Power",
  drain_or_sewer: "Drain / sewer", waterlogging: "Waterlogging", other: "Other",
};
export const OFFER_LABEL: Record<string, string> = {
  boat: "Boat", vehicle: "Vehicle", food: "Food", water: "Water", shelter: "Shelter", medical: "Medical", labour: "Labour / hands", other: "Other",
};
export const SEVERITY_LABEL: Record<number, string> = { 1: "Can wait", 2: "Today", 3: "Urgent", 4: "Life in danger" };
export const LANGUAGES: Record<string, string> = { en: "English", hi: "हिन्दी", kn: "ಕನ್ನಡ", as: "অসমীয়া" };
export const SPEECH_LANG: Record<string, string> = { en: "en-IN", hi: "hi-IN", kn: "kn-IN", as: "as-IN" };

export const sevTone = (s: number) => (s >= 4 ? "error" : s === 3 ? "warn" : s === 2 ? "info" : "muted") as "error" | "warn" | "info" | "muted";
export const statusTone = (s: string) =>
  (({ new: "warn", verified: "info", assigned: "info", in_progress: "info", resolved: "ok", cancelled: "muted", open: "warn", claimed: "info", done: "ok", unreachable: "error" } as const)[s] ?? "muted");

export function Severity({ s }: { s: number }) {
  return <Pill tone={sevTone(s)}>{s}/4 · {SEVERITY_LABEL[s]}</Pill>;
}
export function Status({ s }: { s: string }) {
  return <Pill tone={statusTone(s)}>{s.replace(/_/g, " ")}</Pill>;
}

export const sevColor = (s: number) => cssVar(s >= 4 ? "--error" : s === 3 ? "--ochre" : s === 2 ? "--water" : "--muted");
/** 0..1 → a colour from pale yellow to deep red (hazard and need maps). */
export function heat(v: number): string {
  const x = Math.max(0, Math.min(1, v));
  const h = 55 - 55 * x, l = 70 - 30 * x;
  return `hsl(${h} 95% ${l}%)`;
}

export const newClientId = () => (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`).replace(/[^a-zA-Z0-9-]/g, "");

export const age = (s: number | null) => {
  if (s == null) return "unknown";
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
};

// ---------------------------------------------------------------------------- device location
export interface Fix { lat: number; lng: number; accuracyM: number; at: string }

/** Ask the browser for a high-accuracy location; resolves to null (never throws) when it is refused or unavailable. */
export function getFix(timeoutMs = 12000): Promise<Fix | null> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy), at: new Date(p.timestamp).toISOString() }),
      () => resolve(null), { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 });
  });
}

const FIX_KEY = "maun.lastFix";
export function rememberFix(f: Fix) { try { localStorage.setItem(FIX_KEY, JSON.stringify(f)); } catch { /* storage unavailable */ } }
export function lastFix(): Fix | null { try { return JSON.parse(localStorage.getItem(FIX_KEY) ?? "null"); } catch { return null; } }

export function useFix() {
  const [fix, setFix] = useState<Fix | null>(null);
  const [state, setState] = useState<"idle" | "locating" | "ok" | "failed">("idle");
  const locate = useCallback(async () => {
    setState("locating");
    const f = await getFix();
    if (f) { setFix(f); rememberFix(f); setState("ok"); } else { setFix(lastFix()); setState("failed"); }
    return f;
  }, []);
  return { fix, setFix, state, locate };
}

export function FixLine({ fix, state, onLocate }: { fix: Fix | null; state: string; onLocate(): void }) {
  return (
    <p className="small">
      {state === "locating" ? "Finding your location…" : fix ? <>Location: {fix.lat.toFixed(5)}, {fix.lng.toFixed(5)} (±{fix.accuracyM} m){state === "failed" && " · last known"}</>
        : state === "failed" ? <span className="muted">Location not available. Allow location access, or the request goes with your area only.</span> : <span className="muted">No location yet.</span>}
      {" "}<button type="button" className="link-btn" onClick={onLocate}>{fix ? "Update" : "Use my location"}</button>
    </p>
  );
}

// ---------------------------------------------------------------------------- photos
/** Re-encode a photo as JPEG (longest side ≤ maxSide). Drawing on a canvas drops EXIF, including GPS. */
export async function compressImage(file: File, maxSide = 1280, quality = 0.8): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("could not read the photo")); i.src = url; });
    const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------------------- maps
export function FitBounds({ bounds }: { bounds: [[number, number], [number, number]] | null }) {
  const map = useMap();
  const key = bounds ? bounds.flat().map((v) => v.toFixed(4)).join(",") : "";
  useEffect(() => {
    if (bounds) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 15 });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, map]);
  return null;
}

export function boundsOf(points: { lat: number | null; lng: number | null }[], boxes: ([number, number, number, number] | null)[] = []): [[number, number], [number, number]] | null {
  let s = 90, w = 180, n = -90, e = -180, any = false;
  for (const p of points) if (p.lat != null && p.lng != null) { any = true; s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lng); e = Math.max(e, p.lng); }
  for (const b of boxes) if (b) { any = true; w = Math.min(w, b[0]); s = Math.min(s, b[1]); e = Math.max(e, b[2]); n = Math.max(n, b[3]); }
  if (!any) return null;
  if (n - s < 0.01) { s -= 0.01; n += 0.01; }
  if (e - w < 0.01) { w -= 0.01; e += 0.01; }
  return [[s, w], [n, e]];
}

export function MapFrame({ children, height = 420, bounds, onReady }: { children?: ReactNode; height?: number; bounds?: [[number, number], [number, number]] | null; onReady?(m: LeafletMap): void }) {
  return (
    <div className="mini-map" style={{ height }}>
      <MapContainer center={[26.32, 91.0]} zoom={9} className="map" preferCanvas>
        <BaseLayers />
        {bounds !== undefined && <FitBounds bounds={bounds} />}
        {onReady && <Ready onReady={onReady} />}
        {children}
      </MapContainer>
    </div>
  );
}

function Ready({ onReady }: { onReady(m: LeafletMap): void }) {
  const map = useMap();
  useEffect(() => onReady(map), [map, onReady]);
  return null;
}

export function HazardCells({ cells, layer = "combined", opacity = 0.45 }: { cells: HazardCell[]; layer?: string; opacity?: number }) {
  return (
    <>
      {cells.map((c) => {
        const v = layer === "combined" ? c.hazard_score : c.layers[layer]?.norm ?? null;
        if (v == null || v <= 0.02) return null;
        const b = c.bbox;
        return (
          <Rectangle key={c.cell_id} bounds={[[b[1], b[0]], [b[3], b[2]]]} pathOptions={{ stroke: false, fillColor: heat(v), fillOpacity: opacity * (0.4 + 0.6 * v) }}>
            <Tooltip>{c.cell_id}: hazard {c.hazard_score.toFixed(2)}{Object.entries(c.layers).map(([k, l]) => ` · ${k} ${l.value ?? "–"} ${l.unit}`).join("")}</Tooltip>
          </Rectangle>
        );
      })}
    </>
  );
}

export function SilentCells({ zones }: { zones: SilentZone[] }) {
  return (
    <>
      {zones.filter((z) => z.bbox).map((z) => (
        <Rectangle key={z.id} bounds={[[z.bbox![1], z.bbox![0]], [z.bbox![3], z.bbox![2]]]} pathOptions={{ color: cssVar("--violet"), weight: 2, dashArray: "4 3", fillColor: cssVar("--violet"), fillOpacity: 0.18 }}>
          <Tooltip>Silent zone {z.id}: {z.reason}. {z.action}</Tooltip>
        </Rectangle>
      ))}
    </>
  );
}

export function RequestDots({ requests, onPick }: { requests: HelpRequest[]; onPick?(r: HelpRequest): void }) {
  return (
    <>
      {requests.filter((r) => r.lat != null).map((r) => (
        <CircleMarker key={r.id} center={[r.lat!, r.lng!]} radius={r.source === "sos" ? 9 : 6}
          pathOptions={{ color: r.status === "cancelled" ? cssVar("--muted") : sevColor(r.severity), weight: r.source === "sos" ? 3 : 1.5,
            dashArray: r.status === "cancelled" ? "3 3" : undefined, fillOpacity: r.status === "resolved" ? 0.15 : 0.6 }}
          eventHandlers={onPick ? { click: () => onPick(r) } : undefined}>
          <Tooltip>{r.source === "sos" ? "SOS · " : ""}{REQUEST_LABEL[r.type]} · {r.status.replace(/_/g, " ")} · severity {r.severity}<br />{(r.summaryEn || r.description).slice(0, 120)}</Tooltip>
        </CircleMarker>
      ))}
    </>
  );
}

export function OfferDots({ offers }: { offers: Offer[] }) {
  return (
    <>
      {offers.filter((o) => o.lat != null && o.status === "available").map((o) => (
        <CircleMarker key={o.id} center={[o.lat!, o.lng!]} radius={6} pathOptions={{ color: cssVar("--ok"), weight: 2, fillOpacity: 0.5 }}>
          <Tooltip>Offer: {o.quantity} {o.unit} · {OFFER_LABEL[o.type] ?? o.type} · {o.offeredByName}</Tooltip>
        </CircleMarker>
      ))}
    </>
  );
}

export function TaskDots({ tasks }: { tasks: Task[] }) {
  return (
    <>
      {tasks.filter((t) => t.lat != null && (t.status === "open" || t.status === "claimed")).map((t) => (
        <CircleMarker key={t.id} center={[t.lat!, t.lng!]} radius={5} pathOptions={{ color: cssVar("--cyan"), weight: 2, fillOpacity: 0.2, dashArray: t.status === "open" ? "2 2" : undefined }}>
          <Tooltip>Task: {t.title} · {t.status}{t.claimedByName ? ` by ${t.claimedByName}` : ""}</Tooltip>
        </CircleMarker>
      ))}
    </>
  );
}

export function Legend({ items }: { items: [string, string, boolean?][] }) {
  return (
    <p className="small legend-row">
      {items.map(([label, color, dashed]) => (
        <span key={label}><span className="legend-swatch" style={{ background: dashed ? "transparent" : color, borderColor: color, borderStyle: dashed ? "dashed" : "solid" }} />{label}</span>
      ))}
    </p>
  );
}
