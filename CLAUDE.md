# Working in this repo (team rules — read first)

Five people work on this code and share ONE Claude account, so a session
cannot tell who is driving it. These rules keep us from overwriting each
other's work. They apply to people and to Claude alike.

## Branches: only the owner pushes `production`

`production` is protected on GitHub: **only dhanuvagman006 can push to it**
(no force-push, no delete). Everyone else works on their own branch and
opens a pull request; the owner reviews and merges.

Each teammate has ONE branch of their own, in both repos, that only they
(and the owner) can push to:

| Person | Branch    |
|--------|-----------|
| Allen   (allenlobo31)      | `allen`   |
| Manish  (Manish-G-suvarna) | `manish`  |
| Karthik (Karthikshettyhub) | `karthik` |
| Chirag  (Chiragkulal07)    | `chirag`  |

Work only on your own branch. It builds nothing, deploys nothing and sends
nothing to testers, so you cannot break the app for anyone else there.

1. Switch to your branch and bring in the latest `production`:
   `git checkout <you> && git pull --rebase origin <you> && git pull --rebase origin production`
2. Make your change. Commit small, clear commits.
3. Run the checks (below). Do not push code that fails them.
4. Before **every** push, bring in the latest again:
   `git pull --rebase origin production`, resolve conflicts, re-run the checks.
5. Push: `git push origin <you>`. Never push to `production` —
   GitHub refuses it ("protected branch").
6. When it works, open a pull request into `production`:
   `gh pr create --base production --head <you> --fill` — say what changed
   and how you tested it. The owner reviews and merges it.
7. **Never force-push** a branch someone else also works on, and never
   rewrite commits already on GitHub. The `.githooks/pre-push` hook refuses
   a push that would drop commits already on the remote; `./setup.sh`
   switches it on. Do not bypass it with `--no-verify`.
8. Check `git config user.name` is YOUR name on your machine, so the
   history shows who did what (the shared Claude account does not).

Claude: never push to `production` unless the person at
the keyboard is the owner and asked for it. Otherwise ask who is at the
keyboard, work on THEIR branch from the table above, push it, and open a PR.
Never push to another teammate's branch, never merge a PR, and never change
branch protection, collaborators, secrets or workflows for a teammate.

## Pushing deploys

Every merge or push to `production` here **deploys the backend to production**
(the deploy job in `.github/workflows/ci.yml` → `/opt/myassistant/deploy.sh`
on `backend.envisionsit.in`) — one more reason it goes through the owner's
review. The script backs up the database, swaps in the image CI built and
tested, checks `/health/ready` and rolls back on any failure. Branches do not deploy. Details:
`deploy/docker-vps/README.md`.

## Secrets — both repos are PUBLIC

Never commit `.env`, `firebase-adminsdk.json`, `google-services.json`,
keystores, API keys or tokens. They live in the team Bitwarden vault and
`./setup.sh` writes them locally. If one is ever committed, tell the team:
it must be rotated, not just deleted.

## Checks before pushing

- `npm run test:manifest` (every test script points at a real file)
- `node scripts/manager-test.js` when touching `src/agents/manager.js` or tools
- `npm run test:production` — the server with production's own settings
  (`deploy/docker-vps/production.flags`). It snapshots what the phone receives
  from `/ai/config`; if you changed that on purpose, run
  `UPDATE_SNAPSHOT=1 npm run test:production` and commit the diff. If you
  change the server's `.env`, change `production.flags` in the same PR.
- The suites for what you changed, against a throwaway database:
  `DATABASE_URL=postgres://myassistant:localdev@localhost:5432/myassistant_test npm run test:<suite>`
- `npm run test:all` runs everything (CI does this on every push).
- Tests that read the app's source (test:fulfillment, test:state, e2e-g3)
  look for it at `../myassistant-flutter`; elsewhere set
  `APP_DIR=/path/to/myassistant-flutter`.

## Setup

`./setup.sh` (see SETUP.md) resets both repos to `origin/production` (commit
your branch's work first — uncommitted changes are backed up, then
discarded), writes
the secrets from Bitwarden and runs the backend and the app.

---

# Project guide (for Claude and the team)

What MyAssistant is: a voice-first personal assistant app (Flutter) with a
Node/Express + Postgres backend. Users name their own assistant — never
hardcode a name (it was once "Hari"; that is the client's old name, not the
product's). The product is **MyAssistant**.

## Production (since 2026-11-14)

| | |
|---|---|
| Backend URL | `https://backend.envisionsit.in` (the app's default) |
| Server | `189.72.146.77`, Docker Compose in `/opt/myassistant/` (backend, postgres 16, caddy) |
| Deploy | push to `production` → CI (`ci.yml`) → `deploy.sh` (backup, swap image, health, rollback) |
| Settings | the server's `/opt/myassistant/.env`, mirrored without secrets in `deploy/docker-vps/production.flags` |
| Admin panel | `/admin-panel` — sign in with the server's `ADMIN_KEY` |
| Old server | `myassistant.wishme.today` — retired, not deployed to, its data was not migrated |

## App updates (no App Distribution needed)

The backend is the update channel: `/config` tells installed apps the newest
build and `/app/latest.apk` serves it; the app offers it on launch.
To publish a build:

1. Build with a **higher versionCode** than the last one published
   (`flutter build apk --release --build-number=<N>`; 207 was published on
   2026-11-14). The app only offers a build whose number is higher.
2. Upload: `POST /admin/apk` (header `X-Admin-Key`, multipart `apk`), or on
   the server copy the APK into `/opt/myassistant/data/` and run
   `docker compose exec backend node -e 'require("./src/routes/appUpdate").publish({tmpPath:"/app/data/<file>.apk",versionCode:N,versionName:"x.y.z",changelog:["…"]})'`.
3. Check `GET /config` shows the new `latestVersionCode`.

Builds must be signed with the team key (SHA-256 `9e6b2d23…`) or they will
not install over existing ones.

## How the code is organised

- `src/server.js` mounts every router; `src/db.js` owns the core schema.
- **Feature stores self-migrate**: each `src/<feature>/store.js` has a
  `migrate()` with `CREATE TABLE IF NOT EXISTS` — no change to db.js needed.
- **Privacy is enforced by tests.** Any new table with a `user_id` must be
  listed in `USER_TABLES` in `src/routes/privacy.js` (export + account
  delete), and its `migrate()` added to `ensureEveryTable()` in
  `scripts/erase-test.js` and `scripts/e2e-g5-security-privacy-test.js`.
  `npm run test:erase` fails until you do.
- **AI**: text goes through the OpenAI router `src/services/ai/router.js`
  (`generateReply(messages, {system, model, json, schema})`); voice is OpenAI
  Realtime; outbound calls are Bolna (`src/agents/agentCall.js`); inbound
  calls are Bolna too (`src/agents/inboundCalls.js`). Do not add other AI
  SDKs to the app — named Claude models are for development only.
- **Voice tools** live in `src/tools/builtins.js` (`registry.register`).
- The app sends its location as `X-Geo-Lat` / `X-Geo-Lng` and timezone as
  `X-TZ-Offset` on every request.

### Professional workspaces (doctor / advocate / business)

- `users.persona` is chosen at sign-up (`src/users/persona.js`:
  `requirePersona`). Each profession sees only its own tools;
  the server enforces it (403), the app just hides screens.
- `/clinic` (`src/clinic/`) is shared by all three, with `only(...)` gates per
  profession: profile & timings, slot engine, appointments, follow-ups,
  dues, consult notes + Rx (doctor), cases/hearings + legal drafting
  (advocate), invoices + leads (business; invoices for advocates too).
- `src/pro/` holds cases, hearings, invoices (amounts in paise, GST) and leads.
- Reminder sweeps are appended to the END of `sweep()` in
  `src/proactive/scheduler.js` — results are read by position.

### Public listings (`src/listings/`)

Professionals publish a page: `/listing` (their editor), `/listings/near`
(any user, nearest first), and public `/p/<slug>` pages with schema.org
data, plus `/sitemap.xml` and `/robots.txt` for Google. Doctors need a
registration number and advocates an enrolment number before going public.
Advocates get a factual page only (no posts, no fee — Bar Council Rule 36);
doctors post updates, not offers. Booking requests become real appointments.

## Running locally

```sh
# throwaway Postgres (never use a database that holds real data)
docker run -d --name ma-pg -e POSTGRES_USER=e2e -e POSTGRES_PASSWORD=e2e -e POSTGRES_DB=ma -p 55432:5432 postgres:16-alpine
DATABASE_URL=postgres://e2e:e2e@localhost:55432/ma PORT=3998 node src/server.js
# phone over USB, app built with --dart-define=BASE_URL=http://localhost:3998:
adb reverse tcp:3998 tcp:3998
```

## Known gaps (2026-11-14)

- Before a public release, review production's `.env` with
  `npm run test:production` — it prints warnings for unsafe settings.
- Missing on production: `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` /
  `RAZORPAY_WEBHOOK_SECRET` (payment links). `SERPAPI_KEY` (flight and
  hotel prices, fare watch) was set on 2026-11-24.
- `e2e-g5`'s forget_memory test is occasionally flaky; rerun before chasing it.
