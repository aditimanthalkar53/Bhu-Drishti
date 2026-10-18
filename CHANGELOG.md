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
- **Deployment:**
  - production Docker Compose setup with health checks and restart policies
  - nginx security headers and a Content Security Policy
  - an HTTPS proxy example in `deploy/`
  - `render.yaml` Blueprint for hosting on Render without a server
  - a step-by-step [DEPLOY.md](DEPLOY.md)
- **Operations:**
  - `scripts/backup.sh` and `scripts/restore.sh`
  - GitHub Actions CI that runs all tests, then builds and starts the full Docker stack and checks it end to end
- **Docs:** a project guide (`docs/Bhu-Drishti_Project_Guide.pdf`) and the presentation deck (`Bhu-Drishti.pdf`).

### Changed
- **Guest mode removed:** existing guest tokens are refused.
- **Containers run as unprivileged users:** an entrypoint fixes ownership of data volumes created by earlier
  root-run versions.
- **Only the website is exposed:** the engine, API and n8n listen on loopback.
- **nginx config is a template:** the port, API address and DNS resolver come from the environment.
- **New settings:**
  - `TRUST_PROXY` is now a count of proxy hops
  - `PUBLIC_APP_URL`, `MAX_CONCURRENT_RUNS` and `ENGINE_HOSTPORT` are new
  - `JWT_SECRET` is required and must be at least 32 characters in production
- **UI:**
  - the user menu stays above the map
  - the globe is redesigned
  - the live-data notice and the map legend moved behind info icons

### Fixed
- **Rate limits:** clients can no longer spoof `X-Forwarded-For` to get around them.
- **Account probing:** "Forgot password" no longer reveals whether an account exists.
- **Interrupted runs:** a run cut off by an engine restart is marked failed instead of staying "running".
- **502 errors:** nginx re-resolves the API container, so recreating it doesn't cause them.
- **Linux builds:** the frontend image no longer copies host `node_modules` into its build.
- **Backup and restore:** backups exclude the tile cache and recover from interrupted runs. Restores set file
  ownership and always restart services.

### Upgrade notes
- Set `JWT_SECRET` in `.env` (32+ characters, e.g. `openssl rand -base64 48`) before `docker compose up`.
- Guest sessions no longer work. Users need to create an account.
- Data volumes from earlier versions are migrated automatically on first start.
- Behind an extra HTTPS proxy, set `TRUST_PROXY=2` and `PUBLIC_APP_URL=https://your-domain`.

### Tests
- Engine: 65 passed.
- Backend: 19 passed.
- Frontend production build: passes.
- End to end against the production Docker stack: 18 of 18 checks passed, including live NASA FIRMS and
  Sentinel-1 queries and SMTP delivery.
