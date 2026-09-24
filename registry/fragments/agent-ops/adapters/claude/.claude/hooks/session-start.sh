#!/usr/bin/env bash
# SessionStart: a few lines of live state that AGENTS.md can't carry because it
# is static: the branch, how dirty the tree is, whether .env exists, whether the
# services declared in the compose file are running, and whether jq (which the
# other hooks need) is installed.
#
# Plain-text stdout from a SessionStart hook is added to the agent's context, so
# this hook needs no jq. Cheap: a few git calls and at most two `docker compose`
# calls, each behind a timeout so a stuck Docker daemon can't stall startup.
# Add project-specific checks at the end (a missing symlink, a required login).
set -euo pipefail

hook_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=_lib.sh
source "$hook_dir/_lib.sh"

cat >/dev/null 2>&1 || true # payload unused

root=$(project_root)
cd "$root" 2>/dev/null || exit 0

lines=()
say() { lines+=("$1"); }

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # `branch --show-current` rather than `rev-parse --abbrev-ref HEAD`, which
  # prints "HEAD" before the first commit.
  branch=$(git branch --show-current 2>/dev/null || true)
  [ -z "$branch" ] && branch="(detached HEAD)"
  dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ') || dirty="?"
  say "Repo state: branch \`$branch\`, $dirty changed file(s)."
  # No nag before the first commit: a new project's initial commit goes on main.
  if git rev-parse -q --verify HEAD >/dev/null 2>&1; then
    case "$branch" in
    main | master) say "You're on \`$branch\`: create a branch before committing non-trivial work." ;;
    esac
  fi
fi

if ! command -v jq >/dev/null 2>&1; then
  say "jq is not installed, so the hooks in .claude/hooks that read their input (destructive-command guard, secret detection, lint-on-write) are inactive. Tell the user; installing jq turns them on."
fi

if [ -f .env.example ] && [ ! -f .env ]; then
  say ".env is missing. Copy .env.example to .env and fill in local values before running the app or tests."
fi

compose_file=""
for f in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
  if [ -f "$f" ]; then
    compose_file=$f
    break
  fi
done
if [ -n "$compose_file" ] && command -v docker >/dev/null 2>&1; then
  rc=0
  declared=$(with_timeout 5 docker compose -f "$compose_file" config --services) || rc=$?
  if [ "$rc" -ne 0 ]; then
    say "Docker isn't responding, so the services in $compose_file can't be checked. Tests that need them will fail until Docker is running."
  else
    running=$(with_timeout 5 docker compose -f "$compose_file" ps --services --status running 2>/dev/null) || running=""
    down=""
    while IFS= read -r svc; do
      # with_timeout merges stderr; compose warnings are not service names.
      grep -qE '^[A-Za-z0-9._-]+$' <<<"$svc" || continue
      grep -qxF -e "$svc" <<<"$running" || down="${down:+$down, }$svc"
    done <<<"$declared"
    if [ -n "$down" ]; then
      say "Services declared in $compose_file but not running: $down. Start them with the project's service command (see Commands in AGENTS.md) before running tests that need them."
    fi
  fi
fi

[ "${#lines[@]}" -eq 0 ] && exit 0
printf '%s\n' "${lines[@]}"
exit 0
