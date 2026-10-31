# VPS — myassistant.wishme.today

The live backend runs on a shared host (`myass620@168.119.64.101`, Ubuntu
22.04, no root, no Docker, no cron). These scripts are copies of the ones in
`~/app/` on the server, kept here so the setup is versioned and can be
rebuilt. **Editing them here does not change the server** — copy a changed
script to `~/app/` by hand.

## Layout on the server

| Path | What |
|---|---|
| `~/opt/node22` | Node 22 (nodejs.org tarball, checksum verified); the host's own is 20 |
| `~/opt/pg` | PostgreSQL 14 binaries (`apt-get download postgresql-14`, `dpkg -x`) |
| `~/app/pgdata` | the database — unix socket in `~/app/pgrun` only, no TCP, peer auth |
| `~/app/myassistant-backend` | this repo on `hardening`, with its `.env` and `firebase-adminsdk.json` |
| `~/app/data` | user files (`DATA_DIR`) |
| `~/app/backend.log` | the backend's log (rotated at ~50 MB) |
| `~/public_html/.htaccess` | Apache forwards the domain (and WebSockets) to `127.0.0.1:38231` |

## Scripts

| Script | Does |
|---|---|
| `start.sh` | starts Postgres and the supervisor if they are not running (safe to repeat) |
| `supervise.sh` | runs `node src/server.js`, restarts it 5 s after any exit |
| `stop.sh` | stops the backend; `--all` stops Postgres too |
| `deploy.sh` | `origin/hardening` → `npm ci` → restart → wait for `/health` |

**After a server reboot run `~/app/start.sh`** — cron is not allowed here,
so nothing starts it automatically.

## Deploy on push

`.github/workflows/deploy.yml` runs `deploy.sh` on every push to
`hardening`. GitHub's key is in `~/.ssh/authorized_keys` with a forced
command, so it can only ever run `deploy.sh`:

```
command="/home/myass620/app/deploy.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 … github-actions-deploy@myassistant-backend
```

Secrets in the repo: `VPS_SSH_KEY`, `VPS_KNOWN_HOSTS`.

## Things that will bite

- **No IPv6 route.** Node tried IPv6 first and every new connection to
  OpenAI stalled ~7 s. `supervise.sh` sets
  `NODE_OPTIONS=--dns-result-order=ipv4first`. Keep it.
- **`.env` is production**: `NODE_ENV=production`, `ALLOW_APP_KEY=false`,
  typed phone verification off, its own `JWT_SECRET`/`ADMIN_KEY`.
  `deploy.sh` never touches it (git only resets tracked files).
- **One process.** Sessions, rate limits and the scheduler live in memory
  (see `DEPLOYMENT.md`); never run two backends against this database.
