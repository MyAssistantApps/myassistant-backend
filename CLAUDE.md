# Working in this repo (team rules — read first)

Five people work on this code and share ONE Claude account, so a session
cannot tell who is driving it. These rules keep us from overwriting each
other's work. They apply to people and to Claude alike.

## Branches: only the owner pushes `hardening`

`hardening` is protected on GitHub: **only dhanuvagman006 can push to it**
(no force-push, no delete). Everyone else works on their own branch and
opens a pull request; the owner reviews and merges.

1. Start from the latest: `git checkout hardening && git pull --rebase origin hardening`.
2. Make your branch: `git checkout -b <your-name>/<what-it-does>`
   (e.g. `allen/fix-reminder-time`).
3. Commit small, clear commits. Before **every** push, bring in the latest:
   `git pull --rebase origin hardening`, resolve conflicts, re-run the
   checks (below).
4. Push **your branch**: `git push -u origin <your-name>/<what-it-does>`.
   Never push to `hardening` — GitHub refuses it ("protected branch").
5. Open a pull request into `hardening`:
   `gh pr create --base hardening --fill` — say what changed and how you
   tested it. The owner merges it.
6. **Never force-push** a branch someone else also works on, and never
   rewrite commits already on GitHub. The `.githooks/pre-push` hook refuses
   a push that would drop commits already on the remote; `./setup.sh`
   switches it on. Do not bypass it with `--no-verify`.
7. Check `git config user.name` is YOUR name on your machine, so the
   history shows who did what (the shared Claude account does not).

Claude: never push to `hardening` unless the person at the keyboard is the
owner and asked for it; otherwise push a branch and open a PR.

## Pushing deploys

Every merge or push to `hardening` here **deploys the backend to the VPS**
(`.github/workflows/deploy.yml` → `~/app/deploy.sh` on the server) — one
more reason it goes through the owner's review. Branches do not deploy.
The flutter repo does not deploy.

## Secrets — both repos are PUBLIC

Never commit `.env`, `firebase-adminsdk.json`, `google-services.json`,
keystores, API keys or tokens. They live in the team Bitwarden vault and
`./setup.sh` writes them locally. If one is ever committed, tell the team:
it must be rotated, not just deleted.

## Checks before pushing

- `npm run test:manifest` (every test script points at a real file)
- `node scripts/manager-test.js` when touching `src/agents/manager.js` or tools
- The suites for what you changed, against a throwaway database:
  `DATABASE_URL=postgres://myassistant:localdev@localhost:5432/myassistant_test npm run test:<suite>`
- `npm run test:all` runs everything (CI does this on every push).

## Setup

`./setup.sh` (see SETUP.md) resets both repos to `origin/hardening` (commit
your branch's work first — uncommitted changes are backed up, then
discarded), writes
the secrets from Bitwarden and runs the backend and the app.
