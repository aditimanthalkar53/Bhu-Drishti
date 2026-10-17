# Bhu-Drishti

**Satellite monitoring for every district in India, with the uncertainty stated.** Ask a question in plain language
("What percentage of cropland in Barpeta was flooded during 1–15 July 2024?", "How many fire detections were there in
Sangrur in the last 10 days?") and get an answer computed from live Sentinel-1/2, ESA WorldCover, Copernicus DEM and
NASA data, with a confidence interval, the satellite scenes it used, supporting evidence (rainfall, MODIS flood maps,
forecasts), its limitations, and practical next steps for officials. Monitors re-run questions on every new satellite
pass, raise alerts above a threshold and produce PDF reports that are emailed only after a person approves them.

Under the hood is **AEQE**, an anytime, error-bounded query engine: instead of analysing every tile of a district at
full resolution, it scores every tile cheaply, analyses a statistically designed sample, and stops when the interval is
tight enough — with intervals that stay valid however often the run is checked.

| Area | What you get | Data |
|---|---|---|
| Flooded cropland (share / km²) | % ± pp, km², per-tile flood map | Sentinel-1 RTC change vs dry-season reference, WorldCover cropland, Copernicus DEM slope mask |
| Fires / stubble burning | exact count of detections, ranked hotspot tiles | NASA FIRMS VIIRS + MODIS (NRT and archive) |
| Burned cropland (km² / share) — **experimental, not validated** | km² ± %, per-tile burn share with FIRMS corroboration | Sentinel-2 dNBR + char darkness, FIRMS density as the sampling guide. Thresholds need calibration against reference burned-area data (see Limitations) |
| New construction (km²) | km² ± % between two years | Sentinel-2 dry-season stacks, persistent built-up rule |
| Context (never mixed into the number) | rainfall totals, MODIS flood share, Copernicus cross-check, 7-day rain and river-discharge forecast | GPM IMERG, MCDWD_L3_NRT, CDSE Statistical API, Open-Meteo/GloFAS |
| What to do next | recovery / prevention guidance per hazard, season and state | PMFBY, SDRF/NDRF norms, ICAR-CRIDA contingency plans, CRM scheme |

Two **simulated demo districts** with known ground truth remain available (clearly labelled) so the statistics can be
checked against reality; brick-kiln counting and point inspection only work there, because no open model is wired in
for live data.

## Pages

Dashboard · Explore (ask a question, live map and interval) · Areas of interest (district, drawn polygon, GeoJSON/KML
upload) · Monitors · Alerts · Reports (PDF preview, approve/reject, send, delivery log) · Recipients (officials
directory and groups) · History · Data catalog (live source status, freshness per district) · Settings (API keys,
webhooks, email) · Usage · Audit log. A notification bell and a first-run setup guide sit across the app.

## Architecture

```
React + TypeScript web app        dashboard · explore · areas · monitors · alerts · reports · recipients · data …
        │  /api (REST + Server-Sent Events)
Node.js + Fastify API             auth (JWT, guest, API keys) · records · monitor scheduler · PDF reports ·
        │                         SMTP delivery or signed webhooks → n8n · audit log · notifications
        │  HTTP
Python + FastAPI AEQE engine      compiler → validation → tiles + proxies → stratified sample → oracles →
        │                         estimators (alpha spending) → stop · supporting evidence · advisory · trace
Unified data-access layer         capability registry, retries/backoff, secret redaction, provenance, TTL caches
  Planetary Computer (STAC + COG)    Copernicus Data Space (Catalog, Process, Statistical; OAuth)
  NASA FIRMS (area API)              NASA Earthdata (CMR, IMERG via OPeNDAP, MODIS NRT flood)
  Google Earth Engine (AlphaEarth)   Open-Meteo (forecast + GloFAS)
Storage: PostgreSQL/PostGIS (users, sessions + result snapshots, records) · SQLite (oracle + source caches) · JSON traces
```

```
engine/aeqe/sources/      one adapter per provider + registry, status ladder, http/retry/redaction, TTL cache
engine/aeqe/providers/    live.py (India districts + custom AOIs) · simulated.py (demo) · composite.py (routing)
engine/aeqe/advisory.py   recovery / prevention guidance
engine/aeqe/data/         india_districts.json (geoBoundaries ADM2, ODbL) — rebuild with scripts/build_india_regions.py
engine/scripts/           smoke_sources.py (live checks) · live_e2e.py (live end-to-end runs) · export_alphaearth.py
backend/src/              features.ts (product API) · monitors.ts (scheduler) · delivery.ts · webhooks.ts · report.ts (PDF)
frontend/src/pages/       one file per page
n8n/                      bhu-drishti-reports.json (importable workflow)
docs/PROVIDERS.md         provider status report (what is verified, what is blocked and why)
```

## Run it

```bash
cp .env.example .env          # fill in the keys you have — every source is optional
docker compose up --build     # web http://localhost:8080 · API :4000 · engine :8000
docker compose --profile n8n up -d n8n    # optional: self-hosted n8n on :5678
```

Local development (Python 3.11+, Node 20+):

```bash
cd engine && pip install -r requirements-real.txt -r requirements-dev.txt && uvicorn aeqe.server:app --port 8000 --env-file ../.env
cd backend && npm install && npm run dev        # :4000, in-memory store unless DATABASE_URL is set
cd frontend && npm install && npm run dev       # :5173
cd backend && npm run test:email                # optional: check SMTP by mailing SMTP_USER
```

The engine does not read `.env` by itself: without `--env-file ../.env` every credential is missing (the startup log
says which sources are configured). Without `requirements-real.txt` the engine still runs, but only the two simulated
demo districts are available (`/health` shows `"live_data": false`). On Windows, `rasterio` and `pyhdf` may have no
prebuilt wheels for the newest Python; if `pip install` fails, use Docker Desktop or WSL.

### Credentials (backend/engine only — never in the browser)

| Variable | Source | Needed for |
|---|---|---|
| — | Planetary Computer | flood, construction, burned area (public, no key) |
| `CDSE_CLIENT_ID`, `CDSE_CLIENT_SECRET` | Copernicus Data Space → OAuth client | Sentinel-1 cross-check, freshness, server-side statistics |
| `NASA_FIRMS_MAP_KEY` | firms.modaps.eosdis.nasa.gov/api/map_key | fire workflows, burned-area sampling |
| `EARTHDATA_TOKEN` (or `EARTHDATA_USERNAME` + `EARTHDATA_PASSWORD`) | urs.earthdata.nasa.gov → Generate Token; approve *NASA GESDISC DATA ARCHIVE* and LANCE | IMERG rainfall and MODIS flood evidence |
| `GOOGLE_CLOUD_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS` | Earth Engine–registered Cloud project + service-account JSON in `engine/credentials/` | AlphaEarth proxy features (optional) |
| `SMTP_*` | e.g. Gmail App Password | emailing reports |

Startup logs list which sources are configured (names only). `engine/credentials/`, `.env` and downloaded HDF files are
git-ignored.

## Testing

```bash
cd engine && pytest                         # 65 offline tests: estimators, compiler, adapters (mocked HTTP), masks, census, advisory, job persistence
cd backend && npm test                      # 18 tests: SQLite accounts, no guests, password change / reset / sign-out everywhere, ownership, monitors → alerts → approval → signed webhooks → n8n callback, PDFs
cd frontend && npm run build                # type-check + production build
cd engine && python scripts/smoke_sources.py          # bounded live, read-only check of every provider
cd engine && python scripts/live_e2e.py flood|fire|fire_find|built|burned   # live end-to-end runs
cd engine && python -m bench.coverage --runs 100 && python -m bench.report  # coverage benchmark (simulated districts)
```

## Accounts, questions and reports

* **Login required for the app.** The website (`/`) is public; every `/app` page needs an account. Accounts (email,
  bcrypt password hash), projects, sessions and reports are stored in **SQLite** (`SQLITE_PATH`, default
  `backend/data/bhu-drishti.sqlite`, git-ignored; Docker keeps it in the `backend-data` volume). There are no guest
  sessions. Users can change their password under Settings. Set `DATABASE_URL` to use Postgres instead.
* **Ask in your own words.** The parser understands many phrasings ("is farmland under water right now", "parali
  burning this week", "new houses since 2021"). Questions outside the scope (air quality, weather, forests, cricket…) get
  a clear "not available here" reply with suggestions instead of an error, and naming another district in the question
  offers to switch the area.
* **Two PDFs per report.** A plain-language *summary* (headline in everyday words, how sure we are, map, what it means,
  what to do now) and the full *technical* report. Download either from a result, History or the report page
  (`?style=simple|technical`).
* **Forgotten passwords.** "Forgot password?" in the sign-in dialog emails a single-use link (valid 30 minutes) to
  `PUBLIC_APP_URL/reset-password`. It needs SMTP. The answer is the same whether or not the email has an account.
  Resetting or changing a password signs out every other device, and Settings has "Sign out on all devices".
  Login sessions last 24 hours.
* **Automatic email.** Every generated report (from Explore, a monitor or the daily bulletin) is emailed with both
  PDFs to `REPORT_AUTO_EMAIL` (comma-separated) as soon as it is created, independent of the approval step for
  officials. Each send is logged in the report's delivery log and the audit log.

## n8n report delivery

1. `docker compose --profile n8n up -d n8n`, open http://localhost:5678, import `n8n/bhu-drishti-reports.json`.
2. In Bhu-Drishti → Settings create an API key; in n8n create the Header Auth credential "Bhu-Drishti API key"
   (`x-api-key: bd_…`) and an SMTP credential.
3. Settings → Webhooks: add `http://n8n:5678/webhook/bhu-drishti` with `report.approved` (and `alert.triggered`); paste the
   signing secret into the "Verify signature" node.
4. Set `REPORT_DELIVERY=n8n` and restart the backend. Approving a report now hands it to n8n, which emails each
   recipient and posts each result to `/api/reports/:id/deliveries`; the "Daily 08:00 IST" trigger calls
   `/api/reports/generate` to create bulletins for approval.

Without n8n (`REPORT_DELIVERY=smtp`, the default) the backend emails approved reports itself. Either way a human approves
every report before an official receives it, and each delivery is logged and audited.

## Production

What the repo already does: only the `web` container is published (engine, backend and n8n listen on 127.0.0.1),
healthchecks and `restart: unless-stopped` on every service, security headers and a CSP in `frontend/nginx.conf`,
rate-limited auth, single-use password-reset links, server-side sign-out, per-user limits on parallel analyses,
finished engine jobs saved to disk (answers, maps and PDFs survive an engine restart), the backend refuses to start
with a default `JWT_SECRET`, and CI (`.github/workflows/ci.yml`) runs every test suite and the Docker build.

Checklist for a server:

1. A Linux host with normal Docker networking, `git clone`, `cp .env.example .env`.
2. In `.env`: a long random `JWT_SECRET` (`openssl rand -base64 48`), your own data-provider keys, real SMTP
   (a transactional email service, not a personal Gmail), `REPORT_AUTO_EMAIL` and `PUBLIC_APP_URL`/`WEB_ORIGIN` set to
   `https://your-domain`, `WEB_PORT=127.0.0.1:8080`, `TRUST_PROXY=2`.
3. `docker compose up -d --build`, then HTTPS in front with `deploy/nginx-https.conf.example` and certbot.
4. Backups: `./scripts/backup.sh` daily from cron (SQLite snapshot + engine jobs/areas, keeps 14), copy `backups/`
   off the server; `./scripts/restore.sh backups/<timestamp>` restores one.
5. Check `docker compose ps` (all *healthy*) and Settings → Data sources in the app.

## How the statistics work

* **Population and proxies.** Districts are tiled at 0.01° (larger tiles for very large districts, ≤ 8,000 tiles) and
  clipped to the boundary. Cheap per-tile proxies come from whole-district reads: a ~200 m Sentinel-1 new-water overview,
  WorldCover fractions, FIRMS detection density, and AlphaEarth embedding PCs when Earth Engine is available.
* **Sampling and estimation.** Six proxy strata, sequential Neyman allocation, stratified estimator then a cross-fitted
  difference estimator (ridge proxy). The proxy can only cost efficiency, not introduce bias.
* **Anytime-valid intervals.** The run looks at its interval after every batch, so each look spends
  α_k = α·6/(π²k²) of the error budget (Σ ≤ α). Whatever look the run stops at — precision met, budget, or a user
  pressing stop — the reported interval keeps its nominal coverage. Set `AEQE_SEQUENTIAL=fixed` for the older
  fixed-sample interval (validated only by simulation).
* **Census targets.** FIRMS is a complete catalogue, so fire questions are counted exactly over every tile.
* **Separate uncertainties.** Intervals cover sampling error relative to the model. Model error, data gaps (tiles with
  no usable imagery are counted and reported) and cloud are stated as limitations, never folded into the interval.

## Limitations

* Satellite data are not real-time: Sentinel-1 passes every 6–12 days, Sentinel-2 every ~5 days (cloud permitting),
  FIRMS within ~3 h of an overpass. "Live" means "computed from the newest available acquisitions".
* The flood, burn and built-up oracles are transparent physical rules, not trained models; their own error against
  ground truth is not in the interval. Closing that gap needs reference labels (e.g. field surveys).
* A fire detection is a thermal anomaly, not proof of its cause or of who is responsible; new built-up area says
  nothing about legality. Results are screening outputs for human review.
* WorldCover (2021) defines cropland, not the crop standing in the query year.
* **Burned cropland is experimental.** dNBR alone mapped harvest as burning (88.7 % of Sangrur's cropland, Oct–Nov
  2025); adding a char-darkness test gave 0.4 % with no correlation to FIRMS detections (Spearman 0.05). The rule needs
  calibration against reference data (e.g. PRSC burned-area maps or field reports) before its numbers are used. FIRMS
  fire counts are the validated fire signal.
* MODIS NRT flood files are kept only for a short rolling window, so past events have no MODIS evidence.
* Teams/roles, WhatsApp and SMS delivery are not built yet (phase 2; SMS in India needs DLT registration).

## Data credits

Copernicus Sentinel data (ESA) via Microsoft Planetary Computer and the Copernicus Data Space Ecosystem; ESA WorldCover
2021 (CC BY 4.0); Copernicus DEM GLO-30; NASA FIRMS; NASA GPM IMERG and LANCE MODIS NRT flood product; Open-Meteo and
Copernicus GloFAS; district boundaries © geoBoundaries contributors (ODbL 1.0); Google AlphaEarth Foundations satellite
embeddings (when enabled).
