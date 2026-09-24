# shellcheck shell=bash
# Shared helpers for the hooks in this directory. Sourced, never executed:
#   source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
#
# Written for bash 3.2 (the macOS default) under `set -euo pipefail`.

# Every hook that parses its JSON payload needs jq. Without it the hook drains
# stdin and exits 0, so a machine missing jq loses the hooks instead of failing
# every tool call. session-start.sh says so once per session.
hook_require_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    cat >/dev/null 2>&1 || true
    exit 0
  fi
}

# The project root: $CLAUDE_PROJECT_DIR when Claude Code set it (it always does
# for hooks), else the git top level of the current directory, else $PWD.
project_root() {
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "${CLAUDE_PROJECT_DIR}" ]; then
    printf '%s\n' "$CLAUDE_PROJECT_DIR"
    return 0
  fi
  git rev-parse --show-toplevel 2>/dev/null || printf '%s\n' "$PWD"
}

# find_up <start-dir> <name>...: print the nearest directory, walking up from
# start-dir, that contains any of the names (a name may be a relative path such
# as node_modules/.bin/biome). Returns 1 when nothing matches.
find_up() {
  local dir=$1
  shift
  local name
  while :; do
    for name in "$@"; do
      if [ -e "$dir/$name" ]; then
        printf '%s\n' "$dir"
        return 0
      fi
    done
    if [ "$dir" = "/" ] || [ -z "$dir" ]; then
      return 1
    fi
    dir=$(dirname "$dir")
  done
}

# with_timeout <seconds> <cmd>...: run cmd, killing it after <seconds>. macOS
# ships no coreutils `timeout`, so race the command against a sleeper.
#
# Output goes through a temp file rather than straight to stdout: if the command
# spawns a grandchild (bunx, npx, uv), killing the child would leave the
# grandchild holding a command-substitution pipe open and the caller would block
# anyway. The sleeper's own output is sent to /dev/null for the same reason.
#
# Prints the captured stdout+stderr. Returns 124 on timeout, else the command's
# exit status.
with_timeout() {
  local secs=$1
  shift
  local tmp
  tmp=$(mktemp "${TMPDIR:-/tmp}/claude-hook.XXXXXX") || return 1

  "$@" >"$tmp" 2>&1 </dev/null &
  local pid=$!
  (sleep "$secs" && kill -9 "$pid") >/dev/null 2>&1 </dev/null &
  local killer=$!

  local rc=0
  wait "$pid" 2>/dev/null || rc=$?
  kill "$killer" 2>/dev/null || true
  wait "$killer" 2>/dev/null || true

  cat "$tmp"
  rm -f "$tmp"
  # 137 = SIGKILL, i.e. the sleeper won the race.
  [ "$rc" -eq 137 ] && return 124
  return "$rc"
}

# session_file_list <payload-json>: print the path of this session's list of
# written files, creating its directory. The list lives outside the repo, keyed
# by the payload's session_id reduced to [A-Za-z0-9_-] so it can't name a path
# elsewhere. Returns 1 when the payload has no usable session_id.
session_file_list() {
  local id dir
  id=$(printf '%s' "$1" | jq -r '.session_id // empty' 2>/dev/null) || return 1
  id=$(printf '%s' "$id" | tr -cd 'A-Za-z0-9_-')
  [ -n "$id" ] || return 1
  dir="${TMPDIR:-/tmp}"
  dir="${dir%/}/openscaffold-hooks"
  mkdir -p "$dir" 2>/dev/null || return 1
  printf '%s/%s.files\n' "$dir" "$id"
}

# strip_control: drop ANSI escapes and other control bytes that would make a jq
# payload unreadable, keeping tabs and newlines.
strip_control() {
  sed -e $'s/\x1b\\[[0-9;]*[A-Za-z]//g' | tr -d '\000-\010\013\014\016-\037'
}
