# Maun / Bhu-Drishti

> **Bhu-Drishti now includes Maun, a disaster coordination platform.** Maun brings citizens, volunteers and authorities
> together so that requests, offers of help and official updates are shared and coordinated in one place. Maun (मौन,
> "silence") also estimates the need nobody reported. See [Disaster mode (Maun)](#disaster-mode-maun) below.
> By default (`FEATURE_MODE=full`) every feature is on: the satellite product described next (AEQE questions, change
> detection, digital twins, monitors…) and the coordination pages. `FEATURE_MODE=disaster` together with
> `VITE_FEATURE_MODE=disaster` builds an optional slimmed coordination-only edition.

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

**Change detection** is the second way to analyse an area. Explore estimates *how much* across a district by sampling, with
a statistical interval. Change detection compares two dates and maps *exactly where*, as polygons, with who and what is
inside them. It does not sample, so its range is threshold sensitivity, not a confidence interval.

| Analysis | Method | Evidence and exposure |
|---|---|---|
| Flood detection (radar) | Sentinel-1 RTC VV/VH change: speckle filter, Otsu threshold when the histogram supports it (else a fixed one, flagged), ≥ 3 dB drop, VH agreement | JRC surface-water and WorldCover permanent-water masks, DEM slope mask, built-up exclusion, people (HRSL/WorldPop), facilities (OSM) |
| Surface-water change | Sentinel-2 MNDWI with a dark-NIR test, clear pixels only | DEM slope mask, people, facilities |
| Vegetation change | Sentinel-2 NDVI difference: scene-wide median shift removed, absolute drop and robust z-score both required | Reports vegetation gain too |
| Forest loss (ForestGuard) | The NDVI rule limited to WorldCover tree cover | Hansen annual loss, NASA FIRMS fires, OSM protected areas, largest patches, evidence-coverage level (a count, not a probability) |

| Ground movement (InSAR) | Sentinel-1 SLC pair on the same track, processed to line-of-sight displacement by NASA ASF HyP3; relative to surrounding ground, beyond 15 mm and 2.5× the measured noise | Coherence mask, elevation-correlation check for atmosphere, people, facilities. No risk rating: a signal is a reason to inspect, not proof of damage |

The first four are transparent baselines ported from Prithvi Drishti and **not validated against labelled data**. Every result
says so, with its quality flags and the reasons for its confidence class. A risk level (hazard × exposure) is a documented
convention, not a calibrated model; vulnerability has no data source and is reported as unknown.

Two **simulated demo districts** with known ground truth remain available (clearly labelled) so the statistics can be
checked against reality; brick-kiln counting and point inspection only work there, because no open model is wired in
for live data.

**Digital twins** hold one real asset (a bridge, road segment, building, embankment or dam, found in OpenStreetMap or drawn,
up to about 10 km): its information, the inspections, damage reports, maintenance and sensor readings people record, and every
finished analysis that covers it, read at the asset's location and compared with the previous one. It is shown on 3D terrain
(Copernicus DEM with a recent Sentinel-2 image, or the movement field draped on it). This is a record and a viewer: nothing
simulates how the structure behaves, its shape and height are not modelled, and there are no live sensors unless entered.

## Disaster mode (Maun)

**Citizens ask. Volunteers act. Authorities coordinate.** And Maun also finds the people who couldn't ask.

### Roles
| Role | How you get it | Sees |
|---|---|---|
| Citizen | chosen at sign-up (default; existing accounts become citizens) | Ask for help (SOS, own words), My requests, Offer help, Drain Watch, Updates, SACHET alerts, Hazard map |
| Volunteer | chosen at sign-up or in Settings | Tasks, Ask for help, Offer help, Updates, Hazard map |
| Authority | **never self-assigned**: listed in `AUTHORITY_EMAILS`, or granted by an allow-listed authority on the People page | Command view, Requests, Offers, Tasks, Volunteers, Silent zones, Estimates, Updates/bulletins, Reports, Recipients, Audit log, Data sources |

The role lives in a `profile` record (no change to the users table), travels in the JWT for the website, and is re-read
on every role-guarded request, so removing an authority takes effect immediately.

### What each part does
- **SOS:** tap → "Are you sure?" → second tap sends at once with the device location (high accuracy, accuracy radius,
  timestamp). For 60 seconds the sender can cancel ("sent by mistake"), and authorities see it flagged as possibly accidental.
  Each SOS carries a client-generated id, so network retries never duplicate it. A user may send 3 new SOS per 10 minutes,
  repeats are flagged, authorities are notified instantly, and if location fails it is sent anyway with the profile's area.
- **Own words:** type or speak (Web Speech API where the browser has it) in English, Hindi, Kannada or Assamese. A model
  (`INTAKE_*`) makes a structured draft the citizen confirms or edits; authorities see the English summary next to the
  original text. With no model, or on failure, the original text is sent and the citizen picks the type.
- **Drain Watch:** up to 3 camera photos, shrunk and re-encoded on the phone. The server checks the real file type,
  limits size to 8 MB and strips EXIF/XMP/IPTC/comments. Photos are stored under `<data>/uploads/drain/<id>/` and served
  only to the reporter and authorities. A vision model (`VISION_*`) suggests a category, and the citizen's choice wins. Each
  report gets a one-page PDF that is emailed to the ward office (`DRAIN_WARD_EMAILS`, else `DRAIN_AUTHORITY_EMAIL`).
  A report within 30 m of an open one of the same category from the last 7 days becomes a "+1 confirmation".
- **Requests:**
  - Statuses: new → verified → assigned → in progress → resolved (or cancelled).
  - Sorting: by severity × confidence. Confidence combines nearby reports from other people, the hazard layer and the
    reporter's history. Low confidence never hides a request.
- **Offers and matches:** offers (boat, vehicle, food, water, shelter, medical, labour) are ranked against a request by
  type, distance and quantity. A match creates a delivery task.
- **Official updates:** one authority drafts, a **second** approves (the author cannot), then the update is published to
  the Updates feed and emailed to the chosen recipient groups. Every delivery and step is in the audit log. Bulletins are
  coordination messages; official warnings are shown from NDMA SACHET.
- **Hazard map (virtual constellation):** we no longer analyse imagery for this edition. `engine/aeqe/hazard/` reads the
  following independent products, each through the existing source clients (retries, key redaction, status ladder):
  - NASA FIRMS fires;
  - GPM IMERG rainfall (area-level);
  - the MODIS NRT flood product (area-level);
  - GloFAS river discharge and the Open-Meteo rain forecast, both labelled as forecasts.

  Each source shows when it last observed, its delay after observation, or "not configured". Nothing claims continuous
  coverage. `hazard_score` per cell is the maximum over available layers of weight × normalised value (documented in
  `score.py`).
- **Sharper observation:** an `ObservationRequest` asks for sharper imagery over chosen cells. We cannot task real
  satellites, so the only adapter is **SIMULATED** (`SimulatedObservationAdapter` in `backend/src/hazard/index.ts`) and
  says so everywhere. A real provider implements the same `ObservationAdapter` interface.
- **Maun estimates** (`engine/aeqe/maun/`; AEQE's estimators are called, not changed):
  - **Cells:** the area is split into grid cells, each with a predicted need of reported + households × 0.2 × hazard.
  - **Strata:** the existing six strata over predicted need.
  - **Selection:** volunteers check randomly chosen cells, allocated by sequential Neyman allocation with a pilot of 3
    per stratum.
  - **Estimate:** the cross-fitted difference estimator (stratified below 30 checks), with alpha spending over looks. The
    output is reported need, estimated true need, the 95% range and the hidden need (true minus reported), overall and
    per area.
  - **Unreachable cells** are never swapped for easier ones. They stay in the sample, the range is widened to cover
    both no need and every household in need there, and they are flagged and sent for sharper observation.
  - **Silent zones** are cells with high hazard but far fewer reports than expected, or where reports stopped after a
    burst.
  - **Storage:** the run (cells, seed, each wave's allocation, results) is stored in the backend and the engine replays
    it deterministically, so restarts lose nothing.
  - **Live updates:** the estimate updates live over Server-Sent Events.

### Run the simulation (SIMULATED ground truth)
```
cd engine
python -m maun_sim --runs 500        # prints one run wave by wave, then the empirical coverage; saves ../data/maun_sim/coverage.{json,png}
```
The world is a generated Barpeta-like area: a river, flood extent, towns, and villages with poor networks where far fewer
people report. The true need is hidden from the engine. Over 500 runs (4 waves, about 88 checks out of 400 cells), the
95% range contained the true total in **99.8%** of runs. Reports covered only about a third of the true need. The range
is conservative: alpha spending over the looks and the larger of two standard errors make it err wide, never narrow. The range covers
sampling error only, not counting mistakes or a wrong population map.

### Demo data
```
cd backend && npm run seed:demo      # engine running for the Maun part; password for all demo accounts: maun-demo-2026
```
The seed creates:
- 2 authorities (a bulletin needs two), 2 volunteers and 3 citizens;
- requests, including an SOS and Assamese and Hindi originals;
- offers, and Drain Watch reports including a +1 merge;
- an approved bulletin;
- a SIMULATED Maun run with one wave of simulated checks done (one cell unreachable).

All of it is labelled demo / SIMULATED.

### Environment
`FEATURE_MODE` (backend) / `VITE_FEATURE_MODE` (website, build time) = `full` (default, everything) or `disaster`; `AUTHORITY_EMAILS`;
`INTAKE_PROVIDER/MODEL/API_KEY/BASE_URL`; `VISION_PROVIDER/MODEL/API_KEY/BASE_URL`; `DRAIN_AUTHORITY_EMAIL`,
`DRAIN_WARD_EMAILS`; `UPLOADS_DIR`; `OBS_SIM_DELAY_S`. Model keys stay on the server.

**Hidden only in the optional disaster edition** (code kept; API answers 404, pages redirect to the dashboard):
- the Drift Simulator, Explore (the satellite question compiler) and its new questions about flooded or burned cropland,
  new construction and kilns;
- change detection, digital twins, Areas, Monitors and History;
- Usage, API keys and webhooks;
- the replay/compare/trace/CSV buttons (their endpoints stay);
- the landing page's benchmark and 735-district sections.

In the default `full` edition all of these stay visible, next to the coordination pages; the authority Command view is at `/app/command`.

### Limitations
- Web only, and it needs connectivity.
- Hazard freshness varies by source, and forecasts are not observations.
- The sharper-observation adapter is simulated.
- The Maun range covers sampling error only, and population is a documented placeholder (400 people/km²) unless a
  population map is added.
- Browser speech recognition depends on the browser and language.

**Future work (not built):** offline/PWA, SMS gateway, phone-to-phone relay, real satellite tasking, face/plate blurring,
chat, donations.

## Pages

Dashboard · Explore (ask a question, live map and interval) · Change detection (two dates, mapped patches, evidence, ground movement) · Digital twins · Areas of interest (district, drawn polygon, GeoJSON/KML
upload) · Monitors · Alerts · Reports (PDF preview, approve/reject, send, delivery log) · Recipients (officials
directory and groups) · History · Data catalog (live source status, freshness per district) · Settings (API keys,
webhooks, email) · Usage · Audit log. A notification bell and a first-run setup guide sit across the app.

## Architecture

Everything runs in **one container** (`Dockerfile` at the repo root): the API serves the built website and talks to
the engine inside the same container.

```
React + TypeScript web app        dashboard · explore · areas · monitors · alerts · reports · recipients · data …
        │  /api (REST + Server-Sent Events)
Node.js + Fastify API             serves the website · auth (JWT, API keys) · records · monitor scheduler · PDF reports ·
        │                         SMTP delivery or signed webhooks → n8n · audit log · notifications
        │  HTTP
Python + FastAPI AEQE engine      compiler → validation → tiles + proxies → stratified sample → oracles →
        │                         estimators (alpha spending) → stop · supporting evidence · advisory · trace
Unified data-access layer         capability registry, retries/backoff, secret redaction, provenance, TTL caches
  Planetary Computer (STAC + COG)    Copernicus Data Space (Catalog, Process, Statistical; OAuth)
  NASA FIRMS (area API)              NASA Earthdata (CMR, IMERG via OPeNDAP, MODIS NRT flood)
  Google Earth Engine (AlphaEarth)   Open-Meteo (forecast + GloFAS)
Storage: SQLite file or Postgres via DATABASE_URL (users, sessions + result snapshots, records) · SQLite (oracle + source caches) · JSON traces
```

```
engine/aeqe/sources/      one adapter per provider + registry, status ladder, http/retry/redaction, TTL cache
engine/aeqe/providers/    live.py (India districts + custom AOIs) · simulated.py (demo) · composite.py (routing)
engine/aeqe/advisory.py   recovery / prevention guidance
engine/aeqe/eo/           change detection: detectors, indices, grid, forest evidence, population, facilities, risk, InSAR, twins, jobs
engine/aeqe/data/         india_districts.json (geoBoundaries ADM2, ODbL) — rebuild with scripts/build_india_regions.py
engine/scripts/           smoke_sources.py (live checks) · live_e2e.py (live end-to-end runs) · export_alphaearth.py
backend/src/              features.ts (product API) · monitors.ts (scheduler) · delivery.ts · webhooks.ts · report.ts (PDF)
frontend/src/pages/       one file per page
n8n/                      bhu-drishti-reports.json (importable workflow)
docs/PROVIDERS.md         provider status report (what is verified, what is blocked and why)
```

## Run it

```bash
cp .env.example .env          # optional: fill in the keys you have — the app starts without any
docker compose up -d --build  # one container: website + API + engine → http://localhost:8080
docker compose --profile n8n up -d n8n    # optional: self-hosted n8n on :5678
```

Free hosting with automatic deploys from `main` (Hugging Face Spaces + Neon Postgres): see [DEPLOY.md](DEPLOY.md).

Local development (Python 3.11+, Node 20+):

```bash
cd engine && pip install -r requirements-real.txt -r requirements-dev.txt && uvicorn aeqe.server:app --port 8000 --env-file ../.env
cd backend && npm install && npm run dev        # :4000, SQLite in backend/data unless DATABASE_URL is set
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
| `EARTHDATA_TOKEN` (same one) | as above; no extra approval was needed for HyP3 | ground movement (InSAR). Free monthly credits; a pair costs 10–15 and takes about 20–90 minutes. The token expires after 60 days |
| `SMTP_*` | e.g. Gmail App Password | emailing reports |

Startup logs list which sources are configured (names only). `engine/credentials/`, `.env` and downloaded HDF files are
git-ignored.

## Testing

```bash
cd engine && pytest                         # 65 offline tests: estimators, compiler, adapters (mocked HTTP), masks, census, advisory, job persistence
cd backend && npm test                      # 20 tests: SQLite accounts, website serving, no guests, password change / reset / sign-out everywhere, interrupted runs, ownership, monitors → alerts → approval → signed webhooks → n8n callback, PDFs
cd frontend && npm run build                # type-check + production build
cd engine && python scripts/smoke_sources.py          # bounded live, read-only check of every provider
cd engine && python scripts/live_e2e.py flood|fire|fire_find|built|burned   # live end-to-end runs
cd engine && python scripts/live_detection.py sar_flood in-assam-barpeta 2024-03-15 2024-07-05   # live change detection
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

## Escalation to higher authorities

Each recipient has a **level** (block/field, district, state, national) and a **reports-to** person, shown as a chain of
command on the Recipients page. A monitor can switch on escalation:

* the people ticked on the monitor are emailed first, with a link to confirm;
* a value at or above the *severe* level also tells one level up straight away, and at or above *critical* two levels up;
* if nobody confirms within the set number of minutes, the next level up is told, then the next, until someone confirms
  or the top is reached. Confirming (by the email link, or Acknowledge in the app) stops it;
* **Escalate now** moves it up one level by hand, and **Drill** rehearses the whole chain without running a satellite
  analysis. A drill is labelled as one in every email and in the app.

Every notification, failure, confirmation and escalation is on the alert and in the audit log. A failed email is shown as
failed, never hidden. These messages are short and say that the figure is a satellite estimate that may not have been
reviewed; reports still wait for human approval as before. Email is the only channel built (it needs the `SMTP_*`
settings, nothing else). WhatsApp and Slack can be reached through the webhook and n8n route; SMS needs DLT registration.
The hierarchy belongs to each user's own recipient list, and there are no admin roles yet.

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

**Deploying for free, without a server: [DEPLOY.md](DEPLOY.md)** (Hugging Face Spaces for the app, Neon for the
database, automatic deploys from `main`).

Built in: login required, rate-limited auth, single-use password-reset links, server-side sign-out, per-user limits
on parallel analyses, security headers and a Content Security Policy, finished engine jobs saved to disk, a non-root
container, and a generated login secret when none is set. CI (`.github/workflows/ci.yml`) runs every test suite, then
builds the container and starts it with no configuration and checks it end to end;
`.github/workflows/deploy-hf.yml` publishes `main` to the Space after CI passes.

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
* Admin roles and organisation-wide hierarchies, WhatsApp and SMS delivery are not built yet (phase 2; SMS in India needs DLT registration).

* **Change detection** is limited to 1.5° per side (`AEQE_EO_MAX_SPAN_DEG`), which excludes 59 of the 735 districts; draw a
  smaller area for those. Grids are capped at 1.4 M pixels (`AEQE_EO_MAX_PIXELS`), so a whole district is analysed at
  roughly 60–100 m, not 10 m. A smaller area gets a finer grid.
* **A radar flood result depends heavily on the "before" date and the water threshold.** Use a dry-season date to measure
  a monsoon flood. Over Barpeta in July 2024 the fixed −17 dB threshold gave 103 km² (range 38–192), while AEQE's dry-season
  method estimated about 19.5 % of cropland. The two disagree and no ground truth is available to settle it; AEQE's
  flood oracle was not changed by this work.
* **Ground movement from one pair is a screening signal.** It is along the line of sight, relative to nearby ground, and
  cannot separate movement from atmosphere. Vegetation, snow, water and very fast movement lose coherence and give no
  reading, so "not detected" covers only the measured pixels. HyP3 keeps its files for 14 days; the numbers needed here are
  saved locally when a run finishes.
* WorldPop's statistics API currently returns no data, so population has no second dataset and no range until it recovers.
  OSM facility counts are often incomplete in rural India, and the public Overpass servers can be slow or time out.

## Data credits

InSAR processing by NASA ASF HyP3 (GAMMA software); Copernicus Sentinel data (ESA) via Microsoft Planetary Computer and the Copernicus Data Space Ecosystem; ESA WorldCover
2021 (CC BY 4.0); Copernicus DEM GLO-30; NASA FIRMS; Hansen/UMD/Google/USGS/NASA Global Forest Change (CC BY 4.0); JRC Global Surface Water; Meta High Resolution
Settlement Layer and WorldPop (CC BY 4.0); OpenStreetMap contributors (ODbL); NASA GPM IMERG and LANCE MODIS NRT flood product; Open-Meteo and
Copernicus GloFAS; district boundaries © geoBoundaries contributors (ODbL 1.0); Google AlphaEarth Foundations satellite
embeddings (when enabled).
