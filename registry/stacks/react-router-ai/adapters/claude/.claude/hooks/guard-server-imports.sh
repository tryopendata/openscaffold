#!/usr/bin/env bash
# PreToolUse (Edit|Write): deny client-side modules that import server-only code.
#
# Anything under app/.server/ (or named *.server.ts[x]) must never reach the
# browser bundle. Route modules and root.tsx may import it (React Router strips
# loader/action-only imports from the client build), but components, hooks,
# client libs, and shared schemas may not: the build fails, or worse, a secret
# ends up in the bundle. Schemas stay importable from both sides, so they can't
# depend on server code either.
#
# Self-contained on purpose: it works whether or not the agent-ops hooks are
# present. Needs jq; without it, it drains stdin and exits 0.
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  cat >/dev/null 2>&1 || true
  exit 0
fi

input=$(cat)
file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null) || exit 0
[ -z "$file_path" ] && exit 0

case "$file_path" in
*/app/components/*.ts | */app/components/*.tsx | */app/hooks/*.ts | */app/hooks/*.tsx | \
  */app/lib/*.ts | */app/lib/*.tsx | */app/schemas/*.ts) ;;
*) exit 0 ;;
esac
# Server-only files may live under those dirs by name; they're allowed.
case "$file_path" in
*.server.ts | *.server.tsx | */.server/*) exit 0 ;;
esac

text=$(printf '%s' "$input" | jq -r '
  [ .tool_input.content?, .tool_input.new_string?, (.tool_input.edits[]?.new_string?) ]
  | map(select(type == "string")) | join("\n")' 2>/dev/null) || exit 0
[ -z "$text" ] && exit 0

# import/export ... from "<spec>" or import("<spec>") where spec points into .server/
# or at a *.server module.
pattern='(from|import)[[:space:]]*\(?[[:space:]]*["'"'"'][^"'"'"']*(/\.server(/|["'"'"'])|\.server["'"'"'])'
if grep -qE -e "$pattern" <<<"$text"; then
  jq -n --arg r "BLOCKED: $file_path is client-side code and imports server-only code (app/.server/ or a *.server module). Move the logic behind a loader, action, or resource route and pass the data down, or put shared types in app/schemas/." \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'
fi
