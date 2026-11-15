#!/usr/bin/env bash
# DEPLOY ON THE PRODUCTION VPS (backend.envisionsit.in, 189.72.146.77).
#
# Lives at /opt/myassistant/deploy.sh on the server. GitHub Actions runs it
# through a forced command in root's authorized_keys, sending the commit as
# a tar on stdin (`git archive HEAD | ssh root@… deploy`) — so the server
# needs no GitHub access and the deploy key can do nothing else.
#
#   1. unpack the new code next to the running code
#   2. back up the database (pg_dump, newest 14 kept in backups/)
#   3. keep the running image as :previous — the rollback point
#   4. build, restart the backend, poll /health
#   5. on ANY failure after the swap, put the previous code and image back
#
# Editing this copy does not change the server: copy it to
# /opt/myassistant/deploy.sh by hand.
set -euo pipefail
cd /opt/myassistant
# Backups hold every user's data; the secrets files hold every key: owner
# only (2026-11-15). Not a global umask — the unpacked source must stay
# readable to the container's non-root user.
# (firebase-adminsdk.json is NOT here: it is bind-mounted and read by the
# container's `node` user — restrict it with `chown root:1000; chmod 640`.)
chmod 600 .env pg.env 2>/dev/null || true
exec 9>/opt/myassistant/.deploy.lock
flock -n 9 || { echo "another deploy is running" >&2; exit 1; }

say() { printf '\n--> %s\n' "$*"; }
IMG=myassistant-backend

say "1/5 unpacking"
rm -rf src-new && mkdir src-new
tar -x -C src-new
[ -f src-new/package.json ] && [ -f src-new/Dockerfile ] || {
  echo "the upload is not the backend repo" >&2; rm -rf src-new; exit 1; }

say "2/5 database backup"
mkdir -p backups && chmod 700 backups
STAMP=$(date +%Y%m%d%H%M%S)
( umask 077; docker compose exec -T postgres pg_dump -U myassistant myassistant | gzip > "backups/predeploy-$STAMP.sql.gz" )
gzip -t "backups/predeploy-$STAMP.sql.gz"
ls -1t backups/*.sql.gz | tail -n +15 | xargs -r rm -f
echo "backup: backups/predeploy-$STAMP.sql.gz ($(du -h "backups/predeploy-$STAMP.sql.gz" | cut -f1))"

say "3/5 keeping the running image as :previous"
docker image tag "$IMG:latest" "$IMG:previous"

rollback() {
  echo "!!! $1 — rolling back" >&2
  rm -rf src-repo && mv src-prev src-repo
  docker image tag "$IMG:previous" "$IMG:latest"
  docker compose up -d --no-build --force-recreate backend
  exit 1
}

say "4/5 building"
rm -rf src-prev && mv src-repo src-prev && mv src-new src-repo
docker compose build -q backend || rollback "build failed"
docker compose up -d --no-build --force-recreate backend || rollback "restart failed"

say "5/5 health"
for _ in $(seq 1 40); do
  # Straight to the container (Caddy's :80 now redirects to HTTPS except
  # /health); the old probe through Caddy stays as the fallback.
  if docker compose exec -T backend node -e "fetch('http://localhost:3000/health').then(r=>r.text()).then(t=>{process.stdout.write(t)}).catch(()=>process.exit(1))" 2>/dev/null | grep -q '"ok":true'      || curl -fsS -m 5 http://127.0.0.1/health 2>/dev/null | grep -q '"ok":true'; then
    echo "healthy"
    docker image prune -f >/dev/null
    exit 0
  fi
  sleep 3
done
docker compose logs backend --tail 30 >&2 || true
rollback "no healthy /health within 120s"
