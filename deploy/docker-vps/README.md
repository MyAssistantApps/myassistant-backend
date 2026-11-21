# Production VPS — backend.envisionsit.in

**Production since 2026-11-14.** The app's default server and the GitHub
deploy both point here. (The old shared host, `myassistant.wishme.today`,
is retired and no longer deployed to.)

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
| `.env` | the backend's settings and secrets (never in git) — mirror of `production.flags` (this folder) |
| `pg.env` | the Postgres password (never in git) |
| `firebase-adminsdk.json` | push notifications (never in git) |
| `deploy.sh` | the deploy script (below) |
| `backup.sh` | the nightly database backup (below) |
| `src-repo/`, `src-prev/` | the running code and the previous one (rollback) |
| `data/` | uploads, files, remote config (mounted at `/app/data`) |
| `pgdata/` | the database files |
| `backups/` | `pg_dump` nightly (`nightly-*`) and before every deploy (`predeploy-*`), newest 14 of each kept |

## How a deploy works

`/opt/myassistant/deploy.sh` (see Pipeline below for how CI reaches it):

1. loads the image CI built (or, as a fallback, unpacks a source tar and
   builds it here)
2. backs up the database
3. tags the running image `:previous`
4. restarts the backend on the new image
5. waits for `/health/ready` — and on any failure puts the previous image
   (and code) back

## By hand

```sh
cd /opt/myassistant
docker compose ps
docker compose logs backend --tail 100
git -C <your clone> archive origin/production | ssh <sudo-user>@189.72.146.77 sudo /opt/myassistant/deploy.sh deploy
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

## One backend process only

Never scale the `backend` service or run a second backend against this
database. Assistant sessions, agent-call records, the daily call quota,
rate limits and the proactive scheduler live in process memory: with two
processes a voice session's follow-up can land on the one that never saw
it, a call's webhook on the one that did not place it, and both run the
scheduler (a patient recall could be phoned twice). Scaling out needs that
state moved into Postgres first.

## Backups and restore

`backup.sh` dumps the database nightly to `backups/nightly-<stamp>.sql.gz`,
checks the dump is complete before rotating, and keeps the newest 14.
`deploy.sh` also writes a `predeploy-*` dump before every deploy. Install
the nightly job once:

```sh
sudo install -m 700 deploy/docker-vps/backup.sh /opt/myassistant/backup.sh
# root's crontab (sudo crontab -e): 21:00 UTC = 02:30 IST
0 21 * * * /opt/myassistant/backup.sh >> /opt/myassistant/backups/nightly.log 2>&1
```

**Restore** (replaces the database with the dump; take a fresh backup
first so the current state is recoverable too). The dump is loaded into a
side database and the names are swapped, so a bad dump never overwrites
the live data:

```sh
cd /opt/myassistant
docker compose stop backend
docker compose exec -T postgres sh -c \
  'dropdb -U myassistant --if-exists myassistant_restore && createdb -U myassistant myassistant_restore'
gunzip -c backups/<file>.sql.gz | docker compose exec -T postgres \
  psql -U myassistant -d myassistant_restore -v ON_ERROR_STOP=1 -q
# check it, then swap names:
docker compose exec -T postgres psql -U myassistant -d postgres \
  -c 'ALTER DATABASE myassistant RENAME TO myassistant_old' \
  -c 'ALTER DATABASE myassistant_restore RENAME TO myassistant'
docker compose start backend
```

**Limit:** the backups share the disk with the data. They cover a bad
deploy or a mistaken delete, not the loss of the server. An off-server
copy is still to be added at the marked line in `backup.sh`.

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
