#!/usr/bin/env bash
# PreToolUse (Bash): deny commands that destroy work or data without a way back
# (rm of /, ~ or ., git reset --hard, force push, DROP TABLE, publishing...).
# The patterns live in _destructive-patterns.sh.
#
# A deny is returned as JSON with exit 0, which the hooks contract honors, and
# the reason is shown to the agent so it can ask the user instead. Commands that
# don't match produce no output, and the normal permission flow applies.
#
# The worst of these are also listed under permissions.deny in settings.json, so
# they stay blocked on a machine without jq, where this hook is a no-op.
set -euo pipefail

hook_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=_lib.sh
source "$hook_dir/_lib.sh"
# shellcheck source=_destructive-patterns.sh
source "$hook_dir/_destructive-patterns.sh"

hook_require_jq

input=$(cat)
command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -z "$command" ] && exit 0

found=$(is_destructive "$command") || exit 0

reason=${found%%$'\t'*}
suggestion=${found#*$'\t'}

jq -n --arg reason "BLOCKED: $reason"$'\n\n'"$suggestion" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
exit 0
