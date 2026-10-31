#!/usr/bin/env bash
# Keeps the backend running: restarts it when it exits, with a short
# pause so a crash loop does not spin. Started by start.sh.
APP="$HOME/app"
LOG="$APP/backend.log"
export PATH="$HOME/opt/node22/bin:$PATH"
# This host has no working IPv6 route: an IPv6-first connection to OpenAI
# stalled ~7 s before falling back (measured 2026-10-31). IPv4 first.
export NODE_OPTIONS="--dns-result-order=ipv4first"
cd "$APP/myassistant-backend" || exit 1
trap 'kill "$child" 2>/dev/null; exit 0' TERM INT
while true; do
  # keep the log under ~50 MB
  if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 52428800 ]; then mv "$LOG" "$LOG.1"; fi
  echo "=== $(date '+%F %T') starting backend" >> "$LOG"
  node src/server.js >> "$LOG" 2>&1 &
  child=$!
  wait "$child"; code=$?
  echo "=== $(date '+%F %T') backend exited ($code) — restarting in 5s" >> "$LOG"
  sleep 5
done
