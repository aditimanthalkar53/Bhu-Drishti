import { LayersControl, TileLayer } from "react-leaflet";

/**
 * Shared basemaps with a switcher. "Map" is OpenStreetMap restyled per theme by a CSS filter
 * (see .tiles-themed: a graphite night map in dark mode) so it needs no API key;
 * "Satellite" is Esri World Imagery; "Streets" is the standard OpenStreetMap layer.
 */
export function BaseLayers({ position = "topright" }: { position?: "topright" | "topleft" | "bottomright" | "bottomleft" }) {
  return (
    <LayersControl position={position}>
      <LayersControl.BaseLayer checked name="Map">
        <TileLayer
          className="tiles-themed"
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={19}
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
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
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={19}
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        />
      </LayersControl.BaseLayer>
    </LayersControl>
  );
}
