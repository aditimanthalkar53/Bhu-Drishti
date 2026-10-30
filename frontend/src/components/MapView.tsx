import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useState } from "react";
import { GeoJSON, ImageOverlay, MapContainer, useMap } from "react-leaflet";
import type { MapOverlay } from "./ChangeImages";
import { cssVar, useTheme } from "../theme";
import { BaseLayers } from "./BaseLayers";
import { fmt } from "../format";
import type { Region, Target, Task, TileEvent } from "../types";

interface Props {
  region: Region | undefined;
  universe: GeoJSON.FeatureCollection | null;
  sampled: Map<string, TileEvent>;
  confirmedIds: Set<string>;
  task: Task | undefined;
  target?: Target;
  unit: string;
  runKey: string;
  overlay?: MapOverlay | null;
}

const PROXY_TEXT: Partial<Record<Target, string>> = {
  flooded_cropland: "Proxy score: coarse radar new-water × cropland (darker = more likely)",
  burned_cropland: "Proxy score: FIRMS fire density × cropland (darker = more likely)",
  active_fire: "Detections per tile (darker = more)",
  new_builtup: "Proxy score: settlement edge (darker = more likely)",
};


function FitRegion({ region }: { region: Region | undefined }) {
  const map = useMap();
  useEffect(() => {
    if (!region) return;
    const [x0, y0, x1, y1] = region.bbox;
    map.fitBounds([[y0, x0], [y1, x1]], { padding: [24, 24] });
  }, [region, map]);
  return null;
}

/** Positive = the specialist model found the target in this tile. */
function isPositive(task: Task | undefined, unit: string, v: number) {
  if (unit === "kilns" || unit === "detections" || unit === "tiles with fires") return v >= 1;
  if (task === "find_all") return v >= 0.02; // matches the engine's find-all threshold for areas
  return v > 0.005;
}

export function MapView({ region, universe, sampled, confirmedIds, task, target, unit, runKey, overlay }: Props) {
  const [showProxy, setShowProxy] = useState(true);
  const [showSamples, setShowSamples] = useState(true);

  const sampledFc = useMemo<GeoJSON.FeatureCollection>(() => {
    if (!universe) return { type: "FeatureCollection", features: [] };
    const byId = new Map(universe.features.map((f) => [String(f.id ?? (f.properties as any)?.tile_id), f]));
    const feats: GeoJSON.Feature[] = [];
    for (const [id, t] of sampled) {
      const f = byId.get(id);
      if (f) feats.push({ ...f, properties: { ...(f.properties ?? {}), sample: t } });
    }
    return { type: "FeatureCollection", features: feats };
  }, [universe, sampled]);

  const maxVal = useMemo(() => {
    let m = 0;
    for (const t of sampled.values()) m = Math.max(m, t.value);
    return m || 1;
  }, [sampled]);

  const regionFc = useMemo<GeoJSON.Feature | null>(
    () => (region?.geometry ? { type: "Feature", properties: {}, geometry: region.geometry } : null),
    [region],
  );
  const counted = unit === "detections" || unit === "tiles with fires";
  // canvas-rendered layers can't use CSS var(); resolve the theme's colours and re-key layers when it changes
  const { mode } = useTheme();
  const col = useMemo(() => ({
    outline: cssVar("--cyan"), accent: cssVar("--water"), ochre: cssVar("--ochre"), ink: cssVar("--ink-2"), surface: cssVar("--sheet-solid"),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [mode]);

  return (
    <div className="map-wrap">
      <MapContainer center={[26.4, 91.2]} zoom={10} preferCanvas className="map" zoomControl attributionControl>
        <BaseLayers />
        <FitRegion region={region} />
        {overlay && <ImageOverlay key={overlay.url} url={overlay.url} bounds={overlay.bounds} opacity={0.95} />}
        {regionFc && (
          <GeoJSON key={`region-${region?.id}-${mode}`} data={regionFc}
            style={{ color: col.outline, weight: 2, fill: false, dashArray: "6 4" }} interactive={false} />
        )}
        {universe && showProxy && (
          <GeoJSON
            key={`universe-${runKey}-${mode}`}
            data={universe}
            interactive={false}
            style={(f) => {
              const r = Number((f?.properties as any)?.proxy_rank ?? 0);
              return { stroke: false, fillColor: col.ochre, fillOpacity: 0.04 + 0.5 * r * r };
            }}
          />
        )}
        {showSamples && sampledFc.features.length > 0 && (
          <GeoJSON
            key={`samples-${runKey}-${sampledFc.features.length}-${confirmedIds.size}-${mode}`}
            data={sampledFc}
            style={(f) => {
              const t = (f?.properties as any)?.sample as TileEvent;
              const pos = isPositive(task, unit, t.value);
              if (!pos) return { color: col.ink, weight: 1, opacity: 0.75, fill: true, fillColor: col.surface, fillOpacity: 0.55 };
              const k = Math.min(1, t.value / maxVal);
              return { color: col.outline, weight: 1, opacity: 0.9, fillColor: col.accent, fillOpacity: 0.45 + 0.5 * k };
            }}
            onEachFeature={(f, layer) => {
              const t = (f.properties as any).sample as TileEvent;
              const role = t.role ? `<br>${t.role === "frontier" ? "Verified top-down" : "Random audit"}` : "";
              const ans = typeof t.detail?.answer === "string" ? `<br>${t.detail.answer}` : "";
              const d = t.detail ?? {};
              const extra = counted
                ? `<br>high ${d.high ?? 0} · nominal ${d.nominal ?? 0} · low ${d.low ?? 0}${d.last_seen ? `<br>last ${d.last_seen} UTC` : ""}`
                : d.no_data ? `<br><em>${String(d.reason ?? "no usable imagery")}</em>`
                : typeof d.flooded_share_of_cropland === "number" ? `<br>${fmt(100 * Number(d.flooded_share_of_cropland), 1)}% of the tile's cropland`
                : typeof d.burned_share_of_cropland === "number" ? `<br>${fmt(100 * Number(d.burned_share_of_cropland), 1)}% of the tile's cropland · FIRMS ${d.firms_detections ?? 0}`
                : "";
              layer.bindTooltip(
                `<strong>${t.tile_id.split(":").slice(1).join(", ")}</strong><br>${fmt(t.value, unit === "kilns" || counted ? 0 : 3)} ${unit}` +
                  `${role}${ans}${extra}<br>${counted ? "From the FIRMS catalogue" : t.cache ? "From cache" : `Model run ${fmt(t.latency_s, 1)} s`}`,
                { sticky: true },
              );
            }}
          />
        )}
      </MapContainer>

      <div className="map-legend-wrap">
      <button type="button" className="map-info-btn map-legend-btn" aria-label="Map legend and layers" aria-haspopup="true">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
          <path d="M12 3 2 8l10 5 10-5-10-5Z" /><path d="m2 13 10 5 10-5" opacity="0.6" />
        </svg>
        {sampled.size > 0 && <span className="map-legend-count">{sampled.size.toLocaleString()}</span>}
      </button>
      <div className="map-legend" aria-label="Map legend">
        <div className="legend-toggles" role="group" aria-label="Map layers">
          <button type="button" className="chip" aria-pressed={showProxy} onClick={() => setShowProxy((v) => !v)}>Proxy layer</button>
          <button type="button" className="chip" aria-pressed={showSamples} onClick={() => setShowSamples((v) => !v)}>Analysed tiles</button>
        </div>
        <div className="legend-row"><span className="swatch swatch-proxy" aria-hidden="true" />{(target && PROXY_TEXT[target]) ?? "Proxy score from cheap signals (darker = more likely)"}</div>
        <div className="legend-row"><span className="swatch swatch-pos" aria-hidden="true" />Analysed, target found (darker = more)</div>
        <div className="legend-row"><span className="swatch swatch-neg" aria-hidden="true" />Analysed, nothing found</div>
        <p className="muted small legend-note">
          {sampled.size > 0
            ? `${sampled.size.toLocaleString()} of ${universe?.features.length.toLocaleString() ?? "?"} tiles analysed by the specialist model`
            : "Run a question to see which tiles the engine analyses"}
        </p>
      </div>
      </div>
    </div>
  );
}
