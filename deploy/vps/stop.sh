#!/usr/bin/env bash
# Stop the backend (and, with --all, Postgres too).
APP="$HOME/app"
if [ -f "$APP/supervisor.pid" ]; then
  kill -- "-$(cat "$APP/supervisor.pid")" 2>/dev/null && echo "backend stopped"
  rm -f "$APP/supervisor.pid"
fi
if [ "${1:-}" = "--all" ]; then
  "$HOME/opt/pg/usr/lib/postgresql/14/bin/pg_ctl" -D "$APP/pgdata" -w stop >/dev/null && echo "postgres stopped"
fi
