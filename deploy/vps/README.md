# VPS — backend.envisionsit.in

Production since 2026-11-07: `root@189.72.146.77` (Ubuntu 26.04, 4 GB RAM,
48 GB disk). It replaced the shared host behind `myassistant.wishme.today`
(`myass620@168.119.64.101`); the scripts for that host (`start.sh`,
`supervise.sh`, `stop.sh`, `deploy.sh`) are kept here only for reference.

Everything runs in Docker Compose and restarts on reboot
(`restart: unless-stopped`, Docker enabled in systemd). The firewall (ufw)
allows only SSH, HTTP and HTTPS.

## Layout on the server — `/opt/myassistant/` (mode 700, root)

| Path | What |
|---|---|
| `compose.yml` | three services: `backend`, `postgres` (16), `caddy` (HTTPS) |
| `Caddyfile` | `backend.envisionsit.in` → `backend:3000`, Let's Encrypt automatic |
| `.env` | production settings and secrets (600) — mirrors `production.flags` |
| `pg.env` | `POSTGRES_PASSWORD` (600) |
| `firebase-adminsdk.json` | mounted read-only into the backend |
| `src-repo/` | the backend code being run (a `git archive`, not a clone) |
| `src-prev/` | the code before the last deploy (rollback) |
| `data/` | user files (`DATA_DIR`, `/app/data` in the container) |
| `pgdata/` | the database |
| `backups/` | `predeploy-*.sql.gz`, one per deploy, newest 14 kept |
| `deploy.sh` | copy of `deploy-docker.sh` in this folder |

Postgres has no published port; only Caddy listens on 80/443.

## Deploy on push

`.github/workflows/deploy.yml` runs on every push to `hardening`: it sends
the commit as a tar over SSH to a key whose forced command is
`/opt/myassistant/deploy.sh`, so that key can do nothing else:

```
command="/opt/myassistant/deploy.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 … github-actions-deploy@myassistant-backend
```

Repo secrets: `VPS_SSH_KEY` (the private half), `VPS_KNOWN_HOSTS`
(`ssh-keyscan -t ed25519 189.72.146.77`).

`deploy.sh` backs up the database, keeps the running image as
`myassistant-backend:previous`, builds, restarts and polls `/health`; on
any failure it restores the previous code and image.

Deploy by hand from a checkout:

```bash
git archive --format=tar origin/hardening | ssh root@189.72.146.77 'bash /opt/myassistant/deploy.sh'
```

## Everyday commands (on the server, in `/opt/myassistant`)

```bash
docker compose ps                         # what is running
docker compose logs backend -f --tail 100 # the backend's log
docker compose up -d --force-recreate backend   # after editing .env
```

`docker compose restart` does NOT re-read `.env`; recreate instead.

## Restore a backup

```bash
cd /opt/myassistant
docker compose stop backend
gunzip -c backups/predeploy-<stamp>.sql.gz | docker compose exec -T postgres \
  sh -c 'dropdb -U myassistant --if-exists myassistant_restore &&
         createdb -U myassistant myassistant_restore &&
         psql -U myassistant -d myassistant_restore -v ON_ERROR_STOP=1 -q'
# check it, then swap names:
docker compose exec -T postgres psql -U myassistant -d postgres \
  -c 'ALTER DATABASE myassistant RENAME TO myassistant_old' \
  -c 'ALTER DATABASE myassistant_restore RENAME TO myassistant'
docker compose start backend
```

**Limit:** backups are on the same disk as the data. Copy them off the
server for protection against losing the machine.

## Things that will bite

- **`.env` is production**: `NODE_ENV=production`, `ALLOW_APP_KEY=false`,
  its own `JWT_SECRET`/`ADMIN_KEY`. Deploys never touch it.
- **`ALLOW_DEV_PHONE_VERIFY=true`** — anyone can claim any phone number.
  Turn it off before a public release.
- **Bolna**: the webhook secret is derived from `BOLNA_API_KEY`. Rotating
  the key means re-running `scripts/bolna_agents.js --apply` with
  `PUBLIC_BASE_URL=https://backend.envisionsit.in` and updating `.env`
  together, or call results stop arriving.
- **One process.** Sessions, rate limits and the scheduler live in memory
  (see `DEPLOYMENT.md`); never run two backends against this database.
