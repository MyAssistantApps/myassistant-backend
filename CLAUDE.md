# Working in this repo (team rules — read first)

Five people work on this code and share ONE Claude account, so a session
cannot tell who is driving it. These rules keep us from overwriting each
other's work. They apply to people and to Claude alike.

## Branches: only the owner pushes `hardening`

`hardening` is protected on GitHub: **only dhanuvagman006 can push to it**
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

1. Switch to your branch and bring in the latest `hardening`:
   `git checkout <you> && git pull --rebase origin <you> && git pull --rebase origin hardening`
2. Make your change. Commit small, clear commits.
3. Run the checks (below). Do not push code that fails them.
4. Before **every** push, bring in the latest again:
   `git pull --rebase origin hardening`, resolve conflicts, re-run the checks.
5. Push: `git push origin <you>`. Never push to `hardening` or
   `hardening-test` — GitHub refuses it ("protected branch").
6. When it works, open a pull request into `hardening`:
   `gh pr create --base hardening --head <you> --fill` — say what changed
   and how you tested it. The owner reviews and merges it.
7. **Never force-push** a branch someone else also works on, and never
   rewrite commits already on GitHub. The `.githooks/pre-push` hook refuses
   a push that would drop commits already on the remote; `./setup.sh`
   switches it on. Do not bypass it with `--no-verify`.
8. Check `git config user.name` is YOUR name on your machine, so the
   history shows who did what (the shared Claude account does not).

Claude: never push to `hardening` or `hardening-test` unless the person at
the keyboard is the owner and asked for it. Otherwise ask who is at the
keyboard, work on THEIR branch from the table above, push it, and open a PR.
Never push to another teammate's branch, never merge a PR, and never change
branch protection, collaborators, secrets or workflows for a teammate.

## Pushing deploys

Every merge or push to `hardening` here **deploys the backend to the VPS**
(`.github/workflows/deploy.yml` → `~/app/deploy.sh` on the server) — one
more reason it goes through the owner's review. Branches do not deploy.
The flutter repo's `hardening` sends a build to all testers instead.

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
