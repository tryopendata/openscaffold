#!/usr/bin/env bash
# PostToolUse (Edit|Write): lint the file that was just written and hand any
# diagnostics back to the agent as additionalContext, so it fixes them now
# instead of finding out at `make lint` time or in CI.
#
# Advisory and read-only: never blocks, never rewrites the file (format-changed.sh
# formats at the end of the turn). The linter is picked by file extension and
# only runs when it is installed for this project:
#
#   *.py              ruff (project .venv first, then PATH)
#   *.ts *.tsx *.js…  biome if a biome config is present, else eslint if an
#                     eslint config is present (project node_modules first)
#   *.json *.css      biome, when configured
#   *.go              golangci-lint when configured, else gofmt syntax check
#   *.sh *.bash       shellcheck
#
# Nothing installed, file outside the project, or linter crashed or timed out:
# exit 0 with no output. A broken linter must not turn into fake diagnostics.
set -euo pipefail

hook_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=_lib.sh
source "$hook_dir/_lib.sh"

hook_require_jq

input=$(cat)
file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null) || exit 0
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null) || cwd=""
[ -n "$file_path" ] && [ -f "$file_path" ] || exit 0

# Only files in this project (or the worktree the agent is working in).
root=$(project_root)
case "$file_path" in
"$root"/*) ;;
*)
  if [ -z "$cwd" ]; then exit 0; fi
  case "$file_path" in "$cwd"/*) ;; *) exit 0 ;; esac
  ;;
esac

# Dependencies, build output, and VCS internals are not ours to lint.
case "$file_path" in
*/node_modules/* | */.venv/* | */venv/* | */vendor/* | */dist/* | */build/* | */.git/* | */target/*) exit 0 ;;
esac

file_dir=$(dirname "$file_path")
out=""
rc=0
tool=""

# node_bin <name>: a project-local node binary, nearest node_modules/.bin first.
node_bin() {
  local dir
  dir=$(find_up "$file_dir" "node_modules/.bin/$1") || return 1
  printf '%s\n' "$dir/node_modules/.bin/$1"
}

lint_python() {
  local dir ruff=""
  dir=$(find_up "$file_dir" pyproject.toml ruff.toml .ruff.toml) || dir=$file_dir
  if [ -x "$dir/.venv/bin/ruff" ]; then
    ruff="$dir/.venv/bin/ruff"
  else
    ruff=$(command -v ruff 2>/dev/null) || return 0
  fi
  tool="ruff check"
  # ruff exits 1 for violations, 2 for its own errors (bad config, crash).
  out=$(cd "$dir" && with_timeout 20 "$ruff" check --no-fix --quiet "$file_path") || rc=$?
  [ "$rc" -eq 1 ] || out=""
}

lint_biome() {
  local cfg bin
  cfg=$(find_up "$file_dir" biome.json biome.jsonc) || return 1
  bin=$(node_bin biome) || bin=$(command -v biome 2>/dev/null) || return 0
  tool="biome check"
  out=$(cd "$cfg" && with_timeout 20 "$bin" check --colors=off "$file_path") || rc=$?
  # Clean, timed out, or the file is outside biome's configured includes.
  if [ "$rc" -eq 0 ] || [ "$rc" -ge 124 ] || grep -q "No files were processed" <<<"$out"; then
    out=""
  fi
  return 0
}

lint_eslint() {
  local cfg bin
  cfg=$(find_up "$file_dir" eslint.config.js eslint.config.mjs eslint.config.cjs \
    eslint.config.ts eslint.config.mts eslint.config.cts \
    .eslintrc.js .eslintrc.cjs .eslintrc.json .eslintrc.yml .eslintrc.yaml .eslintrc) || return 0
  bin=$(node_bin eslint) || return 0
  tool="eslint"
  # eslint exits 1 for lint errors, 2 for config or crash.
  out=$(cd "$cfg" && with_timeout 30 "$bin" --no-color "$file_path") || rc=$?
  [ "$rc" -eq 1 ] || out=""
}

lint_go() {
  local mod rel
  mod=$(find_up "$file_dir" go.mod) || return 0
  if command -v golangci-lint >/dev/null 2>&1 &&
    find_up "$file_dir" .golangci.yml .golangci.yaml .golangci.toml .golangci.json >/dev/null; then
    tool="golangci-lint"
    rel=${file_dir#"$mod"}
    out=$(cd "$mod" && with_timeout 45 golangci-lint run "./${rel#/}") || rc=$?
    [ "$rc" -eq 1 ] || out=""
    return 0
  fi
  command -v gofmt >/dev/null 2>&1 || return 0
  # gofmt -e reports syntax errors; formatting itself is fixed on Stop.
  tool="gofmt (syntax)"
  out=$(with_timeout 10 gofmt -e -l "$file_path") || rc=$?
  [ "$rc" -ne 0 ] && [ "$rc" -lt 124 ] || out=""
}

lint_shell() {
  command -v shellcheck >/dev/null 2>&1 || return 0
  tool="shellcheck"
  out=$(with_timeout 15 shellcheck --color=never --format=gcc "$file_path") || rc=$?
  [ "$rc" -eq 1 ] || out=""
}

case "$file_path" in
*.py | *.pyi) lint_python ;;
*.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs | *.mts | *.cts) lint_biome || lint_eslint ;;
*.json | *.jsonc | *.css) lint_biome || true ;;
*.go) lint_go ;;
*.sh | *.bash) lint_shell ;;
*) exit 0 ;;
esac

out=$(printf '%s' "$out" | strip_control)
# Project-relative paths read better and cost fewer tokens.
out=${out//"$root/"/}
[ -z "${out//[[:space:]]/}" ] && exit 0

# Keep the payload small. Cut by line, not byte, so multi-byte characters survive.
max_lines=60
if [ "$(wc -l <<<"$out" | tr -d ' ')" -gt "$max_lines" ]; then
  out="$(head -n "$max_lines" <<<"$out")"$'\n'"... (truncated; run the linter on this file for the rest)"
fi

rel_path=${file_path#"$root"/}
jq -n --arg ctx "$tool found issues in $rel_path. Fix them before moving on:"$'\n'"$out" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $ctx
  }
}'
exit 0
