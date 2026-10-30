# Deploying: Vercel (website) + Render (API, engine, database)

```
Browser ── https ──> Vercel (static React app, frontend/)
   │  VITE_API_URL
   └──── https ────> Render web service  bhudrishti-api   (Fastify; JWT login; Postgres)
                          │ private network
                          └──────────────> Render private service  bhudrishti-engine  (FastAPI/AEQE, disk /data)
```

The browser talks to the API directly (token in the `Authorization` header; the live-progress stream and PDF links use
`?token=`), so no proxy sits on Vercel. That keeps long analyses and the event stream off Vercel's request time limits.

## 1. Render (do this first)
1. Push this repo to GitHub. Render → **New → Blueprint** → select it. It reads [render.yaml](../render.yaml) and creates
   the database, the private engine and the API.
2. In the dashboard fill the `sync: false` variables:
   * engine: `CDSE_CLIENT_ID/SECRET`, `NASA_FIRMS_MAP_KEY`, `EARTHDATA_TOKEN` (see the README's credentials table).
   * api: `PUBLIC_API_URL` (the API's own `https://….onrender.com` URL), `SMTP_*`, `REPORT_AUTO_EMAIL`.
   * leave `CORS_ORIGIN` and `PUBLIC_APP_URL` until step 2 gives you the Vercel URL, then set both to it and redeploy.
3. Check `https://<api>.onrender.com/api/health` reports the engine as reachable.

`JWT_SECRET` is generated for you. The API refuses to start with a default secret in production.

## 2. Vercel
1. **Add New → Project**, import the repo, set **Root Directory** to `frontend` (framework: Vite, detected from
   [frontend/vercel.json](../frontend/vercel.json)).
2. Environment variable: `VITE_API_URL` = the API's `https://….onrender.com` URL (no trailing slash). It is read at build
   time, so redeploy after changing it.
3. Deploy, then put the Vercel URL into the API's `CORS_ORIGIN` and `PUBLIC_APP_URL` on Render.

Custom domains: if the API is not on `*.onrender.com`, add its origin to `connect-src` in `frontend/vercel.json`.
Several origins (preview + production) can be listed in `CORS_ORIGIN`, comma-separated.

## Notes and limits
* **Plans.** Free Render services sleep and have no disk; analyses run for minutes, so use paid plans. The engine needs
  about 2 GB for the raster stack (`standard`). The engine's disk holds finished jobs, maps and caches.
* **Users and reports** live in the Render Postgres (`DATABASE_URL`). Back it up with Render's backups.
* **One engine instance.** Jobs are held by the engine process; do not scale it horizontally.
* **n8n** is optional and not part of this deployment (`REPORT_DELIVERY=smtp`).
* Generate more than one API instance only after checking monitors: the scheduler runs inside the API process.
