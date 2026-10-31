#!/usr/bin/env bash
# Start (or confirm running) Postgres + the MyAssistant backend.
# Safe to run any number of times. Cron is not allowed on this host, so
# after a server reboot run this by hand:  ~/app/start.sh
set -euo pipefail
APP="$HOME/app"
PGBIN="$HOME/opt/pg/usr/lib/postgresql/14/bin"
export PATH="$HOME/opt/node22/bin:$PATH"

if ! "$PGBIN/pg_ctl" -D "$APP/pgdata" status >/dev/null 2>&1; then
  "$PGBIN/pg_ctl" -D "$APP/pgdata" -l "$APP/pgdata/server.log" -w start >/dev/null
  echo "postgres started"
else
  echo "postgres already running"
fi

if [ -f "$APP/supervisor.pid" ] && kill -0 "$(cat "$APP/supervisor.pid")" 2>/dev/null; then
  echo "backend already running (supervisor pid $(cat "$APP/supervisor.pid"))"
else
  setsid nohup "$APP/supervise.sh" </dev/null >/dev/null 2>&1 &
  echo $! > "$APP/supervisor.pid"
  echo "backend started (supervisor pid $!)"
fi
