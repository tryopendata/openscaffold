#!/usr/bin/env bash
# pre-push: run `bun run check` against the commits being pushed, in a throwaway
# worktree, so uncommitted edits in the working tree can't pass or fail the push.
# Git feeds "<local ref> <local sha> <remote ref> <remote sha>" lines on stdin.
set -euo pipefail

zero=0000000000000000000000000000000000000000
shas=""
while read -r _local_ref local_sha _remote_ref _remote_sha; do
  [ "$local_sha" = "$zero" ] && continue # branch deletion: nothing to check
  case " $shas " in *" $local_sha "*) ;; *) shas="$shas $local_sha" ;; esac
done
# No stdin (run by hand): check HEAD.
[ -n "$shas" ] || shas=$(git rev-parse HEAD)

for sha in $shas; do
  tree=$(mktemp -d "${TMPDIR:-/tmp}/openscaffold-prepush.XXXXXX")
  trap 'git worktree remove --force "$tree" >/dev/null 2>&1 || rm -rf "$tree"' EXIT
  echo "pre-push: checking $(git rev-parse --short "$sha") in a clean worktree"
  git worktree add --quiet --detach "$tree" "$sha"
  (
    cd "$tree"
    bun install --frozen-lockfile --silent
    OPENSCAFFOLD_OFFLINE=1 bun run check
  )
  git worktree remove --force "$tree"
  trap - EXIT
done
