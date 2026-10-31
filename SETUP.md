# Local setup — myassistant-backend

## Quick start

Put both repos side by side (or just this one; the script clones the
other), plug in an Android phone with USB debugging, and run:

```bash
./setup.sh
```

It discards local changes in both repos (backed up to
`~/.myassistant-setup-backups/`), resets them to `origin/hardening`, pulls
the secrets from the team Bitwarden account, starts Postgres and the
backend, and launches the app on the phone. `./setup.sh --no-run` sets up
without starting anything; `./setup.sh --help` lists the options.

The owner publishes the secrets once with `./setup.sh --publish-secrets`.

The sections below are the same steps by hand.

Gets the backend running on your machine against a local Postgres. Work
happens on the `hardening` branch.

> **This repo is public.** Never commit `.env`, `firebase-adminsdk.json`,
> keystores, or any key. `.gitignore` already blocks them — do not force-add.
> Secrets live in the team's Bitwarden vault (see "Secrets" below).

## Prerequisites

- Node 22+ (`node -v`)
- Docker with the compose plugin (`docker compose version`)
- Access to the Bitwarden organization **MyAssistant** (ask a maintainer)

## 1. Clone

```bash
git clone https://github.com/MyAssistantApps/myassistant-backend.git
cd myassistant-backend
git checkout hardening
npm ci
```

## 2. Secrets

From Bitwarden, collection **Dev secrets**:

| Vault item | What to do with it |
|---|---|
| `backend .env overrides` (secure note) | `cp .env.example .env`, then paste the note's contents at the **end** of `.env`. When a key appears twice the last value wins. |
| `firebase-adminsdk.json` (secure note) | Save the note's contents as `firebase-adminsdk.json` in the repo root, then `chmod 600 firebase-adminsdk.json`. Optional: without it push notifications are skipped. |

Then make these local-only changes in `.env`:

```bash
# your own signing secrets — do not reuse the shared ones locally
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(48).toString('hex'))"
node -e "console.log('ADMIN_KEY=' + require('crypto').randomBytes(16).toString('hex'))"
```

Append both lines to `.env`, and make sure it contains:

```
DATABASE_URL=postgres://myassistant:localdev@localhost:5432/myassistant_dev
AUTH_DISABLED=false
ALLOW_APP_KEY=true
PUBLIC_BASE_URL=http://localhost:3000
```

`AUTH_DISABLED=true` skips all sign-in checks; the server refuses to start
with it when `NODE_ENV=production`, but keep it off locally too so Google
sign-in is actually exercised.

## 3. Postgres

`docker-compose.yml` does not publish Postgres to the host. Create a
git-ignored `docker-compose.override.yml`:

```yaml
services:
  postgres:
    ports:
      - "127.0.0.1:5432:5432"
```

Then:

```bash
docker compose up -d postgres
docker compose exec -T postgres createdb -U myassistant myassistant_dev
```

The server creates its tables on first start. If it fails with
`could not initialize Postgres: column ... does not exist`, the database
has an old schema — create a new database name and point `DATABASE_URL` at it.

## 4. Run

```bash
npm run dev                         # restarts on file changes
curl localhost:3000/health          # {"ok":true,...}
```

To let a phone on the same Wi-Fi reach it, use your machine's LAN address
(`hostname -I`) in the app's `BASE_URL` — see the Flutter repo's SETUP.md.

## 5. Tests

```bash
npm test          # smoke test, no API keys needed
npm run test:all  # full suite
```

## Google Sign-In

The server checks Google ID tokens against `GOOGLE_WEB_CLIENT_ID`
(`src/routes/auth.js`). It must equal the app's `GOOGLE_WEB_CLIENT_ID`
(the Web client in Google Cloud project `hariassistantapp`). Older client
IDs that installed apps still use go in `GOOGLE_WEB_CLIENT_ID_LEGACY`
(comma-separated).

## Keys that turn features on

The server starts without these, but the features they back fail:

- `OPENAI_API_KEY` — replies, document analysis, notes, pictures
- `GEMINI_API_KEY` — Gemini text, speech and images
- `PLIVO_*` — agent and inbound calls
- See `.env.example` for the rest; every key is documented there.
