# Security — MyAssistant backend

Owner: dhanuvagman006. Last full review: **2026-11-15**, after the OpenAI-key
incident (production key `…u6AA` used directly by an outsider; revoked).

This file says what protects the service, what an operator must do, and what
to do when something goes wrong. Report a vulnerability privately to the
owner, not in a public issue — both repos are public.

---

## 1. Controls in place

| Area | Control | Where |
|---|---|---|
| Sessions | HS256 pinned; account must exist and not be paused; `sessions_valid_after` revokes every older token; scoped tokens (`appfn`, `console`) refused outside their routes | `src/middleware/auth.js` |
| Sign out everywhere | `POST /auth/logout-all` ends every session, console token, assistant-functions key and connected-app key | `src/routes/auth.js` |
| Connected-app keys | `mya_` keys hashed at rest, scope-gated, **die with sign-out-everywhere** | `src/platform/auth.js` |
| Passwords | bcrypt; one message for "no user"/"wrong password", equal timing; **per-account lock after 10 failures / 15 min** (app and console) | `src/services/loginGuard.js` |
| Console codes | 6 digits, HMAC-hashed, 5 tries, 5 min; **≤ 6 codes per account per day** | `src/platform/console.js` |
| Admin | `ADMIN_KEY` (16+ chars) compared in constant time, rate-limited; `/analytics` now admin-only | `src/routes/admin*.js`, `src/middleware/adminKey.js` |
| Rate limits | per IP (global 240/min, `/auth` 20/15 min); per user on every paid route | `src/server.js` |
| **Spend circuit-breaker** | Every server-side OpenAI call checks today's metered spend: **global $40/day, per user $3/day, 150 realtime sessions/user/day** (env-tunable); refuses with 402; admin alert at 50/80/100 % | `src/ops/budget.js` |
| Error hygiene | Provider bodies, key fragments, SQL, stack frames, internal hosts and paths are withheld from clients and logged server-side | `src/infra/safeErrors.js` |
| Webhooks | Razorpay HMAC over raw body; Bolna secrets in constant time; "paid" payment status is final | `src/payments`, `src/routes/agentCall.js` |
| SSRF | `safeFetch` pins resolved IPs (private, loopback, link-local, metadata, CGNAT blocked; redirects re-checked) | `src/services/safeFetch.js` |
| Uploads | multer size limits; **zip-bomb guard** before Office parsing; ffmpeg limited to audio extensions + `-protocol_whitelist file`; stored documents served `nosniff`, non-passive types as attachments with a sandbox CSP | `src/docs/extract.js`, `src/meetings/routes.js`, `src/routes/docs.js` |
| Metrics | `/metrics` token-gated (closed in production without a token); 404s no longer create label series (memory-DoS) | `src/server.js` |
| Logs | webhook secrets masked in access logs | `src/infra/observability.js` |
| Transport | Caddy: TLS + HSTS; plain HTTP now redirects (308) except `/health` | `deploy/docker-vps/Caddyfile` |
| Host | backups written owner-only; `.env`/`pg.env` chmod 600 on every deploy | `deploy/docker-vps/deploy.sh` |
| Container | non-root `node` user, `npm ci --omit=dev`, secrets mounted not baked; `.dockerignore` excludes keys and data | `Dockerfile`, `.dockerignore` |
| CI | `security.yml`: gitleaks over full history, `npm audit --audit-level=high` (prod deps), CodeQL security-extended; workflows run with `contents: read`; deploy only from `hardening`, bound to the `production` environment | `.github/workflows/` |
| Tests | `npm run test:hardening` (17 regression tests for the above) inside `test:all` | `scripts/hardening-test.js` |

---

## 2. Owner actions still required (cannot be done from code)

Do these in order. Each one closes a hole that code cannot.

1. **OpenAI project limits** (platform.openai.com → Settings → Project → Limits):
   - create a *project-scoped* key for production only; never reuse it
     elsewhere (no laptops, no old servers);
   - **model allow-list**: only the models the server uses (`gpt-5.4-nano`,
     `gpt-4.1`, `gpt-4o-mini-transcribe`, `gpt-4o-mini-tts`,
     `gpt-image-1.5`, `gpt-realtime`, `text-embedding-3-small` — check the
     boot log line `models (openai): …`). The stolen key was used for
     `gpt-6.1-sol`, which an allow-list would have refused;
   - **hard monthly budget** + email alerts at 50 % / 80 %;
   - put the new key in `/opt/myassistant/.env` (`OPENAI_API_KEY`) and
     `docker compose up -d backend`.
2. **Retire the old host** `myassistant.wishme.today`: it probably still holds
   the old key and runs build 206. Ask the host to shut it down.
3. **Rotate every secret that lived on either server or in CI**: `ADMIN_KEY`,
   `JWT_SECRET` (signs every user out once), `BOLNA_API_KEY` (also changes the
   Bolna webhook URL secret — update the agent's webhook), Firebase service
   account, `VPS_SSH_KEY`, the Postgres password in `pg.env`.
4. **Revoke keys exposed in public git history** (found by gitleaks, baselined
   in `.gitleaksignore` as ROTATE): the old free-astrology API key
   (`src/services/tools/astrology.js`, commit `0dec36d`) and the Simli API key
   (app repo `lib/core/config.dart`, commit `4c3062b`). Deleting them from
   git does not un-leak them.
5. **GitHub → Settings → Environments → `production`**: required reviewer =
   owner, deployment branches = `hardening` only; move `VPS_SSH_KEY` and
   `VPS_KNOWN_HOSTS` from repo secrets into this environment. Do the same in
   the app repo for `UPDATE_ADMIN_KEY`, keystores and `FIREBASE_SERVICE_ACCOUNT`.
   Until then any branch's workflow can read them. Then review past Actions
   runs on non-`hardening` branches for anything that printed or sent secrets.
6. **Firebase App Check**: revoke the debug token that ships in the public APK
   (`APP_CHECK_DEBUG_TOKEN`) and use Play Integrity; set a GCP budget alert on
   the Firebase project (Gemini via Firebase AI Logic is billed there, outside
   this server's meter).
7. **`ALLOW_DEV_PHONE_VERIFY=true`** lets any account claim any unregistered
   number (messages addressed to that number then reach the claimant). Either
   set it to `false` (call-code verification covers India) or list the testers
   in `DEV_PHONE_VERIFY_USERS`. Mirror the change in `deploy/vps/production.flags`.
8. **Copy the new `Caddyfile` and `deploy.sh`** to `/opt/myassistant/` (the
   deploy does not update them), then `docker compose restart caddy`. Then
   `chown root:1000 firebase-adminsdk.json && chmod 640 firebase-adminsdk.json`.
9. **Host hardening** (189.72.146.77): SSH keys only (`PasswordAuthentication
   no`, `PermitRootLogin prohibit-password`), `ufw` allowing 22/80/443 only,
   `unattended-upgrades`, fail2ban for sshd; keep off-host copies of
   `backups/` (they are on the same disk as the database).
10. **App signing**: production in-app updates are signed with the shared team
    debug keystore that all developers hold. Plan a dedicated release key held
    only by the owner (APK Signature Scheme v3 rotation keeps installs updating).

---

## 3. Incident response

**Signs**: an admin-inbox alert "AI spending has reached …"; `[budget] refused`
lines in `docker compose logs backend`; OpenAI usage on a model we do not call;
a spike in 401/429 at `/auth`; `[safe-errors]` lines naming a provider 401.

**Key or secret compromise (OpenAI, Bolna, Razorpay, …)**
1. Revoke the key at the provider **first** (that stops the money).
2. Create a new one; put it in `/opt/myassistant/.env`; `docker compose up -d backend`.
3. Check the provider's usage/logs by key and model to bound the damage; keep screenshots.
4. Find where the key lived (server `.env`, old hosts, CI secrets, laptops, Bitwarden
   exports) and close that path. `git log -p -S'<last 6 chars>'` in both repos.
5. Write it up in `Reports/` (what, when, cost, root cause, fix).

**Account takeover or a stolen session token**
- The user (or the admin, by setting `sessions_valid_after`) runs
  `POST /auth/logout-all`. Every token, console session and app key dies.
- Pause the account from the admin panel if abuse continues (paused = 401 everywhere).

**Admin key leaked**: change `ADMIN_KEY` in `.env`, restart; the admin-panel
cookie (HMAC of the key) stops working at once.

**`JWT_SECRET` leaked**: change it and restart. Every user is signed out once.

**Server compromise suspected**: take a disk snapshot, rotate every secret in §2.3
from a clean machine, rebuild the VPS from the repo + latest verified backup.

**Restore from backup**: `gunzip -c backups/predeploy-<stamp>.sql.gz | docker
compose exec -T postgres psql -U myassistant myassistant` into an empty database.
Test a restore at least once a quarter.

---

## 4. Maintenance checklist

Every pull request
- [ ] CI `security` workflow green (no new secret, no high/critical advisory, CodeQL clean)
- [ ] new tables with `user_id` listed in `USER_TABLES` (privacy export/erase)
- [ ] new paid call goes through `services/ai/openai.js` (so the budget applies) or calls `ops/budget.check()` itself
- [ ] new route that loads by id filters by `user_id`; new outbound fetch of a user-supplied URL uses `safeFetch`
- [ ] no `e.message` from a provider returned on purpose; validation messages are written by hand

Weekly
- [ ] read the admin inbox ops alerts; glance at spend per user/feature in the admin panel
- [ ] the scheduled `security` run's results (new advisories)

Monthly
- [ ] OpenAI / Bolna / Firebase / GCP usage vs. our own meter — a gap means spend we do not see
- [ ] `npm audit`; update dependencies; rebuild the image (base-image patches)
- [ ] review who holds `ADMIN_KEY`, deploy keys, GitHub collaborators

Quarterly
- [ ] rotate `ADMIN_KEY` and provider keys; test a backup restore
- [ ] re-run a full security review of anything new (routes, webhooks, uploads)

Before a public release
- [ ] `ALLOW_DEV_PHONE_VERIFY=false`; `npm run test:production` prints no warnings
- [ ] dedicated release signing key; App Check with Play Integrity
- [ ] email verification (or social sign-in only) before paid features — today anyone can mint accounts
