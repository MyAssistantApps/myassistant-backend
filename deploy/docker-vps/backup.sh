#!/usr/bin/env bash
# NIGHTLY POSTGRES BACKUP on the production VPS (backend.envisionsit.in).
#
# Lives at /opt/myassistant/backup.sh and runs from root's crontab:
#   0 21 * * * /opt/myassistant/backup.sh >> /opt/myassistant/backups/nightly.log 2>&1
# (21:00 UTC = 02:30 IST.)
#
# The dump must gunzip cleanly and end with pg_dump's completion marker
# before anything is rotated, so a run of bad dumps never pushes the good
# ones out. Nightly dumps rotate only among themselves (newest 14); the
# predeploy-* dumps written by deploy.sh are rotated by deploy.sh.
#
# LIMIT: the backups sit on the same disk as the data. They cover a bad
# deploy or a mistaken DELETE, not the loss of the server. An off-server
# copy is still to be added at the marked line.
#
# Editing this copy does not change the server: copy it to
# /opt/myassistant/backup.sh by hand (deploy/docker-vps/README.md).
set -euo pipefail
cd /opt/myassistant
export COMPOSE_FILE=compose.yml
umask 077
mkdir -p backups && chmod 700 backups

TS=$(date +%Y%m%d-%H%M%S)
OUT="backups/nightly-$TS.sql.gz"
trap 'rm -f "$OUT.partial"' EXIT # a failed dump leaves nothing behind

docker compose exec -T postgres pg_dump -U myassistant myassistant | gzip > "$OUT.partial"
gzip -t "$OUT.partial"
if ! zcat "$OUT.partial" | tail -c 2000 | grep -q "PostgreSQL database dump complete"; then
  echo "$(date -u +%FT%TZ) backup INCOMPLETE; previous backups left untouched" >&2
  exit 1
fi
mv "$OUT.partial" "$OUT"
# ---- off-server copy goes here (rclone / aws s3 cp) ----
ls -1t backups/nightly-*.sql.gz | tail -n +15 | xargs -r rm -f --
echo "$(date -u +%FT%TZ) backup done: $(basename "$OUT") ($(ls backups/nightly-*.sql.gz | wc -l) kept)"
