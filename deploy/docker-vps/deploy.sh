#!/usr/bin/env bash
# DEPLOY ON THE PRODUCTION VPS (backend.envisionsit.in, 189.72.146.77).
#
# Lives at /opt/myassistant/deploy.sh. GitHub Actions runs it through a
# forced command in root's authorized_keys, so the deploy key can do
# nothing else and the server needs no GitHub or registry access.
#
# Two ways in (the ssh command line, $SSH_ORIGINAL_COMMAND, picks one):
#
#   deploy-image <git-sha>   stdin = `docker save myassistant-backend:<sha> | gzip`
#                            — the image CI built and tested. Preferred: the
#                            exact artifact that passed is what runs, and the
#                            server spends no CPU building.
#   deploy                   stdin = `git archive HEAD` (source tar); the
#                            image is built here. Kept as the fallback.
#
# Either way:
#   1. receive the new image (or source)
#   2. back up the database (pg_dump, newest 14 kept in backups/)
#   3. keep the running image as :previous — the rollback point
#   4. restart the backend on the new image
#   5. wait for /health/ready (database reachable); on ANY failure put the
#      previous image (and code) back
#
# Editing this copy does not change the server: copy it to
# /opt/myassistant/deploy.sh by hand (deploy/docker-vps/README.md).
set -euo pipefail
cd /opt/myassistant
chmod 600 .env pg.env monitoring/monitoring.env monitoring/metrics_token 2>/dev/null || true
exec 9>/opt/myassistant/.deploy.lock
flock -n 9 || { echo "another deploy is running" >&2; exit 1; }

# The monitoring stack rides along when it is installed.
export COMPOSE_FILE=compose.yml
[ -f monitoring/compose.monitoring.yml ] && COMPOSE_FILE="compose.yml:monitoring/compose.monitoring.yml"

say() { printf '\n--> %s\n' "$*"; }
IMG=myassistant-backend
read -r MODE SHA _ <<<"${SSH_ORIGINAL_COMMAND:-${1:-deploy} ${2:-}}"

case "$MODE" in
  deploy-image)
    [[ "$SHA" =~ ^[0-9a-f]{7,40}$ ]] || { echo "deploy-image needs a git sha" >&2; exit 2; }
    say "1/5 loading image $SHA"
    gunzip -c | docker load -q
    docker image inspect "$IMG:$SHA" >/dev/null || { echo "the upload did not contain $IMG:$SHA" >&2; exit 1; }
    ;;
  deploy)
    say "1/5 unpacking source"
    rm -rf src-new && mkdir src-new
    tar -x -C src-new
    [ -f src-new/package.json ] && [ -f src-new/Dockerfile ] || {
      echo "the upload is not the backend repo" >&2; rm -rf src-new; exit 1; }
    ;;
  *) echo "unknown command: $MODE (expected deploy-image <sha> | deploy)" >&2; exit 2 ;;
esac

say "2/5 database backup"
mkdir -p backups && chmod 700 backups
STAMP=$(date +%Y%m%d%H%M%S)
( umask 077; docker compose exec -T postgres pg_dump -U myassistant myassistant | gzip > "backups/predeploy-$STAMP.sql.gz" )
gzip -t "backups/predeploy-$STAMP.sql.gz"
ls -1t backups/predeploy-*.sql.gz | tail -n +15 | xargs -r rm -f
echo "backup: backups/predeploy-$STAMP.sql.gz ($(du -h "backups/predeploy-$STAMP.sql.gz" | cut -f1))"

say "3/5 keeping the running image as :previous"
docker image tag "$IMG:latest" "$IMG:previous"

rollback() {
  echo "!!! $1 — rolling back" >&2
  if [ "$MODE" = deploy ] && [ -d src-prev ]; then rm -rf src-repo && mv src-prev src-repo; fi
  docker image tag "$IMG:previous" "$IMG:latest"
  docker compose up -d --no-build --force-recreate backend
  exit 1
}

say "4/5 switching"
if [ "$MODE" = deploy-image ]; then
  docker image tag "$IMG:$SHA" "$IMG:latest"
else
  rm -rf src-prev && mv src-repo src-prev && mv src-new src-repo
  # Lowest CPU priority: the live backend keeps serving while this builds.
  nice -n 19 docker compose build -q backend || rollback "build failed"
fi
docker compose up -d --no-build --force-recreate backend || rollback "restart failed"
# Monitoring containers (if installed) are started or updated, never rebuilt.
[ "$COMPOSE_FILE" = compose.yml ] || docker compose up -d --no-build --no-recreate || true

say "5/5 health"
probe() {
  docker compose exec -T backend node -e \
    "fetch('http://localhost:3000/health/ready').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))" 2>/dev/null
}
for _ in $(seq 1 40); do
  if probe | grep -q '"ok":true'; then
    echo "healthy: $(probe)"
    # Keep :latest and :previous; drop older tagged builds and dangling layers.
    docker images "$IMG" --format '{{.Tag}}' | grep -vE '^(latest|previous)$' | xargs -r -I{} docker rmi -f "$IMG:{}" >/dev/null 2>&1 || true
    docker image prune -f >/dev/null
    exit 0
  fi
  sleep 3
done
docker compose logs backend --tail 30 >&2 || true
rollback "no healthy /health/ready within 120s"
