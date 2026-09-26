#!/usr/bin/env bash
# SessionStart: when a dev server from this checkout is already running (scripts/dev.sh
# writes "<pid> <port>" to logs/dev.pid), say so, so the agent reuses it instead of
# starting another, and count the warn/error lines already in its log.
#
# Self-contained on purpose: it works whether or not the agent-ops hooks are present.
# Needs jq to build its output; without it, it exits 0 quietly.
set -euo pipefail

cat >/dev/null 2>&1 || true
command -v jq >/dev/null 2>&1 || exit 0

root=${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}
cd "$root" 2>/dev/null || exit 0

[ -f logs/dev.pid ] || exit 0
read -r dev_pid dev_port <logs/dev.pid || exit 0
[ -n "${dev_pid:-}" ] && [ -n "${dev_port:-}" ] || exit 0
ps -o command= -p "$dev_pid" 2>/dev/null | grep -q "scripts/dev.sh" || exit 0

problems=$(grep -cE '"level":"(warn|error|fatal)"' logs/server.jsonl 2>/dev/null || true)
note="A dev server is running at http://localhost:$dev_port (pid $dev_pid); use it rather than starting another."
if [ "${problems:-0}" -gt 0 ]; then
  note="$note logs/server.jsonl has $problems warn/error line(s) from this run: jq -c 'select(.level == \"warn\" or .level == \"error\" or .level == \"fatal\")' logs/server.jsonl"
fi

jq -n --arg ctx "$note" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $ctx
  }
}'
exit 0
