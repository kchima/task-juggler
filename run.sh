#!/usr/bin/env bash
# Task Juggler auto-updating local server.
#
# Loops: pull the latest code from origin (fast-forward only), start the server,
# and when it exits (crash/restart/update) pull again and restart. This gives a
# self-updating, self-healing local instance.
#
# Usage:
#   ./run.sh            # production-ish loop (npm start)
#   ./run.sh --dev      # use node --watch so local edits also hot-restart
#
# Env overrides: TASK_JUGGLER_PORT, TASK_JUGGLER_DB, OPENROUTER_API_KEY, ...

set -u

cd "$(dirname "$0")"

# Optional local env file (e.g. OPENROUTER_API_KEY / ANTHROPIC_API_KEY /
# DEVIN_API_KEY) so keys don't have to be re-exported each launch.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

DEV=0
if [ "${1:-}" = "--dev" ]; then
  DEV=1
fi

LOG_DIR="${TASK_JUGGLER_LOG_DIR:-$HOME/.local/state/task-juggler}"
mkdir -p "$LOG_DIR"

RUN_CMD=(npm start)
if [ "$DEV" = "1" ]; then
  RUN_CMD=(npm run dev)
fi

# Track our own PID so the loop can be stopped cleanly (kill the parent).
echo "task-juggler launcher pid $$"

while true; do
  echo ""
  echo "[run] $(date '+%F %T') pulling latest code…"

  if git pull --ff-only --no-rebase >/dev/null 2>&1; then
    echo "[run] pulled latest (or already current)."
  else
    # Local uncommitted changes or offline — keep serving existing code rather
    # than ever breaking the running instance.
    echo "[run] pull skipped (uncommitted changes, conflict, or offline)."
  fi

  echo "[run] starting server…"
  "${RUN_CMD[@]}"
  code=$?
  echo "[run] server exited with code $code. Restarting in 3s…"
  sleep 3
done
