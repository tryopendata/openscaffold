#!/usr/bin/env bash
# `bun run dev:bg` / `bun run dev:stop`: the dev server for agents and scripts, which can't
# sit in a foreground terminal.
#
#   start  Reuse the dev server already running from this checkout (yours or someone
#          else's), or start scripts/dev.sh detached. Returns once /healthz answers, and
#          prints the URL. Exits 1 with the startup output if the server doesn't come up.
#   stop   Stop the dev server running from this checkout, however it was started (the same
#          as Ctrl-C in its terminal).
#
# Both find the server through logs/dev.pid, which scripts/dev.sh writes while it runs.
set -euo pipefail
cd "$(dirname "$0")/.."

pid="" port=""
# The pid file names a live scripts/dev.sh (not a stale pid reused by something else).
running() {
  [ -f logs/dev.pid ] && read -r pid port <logs/dev.pid &&
    ps -o command= -p "$pid" 2>/dev/null | grep -q "scripts/dev.sh"
}
healthy() { curl -sf -o /dev/null --max-time 5 "http://localhost:$port/healthz"; }

# logs/dev.pid names $pid: dev.sh writes it once it owns the port and logs/.
ours() { [ "$(cut -d' ' -f1 logs/dev.pid 2>/dev/null)" = "$pid" ]; }

# wait_healthy <seconds>: poll /healthz while the server process lives. Only once the pid file
# is ours, so a server on the same port from another checkout can't pass for this one.
wait_healthy() {
  local i
  for ((i = 0; i < $1 * 2; i++)); do
    kill -0 "$pid" 2>/dev/null || return 1
    ours && healthy && return 0
    sleep 0.5
  done
  return 1
}

ready() {
  echo "Dev server running: http://localhost:$port (pid $pid)"
  echo "Logs: logs/server.jsonl (JSON lines), logs/dev.log (terminal). Stop: bun run dev:stop"
}

start() {
  if running; then
    if wait_healthy 60; then
      ready
      return 0
    fi
    echo "A dev server is running (pid $pid, port $port) but /healthz doesn't answer. Last lines of logs/dev.log:" >&2
    tail -n 30 logs/dev.log >&2 2>/dev/null || true
    return 1
  fi
  port="${PORT_WEB:-5173}"
  # The terminal copy lands in logs/dev.log; this file keeps only dev.sh's own complaints
  # (a refusal to start), overwritten on every start.
  mkdir -p logs
  local out=logs/dev-bg.err
  : >"$out"
  # Job control gives the server its own process group, so `stop` can signal all of it.
  set -m
  nohup bash scripts/dev.sh >/dev/null 2>"$out" &
  pid=$!
  set +m
  if wait_healthy 90; then
    ready
    return 0
  fi
  echo "The dev server didn't come up on port $port. Its output:" >&2
  cat "$out" >&2
  # Only this attempt's log: dev.sh exits before writing one when it refuses to start.
  if [ logs/dev.log -nt "$out" ]; then tail -n 30 logs/dev.log >&2; fi
  kill -0 "$pid" 2>/dev/null && stop >/dev/null
  return 1
}

stop() {
  if ! running; then
    echo "No dev server is running from this checkout."
    return 0
  fi
  local pgid own i
  pgid=$(ps -o pgid= -p "$pid" | tr -d ' ')
  own=$(ps -o pgid= -p $$ | tr -d ' ')
  # SIGINT, like Ctrl-C: dev.sh lets the server shut down and finish writing logs/dev.log.
  if [ -n "$pgid" ] && [ "$pgid" != "$own" ]; then kill -INT -- "-$pgid"; else kill -INT "$pid"; fi
  for ((i = 0; i < 20; i++)); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    if [ -n "$pgid" ] && [ "$pgid" != "$own" ]; then kill -TERM -- "-$pgid"; else kill -TERM "$pid"; fi
    for ((i = 0; i < 10; i++)); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
  fi
  if kill -0 "$pid" 2>/dev/null; then
    echo "The dev server (pid $pid, process group $pgid) didn't exit; port $port may still be taken." >&2
    return 1
  fi
  echo "Stopped the dev server on port $port (pid $pid)."
}

case "${1:-}" in
start) start ;;
stop) stop ;;
*)
  echo "usage: $0 start|stop" >&2
  exit 2
  ;;
esac
