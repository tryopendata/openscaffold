#!/usr/bin/env bash
# PostToolUse (Edit|Write) on a .ts/.tsx file: type-check the project and hand any errors
# back to the agent as additionalContext, so a type error shows up right after the edit
# that caused it instead of at `bun run typecheck` time.
#
# Advisory: never blocks. tsc runs incrementally (build info under node_modules/.cache/),
# about 1.5s after the first run. Writing a route module or app/routes.ts (or any file before
# the first typegen) runs React Router typegen first, so `./+types/<route>` exists. Errors in
# the written file come first; errors elsewhere are included because an edit can break the
# files that use it.
# tsc not installed, timed out, or crashed: exit 0 with no output.
#
# Self-contained on purpose: it works whether or not the agent-ops hooks are
# present. Needs jq; without it, it drains stdin and exits 0.
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  cat >/dev/null 2>&1 || true
  exit 0
fi

# with_timeout <seconds> <cmd>...: run cmd, killing it after <seconds> (macOS has no
# coreutils `timeout`). Output goes through a temp file so a killed command can't leave
# a grandchild holding the caller's pipe open. Returns 124 on timeout.
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
  [ "$rc" -eq 137 ] && return 124
  return "$rc"
}

# Drop ANSI escapes and other control bytes that would make the jq payload unreadable.
strip_control() {
  sed -e $'s/\x1b\\[[0-9;]*[A-Za-z]//g' | tr -d '\000-\010\013\014\016-\037'
}

input=$(cat)
file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null) || exit 0
case "$file_path" in *.ts | *.tsx) ;; *) exit 0 ;; esac
[ -f "$file_path" ] || exit 0

root=${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}
root=$(cd "$root" && pwd -P) || exit 0
file_dir=$(cd "$(dirname "$file_path")" && pwd -P) || exit 0
case "$file_dir/" in "$root"/*) ;; *) exit 0 ;; esac
# tsc prints paths relative to the root; match that (a root-level file has no directory part).
if [ "$file_dir" = "$root" ]; then
  rel=$(basename "$file_path")
else
  rel="${file_dir#"$root"/}/$(basename "$file_path")"
fi
case "$rel" in node_modules/* | .react-router/* | build/*) exit 0 ;; esac

tsc="$root/node_modules/.bin/tsc"
[ -x "$tsc" ] || exit 0
cd "$root"

# Route types come from typegen: refresh them when routes change, and generate them on a fresh
# clone, where every route would otherwise report a missing `./+types/<route>`.
if [ -x node_modules/.bin/react-router ]; then
  case "$rel" in
  app/routes.ts | app/routes/*) typegen=true ;;
  *) [ -d .react-router/types ] && typegen=false || typegen=true ;;
  esac
  if [ "$typegen" = true ]; then
    with_timeout 15 node_modules/.bin/react-router typegen >/dev/null 2>&1 || true
  fi
fi

rc=0
out=$(with_timeout 40 "$tsc" --noEmit --pretty false --incremental \
  --tsBuildInfoFile node_modules/.cache/tsc/hook.tsbuildinfo) || rc=$?
# 0: clean. 1/2: type errors. Anything else (timeout 124, a crash): say nothing.
[ "$rc" -eq 1 ] || [ "$rc" -eq 2 ] || exit 0
out=$(printf '%s' "$out" | strip_control)

# An error is a `path(line,col): error TS...` line plus indented continuation lines.
# Put this file's errors first.
mine=$(printf '%s\n' "$out" | awk -v f="$rel(" '
  /^[^ ].*\([0-9]+,[0-9]+\): error / { keep = (index($0, f) == 1) }
  keep')
others=$(printf '%s\n' "$out" | awk -v f="$rel(" '
  /^[^ ].*\([0-9]+,[0-9]+\): error / { keep = (index($0, f) != 1) }
  keep')
total=$(grep -cE '^[^ ].*\([0-9]+,[0-9]+\): error ' <<<"$out" || true)
here=$(grep -cE '^[^ ].*\([0-9]+,[0-9]+\): error ' <<<"$mine" || true)
[ "$total" -gt 0 ] || exit 0

body=$(printf '%s\n' "$mine" | sed '/^$/d')
[ -n "$others" ] && body=$(printf '%s\n%s' "$body" "$others" | sed '/^$/d')
max_lines=40
if [ "$(wc -l <<<"$body" | tr -d ' ')" -gt "$max_lines" ]; then
  body="$(head -n "$max_lines" <<<"$body")"$'\n'"... (truncated; run bun run typecheck for the rest)"
fi

if [ "$here" -gt 0 ]; then
  msg="tsc found $total type error(s), $here in $rel. Fix the ones in this file now; errors in other files may be from an edit still in progress:"
else
  msg="tsc found $total type error(s) in other files (none in $rel). Either an edit is still in progress, or this edit broke code that uses it:"
fi
jq -n --arg ctx "$msg"$'\n'"$body" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $ctx
  }
}'
exit 0
