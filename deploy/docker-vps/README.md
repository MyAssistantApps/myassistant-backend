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
