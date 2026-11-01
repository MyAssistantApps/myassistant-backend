#!/usr/bin/env bash
# Update the backend to the latest origin/hardening and restart it.
set -euo pipefail
APP="$HOME/app"
export PATH="$HOME/opt/node22/bin:$PATH"
cd "$APP/myassistant-backend"
git fetch -q origin
git reset -q --hard origin/hardening
echo "now at $(git log --oneline -1)"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
node scripts/check-prod-flags.js || true
"$APP/stop.sh"
"$APP/start.sh"
for _ in $(seq 1 30); do
  if curl -fsS -m 3 "http://127.0.0.1:38231/health" 2>/dev/null | grep -q '"ok":true'; then echo "healthy"; exit 0; fi
  sleep 2
done
echo "NOT healthy — see $APP/backend.log" >&2; tail -20 "$APP/backend.log" >&2; exit 1
