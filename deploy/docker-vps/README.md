# Production VPS — backend.envisionsit.in

**Production since 2026-11-14.** The app's default server and the GitHub
deploy both point here. (The old shared host, `myassistant.wishme.today` /
`myass620@168.119.64.101`, is described in `deploy/vps/` and is no longer
deployed to.)

- Host: `189.72.146.77` (Ubuntu, root, Docker Compose)
- Domain: `backend.envisionsit.in` (Caddy gets the HTTPS certificate)
- Everything lives in `/opt/myassistant/`

These files are copies of the ones on the server, kept so the setup is
versioned. **Editing them here does not change the server** — copy a changed
file to `/opt/myassistant/` by hand.

## Layout on the server

| Path | What |
|---|---|
| `compose.yml` | backend (built from `src-repo/`), postgres 16, caddy |
| `Caddyfile` | HTTPS reverse proxy to the backend |
| `.env` | the backend's settings and secrets (never in git) — mirror of `deploy/vps/production.flags` |
| `pg.env` | the Postgres password (never in git) |
| `firebase-adminsdk.json` | push notifications (never in git) |
| `deploy.sh` | the deploy script (below) |
| `src-repo/`, `src-prev/` | the running code and the previous one (rollback) |
| `data/` | uploads, files, remote config (mounted at `/app/data`) |
| `pgdata/` | the database files |
| `backups/` | `pg_dump` before every deploy, newest 14 kept |

## How a deploy works

Every push to `hardening` runs `.github/workflows/deploy.yml`: the gate tests,
then `git archive HEAD | ssh root@189.72.146.77 deploy`. The deploy key in
root's `authorized_keys` has a forced command, so it can only run
`/opt/myassistant/deploy.sh`, which:

1. unpacks the commit next to the running code
2. backs up the database
3. tags the running image `:previous`
4. builds and restarts the backend
5. waits for `/health` — and on any failure puts the previous code and image back

GitHub secrets: `VPS_SSH_KEY` (the deploy key's private half) and
`VPS_KNOWN_HOSTS` (`ssh-keyscan 189.72.146.77`).

## By hand

```sh
cd /opt/myassistant
docker compose ps
docker compose logs backend --tail 100
git -C <your clone> archive origin/hardening | ssh root@189.72.146.77 /opt/myassistant/deploy.sh
# roll back to the previous image:
docker image tag myassistant-backend:previous myassistant-backend:latest
docker compose up -d --no-build --force-recreate backend
```

## Pipeline (since 2026-11-20)

`production` is the protected branch (only the owner pushes or merges).
A push to it runs `.github/workflows/ci.yml`: module/manifest checks, the
full test suite, the Docker image built once in CI (it must boot and report
its sha on `/health`), then **deploy**: the image is streamed to
`ghdeploy@189.72.146.77`, whose key may only run
`/usr/local/bin/myassistant-deploy` → `sudo /opt/myassistant/deploy.sh
deploy-image <sha>` (backup, swap, `/health/ready`, rollback). **verify**
then checks the public URL runs that sha. Other branches only test.

One-time server setup (root SSH is off — use a sudo user):

```sh
# 1. deploy user + forced command (public half of the GitHub deploy key)
sudo bash deploy/docker-vps/setup-deploy-user.sh "ssh-ed25519 AAAA… github-actions-deploy"
# 2. new deploy script and Caddyfile
sudo install -m 700 deploy/docker-vps/deploy.sh /opt/myassistant/deploy.sh
sudo cp deploy/docker-vps/Caddyfile /opt/myassistant/Caddyfile
# 3. GitHub: environment "production" → secrets VPS_SSH_KEY (private half),
#    VPS_KNOWN_HOSTS (ssh-keyscan 189.72.146.77); branch policy: production only
```

## Monitoring

`monitoring/` holds Prometheus (metrics, 15 days), Loki + Alloy (container
logs, 7 days), Grafana (dashboards: Overview, Host & containers, Logs),
node-exporter, cAdvisor and postgres-exporter — about 1.3 GB RAM in total.
Grafana: `https://backend.envisionsit.in/grafana/` (user `admin`). Alert
rules (`prometheus/alerts.yml`) show in Grafana; nothing is sent anywhere.

```sh
sudo cp -r deploy/docker-vps/monitoring /opt/myassistant/
cd /opt/myassistant
sudo cp monitoring/monitoring.env.example monitoring/monitoring.env   # fill in
openssl rand -hex 24 | sudo tee monitoring/metrics_token               # and METRICS_TOKEN=<same> in .env
sudo chmod 600 monitoring/monitoring.env monitoring/metrics_token
sudo mkdir -p monitoring-data/{prometheus,grafana,loki,alloy}
sudo chown 65534:65534 monitoring-data/prometheus; sudo chown 472:472 monitoring-data/grafana; sudo chown 10001:10001 monitoring-data/loki
sudo docker compose -f compose.yml -f monitoring/compose.monitoring.yml up -d
```

Dashboards are generated: edit `monitoring/grafana/build-dashboards.js`, run
it with node, commit the JSON.
