# Deploying Bhu-Drishti (free, no server)

Bhu-Drishti is **one Docker container**: the website, the API and the AEQE satellite engine together. It needs
nothing else to start, so it runs on a free host:

| Piece | Free service | Why |
|---|---|---|
| The app | **Hugging Face Spaces** (Docker Space, free “CPU basic”: 2 vCPU, 16 GB RAM) | Enough memory for live satellite reads; builds straight from the code |
| Accounts and reports | **Neon** Postgres (free plan) | Keeps users and reports when the Space restarts or redeploys |
| Email | **Gmail** with an App Password (or any SMTP account) | Password resets and report emails |
| Data | Planetary Computer, NASA FIRMS, Copernicus, NASA Earthdata | All free; keys are free to request |

After a one-time setup (about 20 minutes), **every push to `main` deploys itself**: GitHub runs the tests, then
copies the app to the Space, and Hugging Face rebuilds it.

Free-tier limits worth knowing (check each provider’s current terms):

* A free Space **sleeps after about 48 hours without visitors** and wakes on the next visit (about a minute).
  Scheduled monitors don’t run while it sleeps.
* A free Space’s own disk is **not permanent**. That is why accounts go to Neon. Saved analysis results and the
  satellite tile cache are rebuilt as needed after a restart.
* Neon’s free plan includes a small database (hundreds of MB), far more than Bhu-Drishti needs for accounts and
  reports.

## 1. Free database (Neon), 5 minutes

1. Sign up at [neon.tech](https://neon.tech) and create a project (region: any; Frankfurt is closest to the
   satellite data and the Space).
2. Copy the **connection string**. It looks like
   `postgresql://user:password@ep-xxxx.eu-central-1.aws.neon.tech/neondb?sslmode=require`.

Bhu-Drishti creates its tables on first start. (Skip this step to try things out: the app then keeps accounts in a
file inside the Space, which is wiped on restart.)

## 2. The Space, 5 minutes

1. Sign up at [huggingface.co](https://huggingface.co).
2. **New Space**: name `bhu-drishti`, SDK **Docker** (blank template), hardware **CPU basic (free)**, visibility
   Public (Private works too, but then only you can open it).
3. In the Space: **Settings → Variables and secrets**. Add these as **secrets**:

   | Secret | Value |
   |---|---|
   | `DATABASE_URL` | the Neon connection string |
   | `JWT_SECRET` | a long random value, e.g. from `openssl rand -base64 48` or a password generator (48+ characters) |
   | `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | e.g. `smtp.gmail.com` / `465` / your Gmail / a Gmail **App Password** / your Gmail |
   | `REPORT_AUTO_EMAIL` | where every new report is emailed (comma-separated) |
   | `NASA_FIRMS_MAP_KEY` | fires: [firms.modaps.eosdis.nasa.gov/api/map_key](https://firms.modaps.eosdis.nasa.gov/api/map_key/) |
   | `CDSE_CLIENT_ID` / `CDSE_CLIENT_SECRET` | Copernicus Data Space OAuth client |
   | `EARTHDATA_TOKEN` | NASA Earthdata token |

   All are optional except `JWT_SECRET` and `DATABASE_URL` for a real deployment. The public address for
   password-reset links is filled in automatically from the Space.
4. **Settings → Access Tokens** (in your Hugging Face profile, not the Space): create a token with **Write**
   permission and copy it.

## 3. Connect GitHub to the Space, 3 minutes

In the GitHub repository: **Settings → Secrets and variables → Actions**

* **Secrets → New repository secret:** `HF_TOKEN` = the Hugging Face write token.
* **Variables → New repository variable:** `HF_SPACE` = your Space id, e.g. `your-hf-name/bhu-drishti`.

(Adding these needs admin rights on the repository; ask the repository owner if the Settings tab is missing.)

## 4. Deploy

Push anything to `main`, or open **Actions → Deploy to Hugging Face → Run workflow**. The workflow waits for CI,
copies the app to the Space, and Hugging Face builds it (about 10 minutes the first time; the Space page shows the
build log). Then open `https://huggingface.co/spaces/your-hf-name/bhu-drishti`, or the direct address
`https://your-hf-name-bhu-drishti.hf.space`.

From now on, every change merged into `main` goes live by itself.

## 5. Check it

1. Create an account, sign out, and try **Forgot password?**: the email should arrive.
2. **Data sources** in the app: each provider you configured shows as working.
3. Ask *“How many fire detections were there in the last 10 days?”* for a Punjab district, then a flood question
   for an Assam district (the first run in a district takes a few minutes).
4. Restart the Space (**Settings → Restart**) and sign in again: your account is still there (it lives in Neon).

## Run it on your own computer

```bash
cp .env.example .env        # optional: fill in keys; the app starts without them
docker compose up -d --build
```

Open http://localhost:8080. Data is kept in the `app-data` Docker volume. Without Docker Compose:
`docker build -t bhu-drishti . && docker run -p 7860:7860 bhu-drishti`, then open http://localhost:7860.

## Troubleshooting

| Symptom | What to do |
|---|---|
| Space shows **Build error** | Open the build log on the Space page. Re-run **Actions → Deploy to Hugging Face**. |
| Deploy workflow fails at “Push to the Space” | `HF_TOKEN` needs **Write** permission; `HF_SPACE` must be exactly `owner/space-name`. |
| Everyone is signed out after a restart | Set `JWT_SECRET` as a Space secret (otherwise a new one is generated on each start). |
| Accounts disappear after a restart | Set `DATABASE_URL` (Neon). Without it accounts live in the Space’s temporary disk. |
| Reset emails don’t arrive | Check the `SMTP_*` secrets; Gmail needs an App Password, not your normal password. |
| “too many requests” at sign-in for everyone | Add the secret `TRUST_PROXY` = `2`. |
| Live questions fail | Space **Logs** tab: missing or wrong data keys are reported at start-up. |
| Website loads slowly after a quiet period | The free Space was asleep; it wakes in about a minute. |
