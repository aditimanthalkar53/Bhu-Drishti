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

## Fallback and routing rules

* Flood: Planetary Computer S1 RTC is required. If it has no scene, validation says whether Copernicus lists GRD
  acquisitions (RTC processing pending) or none (widen the window). Copernicus, IMERG, MODIS and Open-Meteo only add
  context; their failure never fails a run.
* Fire: FIRMS required. Burned area: Planetary Computer S2 required, FIRMS optional (sampling guide).
* AlphaEarth: optional; when unavailable the proxy uses radar/land-cover/FIRMS features only. Embeddings can only
  change efficiency, not the estimate's validity.

## Security review

* Credentials are read from environment variables on the engine/backend only; nothing is sent to the browser.
* `redact()` strips the FIRMS key (it sits in the URL path), bearer tokens, Azure SAS signatures and client secrets from
  every error, trace and status message; Fastify logs redact `authorization`, `x-api-key` and `?token=`.
* `engine/credentials/`, `.env`, `/env`, `docker-compose.override.yml` and HDF downloads are git-ignored. No secret was
  found in tracked files or git history.
* The service-account JSON is mounted read-only into the engine container.
