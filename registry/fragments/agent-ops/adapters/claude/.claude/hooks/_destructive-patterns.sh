# shellcheck shell=bash
# Destructive-command patterns, sourced by block-destructive.sh. Kept in its own
# file so any other hook you add (an auto-approver, a Bash rewriter) can consult
# the same list: if a pattern lives here, nothing can approve a command the
# guard would deny.
#
# Usage:
#   source "$(dirname "${BASH_SOURCE[0]}")/_destructive-patterns.sh"
#   if found=$(is_destructive "$command"); then ...; fi
#
# is_destructive prints "<reason><TAB><suggestion>" and returns 0 when the
# command matches, returns 1 otherwise. Patterns use POSIX classes only, so BSD
# grep (macOS) and GNU grep agree. Matching uses here-strings, not pipes, so it
# stays correct under `set -o pipefail`.
#
# Add project-specific patterns at the end (e.g. a deploy script that must never
# run from an agent session). Test them in the project's hook tests.

is_destructive() {
  local command=$1
  [ -z "$command" ] && return 1

  # m <ere>: case-sensitive match. mi <ere>: case-insensitive.
  m() { grep -qE -e "$1" <<<"$command"; }
  mi() { grep -qiE -e "$1" <<<"$command"; }
  hit() {
    printf '%s\t%s' "$1" "$2"
  }

  # A separator or end of command, used after a dangerous argument.
  local end='([[:space:]]|;|&|\||\)|$)'
  # Start of a command word: start of string, a separator, or whitespace.
  local word='(^|[;&|(`]|[[:space:]])'

  # --- Filesystem ------------------------------------------------------------
  # rm against /, ~, ., .., $HOME or their /* forms. Matching on the target
  # rather than the flag cluster closes the split-flag bypass (rm -r -f /).
  if m "${word}rm[[:space:]]" &&
    m "rm[[:space:]].*([[:space:]]|=)(/|/\*|~/?|~/\*|\\\$HOME/?|\\\$HOME/\*|\.\.?|\./\*)${end}"; then
    hit "rm targeting the filesystem root, home, or the working directory." \
      "Name the exact paths to remove. Ask the user first."
    return 0
  fi
  if m "${word}rm[[:space:]](.*[[:space:]])?\*${end}"; then
    hit "rm with a bare wildcard." "Be explicit about which files to remove. Ask the user first."
    return 0
  fi
  if m "xargs[[:space:]].*rm[[:space:]]+-[a-zA-Z]*[rRf]"; then
    hit "Recursive or forced rm fed by xargs." "Review the pipeline. Ask the user first."
    return 0
  fi
  if m "${word}find[[:space:]].*-(delete${end}|exec(dir)?[[:space:]]+(rm|unlink|shred)[[:space:]])"; then
    hit "find with -delete or -exec rm deletes every matched file." \
      "Review the find expression and its root path. Ask the user first."
    return 0
  fi
  if m ">[[:space:]]*/dev/(sd|nvme|hd|disk|mapper|vd|xvd)"; then
    hit "Redirecting output to a raw disk device destroys it." "Do not run without explicit confirmation."
    return 0
  fi
  if m "${word}dd[[:space:]].*of=/dev/(sd|nvme|hd|disk|mapper|vd|xvd)"; then
    hit "dd writing to a raw disk device destroys it." "Confirm the of= target. Ask the user first."
    return 0
  fi
  if m "${word}mkfs(\.[[:alnum:]]+)?[[:space:]]"; then
    hit "mkfs reformats a device." "Do not run without explicit confirmation."
    return 0
  fi
  if m "${word}chmod[[:space:]]+(-R[[:space:]]+)?0?777"; then
    hit "chmod 777 makes files world-writable." "Use 755 for directories and 644 for files."
    return 0
  fi

  # --- Git: discarding uncommitted work --------------------------------------
  if m "git[[:space:]]+checkout[[:space:]]+(--[[:space:]]+)?\.${end}"; then
    hit "git checkout . discards every unstaged change." "Revert specific files: git checkout -- <file>"
    return 0
  fi
  if m "git[[:space:]]+restore[[:space:]]+\.${end}"; then
    hit "git restore . discards every unstaged change." "Revert specific files: git restore <file>"
    return 0
  fi
  if m "git[[:space:]]+clean[[:space:]]+(.*[[:space:]])?(-[a-zA-Z]*f|--force)"; then
    hit "git clean -f deletes untracked files permanently." "Preview with git clean -n. Ask the user first."
    return 0
  fi
  if m "git[[:space:]]+reset[[:space:]]+(.*[[:space:]])?--hard"; then
    hit "git reset --hard discards all uncommitted changes, staged and unstaged." \
      "Use git stash or a soft reset to keep the work. Ask the user first."
    return 0
  fi
  if m "git[[:space:]]+stash[[:space:]]+(drop|clear)"; then
    hit "git stash drop/clear destroys stashed work." "Other sessions may have work in the stash. Ask the user first."
    return 0
  fi

  # --- Git: rewriting shared history (--force-with-lease is allowed) ----------
  if m "git[[:space:]]+push[[:space:]](.*[[:space:]])?(-f|--force|-[a-zA-Z]*f[a-zA-Z]*)([[:space:]]|$)" ||
    m "git[[:space:]]+push[[:space:]](.*[[:space:]])?\+[^[:space:]]+"; then
    hit "Force push rewrites remote history." "Ask the user first. If it is needed, use --force-with-lease."
    return 0
  fi

  # --- Databases -------------------------------------------------------------
  if mi "(drop[[:space:]]+(table|database|schema)|truncate[[:space:]]+(table[[:space:]]+)?[[:alnum:]_\".]+)"; then
    hit "DROP or TRUNCATE causes irreversible data loss." "Ask the user first."
    return 0
  fi
  if mi "delete[[:space:]]+from[[:space:]]+[^[:space:];]+[[:space:]]*;?[[:space:]]*[\"']?[[:space:]]*$"; then
    hit "DELETE without a WHERE clause empties the table." "Add a WHERE clause, or ask the user first."
    return 0
  fi

  # --- Processes ---------------------------------------------------------------
  if m "${word}(killall[[:space:]]|pkill[[:space:]]+-9|kill[[:space:]]+-9[[:space:]]+-1)"; then
    hit "Broad process killing." "Kill a specific PID, or ask the user."
    return 0
  fi

  # --- Containers, hosting, releases ------------------------------------------
  if m "docker[[:space:]]+(system[[:space:]]+prune|volume[[:space:]]+(rm|prune)|image[[:space:]]+prune|rmi[[:space:]])" ||
    m "docker[[:space:]]+compose[[:space:]]+down[[:space:]](.*[[:space:]])?(-v|--volumes)${end}"; then
    hit "This deletes Docker images or volumes (including database data)." \
      "The Docker context may not be local. Ask the user first."
    return 0
  fi
  if m "${word}gh[[:space:]]+(repo|release)[[:space:]]+delete"; then
    hit "gh repo/release delete is unrecoverable." "Ask the user first."
    return 0
  fi
  if { m "${word}(npm|pnpm|yarn|bun|uv|cargo|poetry|gem)[[:space:]]+(.*[[:space:]])?publish${end}" ||
    m "${word}twine[[:space:]]+upload" ||
    m "${word}goreleaser[[:space:]]+release"; } &&
    ! m "(--dry-run|--snapshot)"; then
    hit "Publishing a release is irreversible." "Releases are user-initiated. Ask the user first."
    return 0
  fi

  return 1
}
