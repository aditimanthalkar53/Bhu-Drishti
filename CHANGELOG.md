# Changelog

All notable changes to Bhu-Drishti. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased] (proposed 0.3.0)

Everything merged to `main` after 0.2.0 (`c2b9194`).

### Added
- **Accounts:** users, projects and reports are stored in SQLite (Postgres optional). The website is public and the
  app requires a login.
- **Password reset by email:** single-use links that expire after 30 minutes. Password change and reset sign out
  other devices, and there is a "Sign out on all devices" button. Sessions last 24 hours.
- **Questions in your own words:** off-topic questions get a clear reply with suggestions, and naming another
  district offers to switch the area.
- **Reports:** a plain-language **summary PDF** alongside the technical PDF, and every new report is emailed
  automatically to `REPORT_AUTO_EMAIL`.
- **Results survive restarts:** finished engine runs are saved to disk, so answers, maps and PDFs remain available
  after a restart.
- **Free deployment in one go:**
  - one container (root `Dockerfile`) holds the website, API and AEQE engine; it starts with no configuration
  - automatic deploys of `main` to a free Hugging Face Space after CI passes (`deploy-hf.yml`)
  - accounts can live in a free Neon Postgres database (`DATABASE_URL`)
  - a step-by-step [DEPLOY.md](DEPLOY.md)
- **Security headers and a Content Security Policy** on every page.
- **CI** runs all tests, then builds the container, starts it with no configuration and checks it end to end.
- **Docs:** a project guide (`docs/Bhu-Drishti_Project_Guide.pdf`) and the presentation deck (`Bhu-Drishti.pdf`).

### Changed
- **Guest mode removed:** existing guest tokens are refused.
- **Three containers became one:** the API serves the website; nginx, the per-service Dockerfiles, the Render
  Blueprint, the HTTPS proxy example and the backup scripts are removed (nothing in the setup costs money).
- **The container runs as an unprivileged user** (uid 1000, as Hugging Face Spaces expects).
- **New settings:**
  - `TRUST_PROXY` is now a count of proxy hops
  - `PUBLIC_APP_URL`, `MAX_CONCURRENT_RUNS`, `STATIC_DIR` and `FRAME_ANCESTORS` are new (the container sets them)
  - `JWT_SECRET` must be at least 32 characters in production; the container generates one if it is missing
- **UI:**
  - the user menu stays above the map
  - the globe is redesigned
  - the live-data notice and the map legend moved behind info icons

### Fixed
- **Rate limits:** clients can no longer spoof `X-Forwarded-For` to get around them.
- **Account probing:** "Forgot password" no longer reveals whether an account exists.
- **Interrupted runs:** a run cut off by an engine restart is marked failed instead of staying "running".
- **Linux builds:** the image no longer copies host `node_modules` into its build.

### Upgrade notes
- Guest sessions no longer work. Users need to create an account.
- Docker Compose now has a single `app` service with an `app-data` volume. Data from the old `backend-data`
  volume (`bhu-drishti.sqlite`) can be copied into it; on a free host use `DATABASE_URL` instead.
- Set `JWT_SECRET` yourself so sign-ins survive a rebuild.

### Tests
- Engine: 65 passed.
- Backend: 20 passed.
- Frontend production build: passes.
- End to end against the single container (SQLite and Postgres): 18 of 18 checks passed, including live NASA FIRMS and
  Sentinel-1 queries and SMTP delivery.
