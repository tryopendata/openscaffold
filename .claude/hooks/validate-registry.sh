#!/usr/bin/env bash
# PostToolUse (Edit|Write): after a write under registry/, run
# `openscaffold validate registry` from source and hand any errors or warnings
# back to the agent as additionalContext. lint-on-write.sh skips registry/
# (biome ignores it, and most of it is markdown), so this is the only on-write
# check for STACK.md / FRAGMENT.md frontmatter, conditional blocks, .tmpl
# variables, ownership conflicts, and version-sensitive files.
#
# Advisory: never blocks. Validating the whole registry takes ~0.1s, and it has
# to be the whole registry, since composition errors span entries. Silent when
# bun is missing, the CLI crashes (src/ mid-edit), or the output isn't JSON.
set -euo pipefail

hook_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=_lib.sh
source "$hook_dir/_lib.sh"

hook_require_jq

input=$(cat)
file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null) || exit 0
[ -n "$file_path" ] || exit 0

root=$(project_root)
root=$(cd "$root" && pwd -P) || exit 0
# The file may have been deleted or renamed; resolve its directory if it exists.
if [ -d "$(dirname "$file_path")" ]; then
  file_path="$(cd "$(dirname "$file_path")" && pwd -P)/$(basename "$file_path")"
fi
case "$file_path" in
"$root"/registry/*) ;;
*) exit 0 ;;
esac

command -v bun >/dev/null 2>&1 || exit 0
[ -f "$root/src/cli.ts" ] || exit 0

rc=0
out=$(cd "$root" && with_timeout 20 bun src/cli.ts validate registry --json) || rc=$?
# 0 = clean or warnings only, 1 = errors. Anything else is a crash or timeout.
[ "$rc" -le 1 ] || exit 0

findings=$(printf '%s' "$out" | jq -r '
  if (.errors | type) == "array" and (.warnings | type) == "array" then
    ([.errors[] | "error: registry/\(.file): \(.message)"] + [.warnings[] | "warning: registry/\(.file): \(.message)"])
    | join("\n")
  else empty end' 2>/dev/null) || exit 0
[ -n "$findings" ] || exit 0

jq -n --arg ctx "openscaffold validate registry reported problems after this write. Fix them before moving on:"$'\n'"$findings" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $ctx
  }
}'
exit 0
