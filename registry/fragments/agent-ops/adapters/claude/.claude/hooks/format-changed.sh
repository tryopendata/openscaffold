#!/usr/bin/env bash
# Stop: format the files changed in the working tree (staged, unstaged, and new
# untracked files) at the end of each turn, so what the agent leaves behind is
# formatted even if nobody runs the formatter by hand.
#
# Only formatters the project has opted into run, and only on the files they own:
#
#   *.py              ruff format + safe ruff fixes, when ruff is configured or
#                     installed in the project's .venv
#   JS/TS/JSON/CSS    biome when a biome config exists, else prettier when a
#                     prettier config exists (project node_modules binaries)
#   *.go              gofmt
#
# Silent by design: no output, always exit 0. A Stop hook that prints errors can
# trap the session in a feedback loop.
set -euo pipefail

hook_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=_lib.sh
source "$hook_dir/_lib.sh"

cat >/dev/null 2>&1 || true # payload unused

root=$(project_root)
cd "$root" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# Works before the first commit too (no HEAD needed).
changed=$({
  git diff --name-only --cached --diff-filter=d 2>/dev/null || true
  git ls-files --modified --others --exclude-standard 2>/dev/null || true
} | sort -u)
[ -z "$changed" ] && exit 0

plan=$(mktemp "${TMPDIR:-/tmp}/claude-format.XXXXXX") || exit 0
trap 'rm -f "$plan"' EXIT

# prettier_for <dir>: prettier, when the project configured it and installed it.
prettier_for() {
  local cfg
  cfg=$(find_up "$1" .prettierrc .prettierrc.json .prettierrc.yaml .prettierrc.yml .prettierrc.js \
    .prettierrc.cjs .prettierrc.mjs .prettierrc.toml prettier.config.js prettier.config.cjs \
    prettier.config.mjs prettier.config.ts) || return 1
  [ -x "$cfg/node_modules/.bin/prettier" ] || return 1
  printf 'prettier\t%s\n' "$cfg"
}

# formatter_for <abs-path>: print "<tool>\t<workdir>" or return 1.
formatter_for() {
  local f=$1 dir cfg
  dir=$(dirname "$f")
  case "$f" in
  */node_modules/* | */.venv/* | */venv/* | */vendor/* | */dist/* | */build/* | */target/*) return 1 ;;
  *.py | *.pyi)
    cfg=$(find_up "$dir" ruff.toml .ruff.toml pyproject.toml) || return 1
    if [ -x "$cfg/.venv/bin/ruff" ]; then
      printf 'ruff-venv\t%s\n' "$cfg"
    elif command -v ruff >/dev/null 2>&1 &&
      { [ -f "$cfg/ruff.toml" ] || [ -f "$cfg/.ruff.toml" ] || grep -q '^\[tool\.ruff' "$cfg/pyproject.toml" 2>/dev/null; }; then
      printf 'ruff\t%s\n' "$cfg"
    else
      return 1
    fi
    ;;
  *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs | *.mts | *.cts | *.json | *.jsonc | *.css)
    # Biome first: when a project has both, biome is the one it chose last.
    if cfg=$(find_up "$dir" biome.json biome.jsonc) && [ -x "$cfg/node_modules/.bin/biome" ]; then
      printf 'biome\t%s\n' "$cfg"
    else
      prettier_for "$dir"
    fi
    ;;
  *.scss | *.html | *.vue | *.svelte | *.astro | *.md | *.mdx | *.yaml | *.yml)
    prettier_for "$dir"
    ;;
  *.go)
    command -v gofmt >/dev/null 2>&1 || return 1
    printf 'gofmt\t%s\n' "$root"
    ;;
  *) return 1 ;;
  esac
}

while IFS= read -r rel; do
  [ -n "$rel" ] && [ -f "$root/$rel" ] || continue
  key=$(formatter_for "$root/$rel") || continue
  printf '%s\t%s\n' "$key" "$root/$rel" >>"$plan"
done <<<"$changed"

[ -s "$plan" ] || exit 0

# One invocation per (tool, workdir), with all of that group's files.
cut -f1,2 "$plan" | sort -u | while IFS=$'\t' read -r tool dir; do
  set --
  while IFS= read -r f; do
    set -- "$@" "$f"
  done < <(awk -F'\t' -v t="$tool" -v d="$dir" '$1 == t && $2 == d { print $3 }' "$plan")
  [ "$#" -gt 0 ] || continue

  case "$tool" in
  ruff-venv)
    (cd "$dir" && with_timeout 20 .venv/bin/ruff format --quiet "$@" && with_timeout 20 .venv/bin/ruff check --fix --quiet "$@") >/dev/null 2>&1 || true
    ;;
  ruff)
    (cd "$dir" && with_timeout 20 ruff format --quiet "$@" && with_timeout 20 ruff check --fix --quiet "$@") >/dev/null 2>&1 || true
    ;;
  biome)
    (cd "$dir" && with_timeout 30 node_modules/.bin/biome check --write "$@") >/dev/null 2>&1 || true
    ;;
  prettier)
    (cd "$dir" && with_timeout 30 node_modules/.bin/prettier --write --ignore-unknown "$@") >/dev/null 2>&1 || true
    ;;
  gofmt)
    with_timeout 20 gofmt -w "$@" >/dev/null 2>&1 || true
    ;;
  esac
done

exit 0
