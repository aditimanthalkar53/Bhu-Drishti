# Provider status report

Checked 17 Oct 2026 with `engine/scripts/smoke_sources.py` (host) and `POST /sources/check` (inside the Docker
engine). A status is only claimed after the corresponding live request succeeded. Re-run the checks any time from the
**Data** page in the app.

| Provider | Status | Evidence | What is needed |
|---|---|---|---|
| Microsoft Planetary Computer | **End-to-end workflow verified** | STAC search (S1 RTC, S2 L2A, WorldCover, DEM); signed COG reads of S1 VV, WorldCover, DEM; live flood run for Barpeta (138 tiles), construction run for Gurgaon | nothing |
| Copernicus Data Space | **End-to-end workflow verified** | OAuth token cached (1800 s); Catalog search for S1 GRD; Statistical API water share per pass; attached to the Barpeta flood run (14–19 % of pixels below the threshold vs 19.5 % flooded cropland estimate) | nothing |
| NASA FIRMS | **End-to-end workflow verified** | key status, data_availability, area CSV; fire census for Sangrur through the full stack (monitor → alert → report → email) | nothing. Note: the live API limits DAY_RANGE to 1–5, not the documented 1–10; the adapter adapts |
| Open-Meteo (forecast + GloFAS) | **End-to-end workflow verified** | forecast + flood API; attached to runs. Returned HTTP 503 "overloaded" once — reported as unavailable, run continued | nothing |
| NASA Earthdata | **Not configured** (discovery verified) | CMR search works without login (IMERG daily granules, MCDWD tiles up to 16 Oct 2026). IMERG/MODIS downloads not exercised | `EARTHDATA_TOKEN` (urs.earthdata.nasa.gov → Generate Token) and approving *NASA GESDISC DATA ARCHIVE* + LANCE in the Earthdata profile. The 0-byte `3B-HHR-E…HDF5` in the repo root is a failed unauthenticated download and can be deleted |
| Google Earth Engine (AlphaEarth) | **Blocked** | service account authenticates, then Earth Engine refuses: *"Caller does not have required permission to use project bhu-drishti-511906 … grant roles/serviceusage.serviceUsageConsumer"* | In Google Cloud console (project bhu-drishti-511906): grant the service account **Service Usage Consumer** and an **Earth Engine Resource Viewer/Writer** role, enable the Earth Engine API, and register the project for Earth Engine (noncommercial). Runs fall back to raster proxies meanwhile |

### Change detection sources (added 30 Oct 2026, all keyless)

| Provider | Status | Evidence | What is needed |
|---|---|---|---|
| Element84 Earth Search | **End-to-end workflow verified** | Sentinel-2 search and COG reads; forest-loss run for Dehradun, Feb 2024 → Feb 2025 | nothing |
| Hansen/UMD Global Forest Change (GFC-2025-v1.13) | **End-to-end workflow verified** | Tile reads; Dehradun run reported 2.3 km² annual loss, 0.13 km² overlapping | nothing. These files have no overviews, so this is the slowest read |
| Meta HRSL | **End-to-end workflow verified** | Zonal sums for the Barpeta flood run; 3.49 M people in the rectangle | nothing |
| WorldPop statistics API | **Not working** | 30 Oct 2026: synchronous and asynchronous requests return HTTP 200 with only PHP notices and no JSON | nothing on our side. Runs continue with HRSL alone and say so |
| OpenStreetMap Overpass | **Intermittent** | Answered on 2 of 4 servers tried. `overpass-api.de` (42 s, 502 and timeouts at other times), `maps.mail.ru` (16 s); both are configured | nothing. Runs report the gap when both fail |
| JRC Global Surface Water (via Planetary Computer) | **End-to-end workflow verified** | Permanent-water mask in the Barpeta flood run | nothing |

| NASA ASF HyP3 (added for ground movement) | **Account verified** | `/user` answered APPROVED with 8,000 credits using the existing `EARTHDATA_TOKEN`; ASF search found the Joshimath pair | `EARTHDATA_TOKEN`, which expires after 60 days |

## Fallback and routing rules

* Flood: Planetary Computer S1 RTC is required. If it has no scene, validation says whether Copernicus lists GRD
  acquisitions (RTC processing pending) or none (widen the window). Copernicus, IMERG, MODIS and Open-Meteo only add
  context; their failure never fails a run.
* Fire: FIRMS required. Burned area: Planetary Computer S2 required, FIRMS optional (sampling guide).
* Change detection: Earth Search (optical) or Planetary Computer (radar) is required. WorldCover is required for forest loss.
  Hansen, FIRMS, OSM, population, JRC and the DEM only add evidence or masks: each gap is recorded in the result, and a
  missing mask lowers confidence instead of being filled in.
* Ground movement: ASF search and HyP3 are required. An identical pair reuses the earlier job instead of spending credits, and
  a job in progress resumes after an engine restart.
* AlphaEarth: optional; when unavailable the proxy uses radar/land-cover/FIRMS features only. Embeddings can only
  change efficiency, not the estimate's validity.

## Security review

* Credentials are read from environment variables on the engine/backend only; nothing is sent to the browser.
* `redact()` strips the FIRMS key (it sits in the URL path), bearer tokens, Azure SAS signatures and client secrets from
  every error, trace and status message; Fastify logs redact `authorization`, `x-api-key` and `?token=`.
* `engine/credentials/`, `.env`, `/env`, `docker-compose.override.yml` and HDF downloads are git-ignored. No secret was
  found in tracked files or git history.
* The service-account JSON is mounted read-only into the engine container.
