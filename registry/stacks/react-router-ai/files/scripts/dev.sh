#!/usr/bin/env bash
# `bun run dev`: the dev server, with everything it prints (Vite, React Router, SSR errors,
# app logs) also saved to logs/dev.log with colors stripped. The app separately writes
# structured JSON lines to logs/server.jsonl. Each start moves the previous run's files
# to logs/*.prev.* so a crash before a restart is still there to read.
set -euo pipefail
cd "$(dirname "$0")/.."

port="${PORT_WEB:-5173}"

# Check before rotating, so a second `bun run dev` (on any port) can't move a running
# server's logs away. logs/dev.pid holds "<pid> <port>" while a server from this checkout runs.
if [ -f logs/dev.pid ] && read -r other_pid other_port <logs/dev.pid &&
  ps -o command= -p "$other_pid" 2>/dev/null | grep -q "scripts/dev.sh"; then
  echo "A dev server from this checkout is already running on port $other_port (pid $other_pid). Its logs are in logs/; stop it with bun run dev:stop." >&2
  exit 1
fi
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $port is already in use by another process. Pick another with PORT_WEB=<port>." >&2
  exit 1
fi

mkdir -p logs
[ -f logs/dev.log ] && mv logs/dev.log logs/dev.prev.log
[ -f logs/server.jsonl ] && mv logs/server.jsonl logs/server.prev.jsonl
echo "$$ $port" >logs/dev.pid
# On any exit, take the rest of the process group (the server, perl) down too, so a `kill` of
# this script alone can't leave Vite holding the port with no pid file pointing at it.
trap 'rm -f logs/dev.pid; trap - TERM; kill -TERM 0 2>/dev/null' EXIT

# stdout becomes a pipe below, so keep colors on for the terminal (unless NO_COLOR is set).
if [ -z "${NO_COLOR:-}" ]; then export FORCE_COLOR="${FORCE_COLOR:-1}"; fi

printf '  \033[2mLogs: logs/dev.log (this terminal), logs/server.jsonl (JSON lines)\033[0m\n'

# perl prints each line through unchanged and appends a plain copy to logs/dev.log. On
# Ctrl-C it keeps copying the server's shutdown output, for at most 5 seconds.
bun run dev:server --port "$port" --strictPort 2>&1 | perl -ne '
  BEGIN {
    $SIG{INT} = sub { $SIG{ALRM} = sub { exit 0 }; alarm 5 };
    $| = 1;
    open(LOG, ">>", "logs/dev.log") or die "logs/dev.log: $!";
    select((select(LOG), $| = 1)[0]);
  }
  print;
  s/\e\[[0-9;?]*[ -\/]*[@-~]//g;
  tr/\r//d;
  print LOG;
'
