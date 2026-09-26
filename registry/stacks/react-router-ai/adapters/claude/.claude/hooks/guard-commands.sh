#!/usr/bin/env bash
# PreToolUse (Bash): deny commands that are wrong for this stack, with the fix.
#
#   --bun on vitest / react-router / vite   they run on Node here; --bun swaps in
#                                           bun's runtime and breaks them subtly
#   bun test                                bun's own test runner; the tests are
#                                           vitest (bun run test)
#   installing @effect/schema               folded into `effect`; the old package
#                                           conflicts with it
#
# Self-contained on purpose: it works whether or not the agent-ops hooks are
# present. Needs jq; without it, it drains stdin and exits 0.
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  cat >/dev/null 2>&1 || true
  exit 0
fi

cmd=$(jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -z "$cmd" ] && exit 0

reason=""
if grep -qE -e '(^|[[:space:];&|])bunx?[[:space:]]+(run[[:space:]]+)?--bun([[:space:]]|$)' <<<"$cmd" &&
  grep -qE -e '(vitest|react-router|vite)([[:space:]]|$)|(run[[:space:]]+--bun|--bun[[:space:]]+run)[[:space:]]+(dev|dev:server|build|test|test:watch|coverage|e2e|typecheck|start|check)' <<<"$cmd"; then
  reason="vitest, Vite, and React Router run on Node in this project. Drop --bun (use bun run test / bun run dev / bun run build)."
elif grep -qE -e '(^|[[:space:];&|])bun[[:space:]]+test([[:space:]]|$)' <<<"$cmd"; then
  reason="bun test is bun's own test runner; the tests here are vitest. Use bun run test (add a file path or -t \"<name>\" to scope it)."
elif grep -qE -e '(bun|npm|pnpm|yarn)[[:space:]]+(add|install|i)[[:space:]].*@effect/schema' <<<"$cmd"; then
  reason="@effect/schema was folded into effect. Import Schema from \"effect\" instead of installing it."
fi
[ -z "$reason" ] && exit 0

jq -n --arg r "BLOCKED: $reason" \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'
