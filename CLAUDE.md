# Working in this repo (team rules — read first)

Five people work on this code and share ONE Claude account, so a session
cannot tell who is driving it. These rules keep us from overwriting each
other's work. They apply to people and to Claude alike.

## Before you start, and before every push

1. `git pull --rebase origin hardening` before starting any task.
2. Before **every** push, pull again: `git pull --rebase origin hardening`.
   Resolve any conflicts, re-run the tests (below), then push.
3. **Never force-push** (`--force`, `--force-with-lease`, `+ref`) to
   `hardening` or `main`, and never rewrite commits that are already on
   GitHub. The `.githooks/pre-push` hook refuses a push that would drop a
   teammate's commits; `./setup.sh` switches it on
   (`git config core.hooksPath .githooks`). Do not bypass it with `--no-verify`.
4. Work on `hardening`. Keep commits small and say what changed and why.
5. Check `git config user.name` is YOUR name on your machine, so the
   history shows who did what (the Claude account does not).

## Pushing deploys

A push to `hardening` here **deploys the backend to the VPS**
(`.github/workflows/deploy.yml` → `~/app/deploy.sh` on the server). Only
push code that passed the checks below. The flutter repo does not deploy.

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

`./setup.sh` (see SETUP.md) resets both repos to `origin/hardening`, writes
the secrets from Bitwarden and runs the backend and the app.
