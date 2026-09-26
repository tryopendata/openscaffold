#!/usr/bin/env bash
# `prepare`, which bun runs after every `bun install`: the git hooks and the browser the e2e
# smoke uses. CI sets CI and does its own setup, so this does nothing there.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -n "${CI:-}" ] && exit 0

if command -v lefthook >/dev/null 2>&1; then
  # Not fatal: outside a git checkout lefthook fails, and that mustn't fail `bun install`.
  lefthook install || echo "lefthook install failed: git hooks not installed (run it again inside the git checkout)"
else
  echo "lefthook not found: git hooks not installed (brew install lefthook, then bun install)"
fi

# Downloads Chromium the first time (about 150 MB); a no-op after that.
node_modules/.bin/playwright install chromium ||
  echo "Couldn't install Chromium for bun run e2e; retry with: bunx playwright install chromium"
