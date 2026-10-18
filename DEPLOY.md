# Deploying Bhu-Drishti

This guide puts Bhu-Drishti on one Linux server with HTTPS on your own domain. It takes about an hour the first time.
Everything runs in Docker; the only things installed on the server itself are Docker, nginx and certbot.

```
Internet ──HTTPS──▶ nginx + certbot on the server (443)
                        │
                        ▼  127.0.0.1:8080
                   web container (site + /api proxy)
                        │
          ┌─────────────┴─────────────┐
          ▼                           ▼
   backend (API, SQLite)  ──▶  engine (AEQE, satellite data)
```

Only the website is reachable from outside. The API, the engine and n8n listen on the server's loopback address only.

## 1. What you need

| Item | Notes |
|---|---|
| A Linux server (VM) | Ubuntu 24.04 or 22.04 LTS, **2 vCPU, 4 GB RAM, 30 GB disk** minimum (the engine image is ~1.4 GB, and live raster reads need memory). |
| Region | Satellite imagery is read from Microsoft Planetary Computer in **West Europe**. A server there (e.g. Azure West Europe, AWS eu-west/eu-central, Hetzner Germany) answers live questions several times faster than one in India. |
| A domain | e.g. `bhudrishti.example.in`, with access to its DNS settings. |
| An email-sending account | For password resets and reports. A transactional service (Brevo, Amazon SES, Mailgun, Zoho, SendGrid) is better than a personal Gmail. |
| Data-provider keys | NASA FIRMS map key (fires), Copernicus CDSE client, NASA Earthdata token, Google Earth Engine service account (optional). Planetary Computer needs no key. |

## 2. Prepare the server

```bash
ssh root@YOUR_SERVER_IP
apt update && apt upgrade -y
adduser deploy && usermod -aG sudo deploy        # a normal user to work as
curl -fsSL https://get.docker.com | sh            # Docker Engine + Compose plugin
usermod -aG docker deploy
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable   # firewall: only SSH and web
exit
```

Log back in as `deploy`, then check: `docker compose version` (v2 or newer).

## 3. Point your domain at the server

In your DNS provider add an **A record**: `bhudrishti.example.in → YOUR_SERVER_IP` (and an AAAA record if the server
has IPv6). Wait until `ping bhudrishti.example.in` shows the server's address.

## 4. Get the code

```bash
sudo mkdir -p /opt/bhu-drishti && sudo chown deploy: /opt/bhu-drishti
git clone https://github.com/aditimanthalkar53/Bhu-Drishti.git /opt/bhu-drishti
cd /opt/bhu-drishti
```

## 5. Configure `.env`

```bash
cp .env.example .env
nano .env
```

Set at least these (everything else can stay as it is):

| Setting | Value |
|---|---|
| `JWT_SECRET` | output of `openssl rand -base64 48` (**required**: the stack refuses to start without it) |
| `WEB_PORT` | `127.0.0.1:8080` (only the HTTPS proxy on the same server may reach the site) |
| `PUBLIC_APP_URL` and `WEB_ORIGIN` | `https://bhudrishti.example.in` |
| `TRUST_PROXY` | `2` (the HTTPS proxy plus the web container) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | from your email service |
| `REPORT_AUTO_EMAIL` | where every new report is emailed (comma-separated) |
| `NASA_FIRMS_MAP_KEY`, `CDSE_CLIENT_ID`, `CDSE_CLIENT_SECRET`, `EARTHDATA_TOKEN` | your data keys |

Google Earth Engine (optional): copy the service-account JSON to `engine/credentials/service-account.json` and set
`GOOGLE_CLOUD_PROJECT_ID`. Then lock the secrets down: `chmod 600 .env engine/credentials/*`.

## 6. Start Bhu-Drishti

```bash
docker compose up -d --build
docker compose ps          # wait until engine and backend show "(healthy)", about a minute
curl -s http://127.0.0.1:8080/api/health    # {"ok":true, … "engine":{"ok":true, …}}
```

The first build takes 5–10 minutes. The data lives in Docker volumes (`backend-data`, `engine-data`) and survives
restarts and updates.

## 7. HTTPS with nginx and Let’s Encrypt

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo cp deploy/nginx-https.conf.example /etc/nginx/sites-available/bhu-drishti
sudo sed -i 's/bhudrishti.example.in/YOUR_DOMAIN/g' /etc/nginx/sites-available/bhu-drishti
```

The example already has the HTTPS server block. For the very first certificate, nginx must start without it: open the
file and comment out the second `server { … }` block (port 443), then:

```bash
sudo ln -s /etc/nginx/sites-available/bhu-drishti /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --nginx -d YOUR_DOMAIN       # issues the certificate
```

Uncomment the 443 block again, then `sudo nginx -t && sudo systemctl reload nginx`. Certbot renews the certificate
automatically (`sudo certbot renew --dry-run` to check).

Open `https://YOUR_DOMAIN`: the website loads, **Open app** asks you to sign in, and you can create the first account.

## 8. Check that everything works

1. Create an account, sign out, and use **Forgot password?**: the reset email should arrive.
2. In the app open **Data sources**: each provider you configured shows as working.
3. Ask *“How many fire detections were there in the last 10 days?”* for a Punjab district (quick), then a flood
   question for an Assam district (can take several minutes the first time).
4. Open the result’s **Summary PDF**, and check that the automatic report email arrived at `REPORT_AUTO_EMAIL`.

## 9. Backups

```bash
crontab -e
# add this line: daily at 02:00, keeps the newest 14 backups
0 2 * * * cd /opt/bhu-drishti && ./scripts/backup.sh >> backups/backup.log 2>&1
```

Each backup (`backups/<date-time>/`) holds the user/report database and the engine’s saved results. **Copy the
`backups/` folder off the server regularly** (e.g. `rsync` to another machine or object storage). To restore:

```bash
./scripts/restore.sh backups/20261018-020000
```

## 10. Updating to a new version

```bash
cd /opt/bhu-drishti
./scripts/backup.sh                 # safety copy first
git pull
docker compose up -d --build        # rebuilds and replaces the containers; data volumes are kept
docker compose ps                   # all healthy again
```

Every push is checked by GitHub Actions (`.github/workflows/ci.yml`): all tests, the production build, and a full
start of the Docker stack. Deploy only commits whose CI run is green.

## 11. Optional: n8n for report delivery

```bash
docker compose --profile n8n up -d n8n
ssh -L 5678:127.0.0.1:5678 deploy@YOUR_SERVER_IP    # from your laptop, then open http://localhost:5678
```

n8n is never published to the internet; reach it through the SSH tunnel above. Setup steps: README → “n8n report
delivery”.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `docker compose up` says `set JWT_SECRET in .env` | Set a long random `JWT_SECRET` in `.env`. |
| Site shows **502 Bad Gateway** | `docker compose ps` and `docker compose logs backend --tail 50`. |
| Sign-in fails with “too many requests” for everyone | `TRUST_PROXY` is wrong: `2` behind the server’s nginx, `1` without it. |
| Password-reset links point to localhost | Set `PUBLIC_APP_URL` to `https://YOUR_DOMAIN`, then `docker compose up -d`. |
| Emails don’t arrive | Check the SMTP values; `docker compose logs backend | grep -i smtp`. Gmail needs an App Password. |
| Live questions are slow or time out | Normal for the first run in a district (it reads land cover and tiles it once). Consider a West-Europe server. |
| Engine unhealthy | `docker compose logs engine --tail 80`; a missing or wrong data key is reported at startup. |

Useful commands: `docker compose logs -f backend`, `docker compose restart engine`, `docker stats`.
