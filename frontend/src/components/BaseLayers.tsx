import { LayersControl, TileLayer } from "react-leaflet";

/**
 * Shared basemaps with a switcher. With VITE_MAP_API_KEY set (a MapTiler key, frontend/.env), "Map" is MapTiler's
 * OpenStreetMap-style map and "Streets" its street map. Without a key they fall back to Esri's topographic and street
 * maps, which need none, so a map is never blank. "Satellite" is always Esri World Imagery. "Map" is restyled per theme
 * by a CSS filter (see .tiles-themed: a graphite night map in dark mode).
 *
 * None of them uses OpenStreetMap's own tile servers: those are volunteer-run and answer "403 Access blocked" to heavy
 * users. The key is visible to anyone who opens the page, so restrict it to your site's address in the MapTiler dashboard.
 */
const KEY = (import.meta.env.VITE_MAP_API_KEY as string | undefined)?.trim();

const maptiler = (style: string) => `https://api.maptiler.com/maps/${style}/256/{z}/{x}/{y}.png?key=${KEY}`;
const MAPTILER_CREDIT = '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const ESRI_CREDIT = "Tiles &copy; Esri — Source: Esri, HERE, Garmin, FAO, NOAA, USGS, OpenStreetMap contributors";

export function BaseLayers({ position = "topright" }: { position?: "topright" | "topleft" | "bottomright" | "bottomleft" }) {
  return (
    <LayersControl position={position}>
      <LayersControl.BaseLayer checked name="Map">
        <TileLayer
          key={KEY ? "maptiler-map" : "esri-topo"}
          className="tiles-themed"
          url={KEY ? maptiler("openstreetmap") : "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}"}
          maxZoom={19}
          attribution={KEY ? MAPTILER_CREDIT : ESRI_CREDIT}
        />
      </LayersControl.BaseLayer>
      <LayersControl.BaseLayer name="Satellite">
        <TileLayer
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
          maxZoom={19}
          attribution="Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community"
        />
      </LayersControl.BaseLayer>
      <LayersControl.BaseLayer name="Streets">
        <TileLayer
          key={KEY ? "maptiler-streets" : "esri-streets"}
          url={KEY ? maptiler("streets-v2") : "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}"}
          maxZoom={19}
          attribution={KEY ? MAPTILER_CREDIT : ESRI_CREDIT}
        />
      </LayersControl.BaseLayer>
    </LayersControl>
  );
}
