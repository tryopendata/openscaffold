---
schema_version: 1
id: git-hooks
kind: fragment
category: tooling
name: Git hooks (lefthook)
description: lefthook git hooks that format and lint staged files, enforce Conventional Commits, and run the project's tests before push.
tags: [git, lefthook, conventional-commits]
applies_to: []
tools: [git, lefthook]
decisions:
  - "Conventional Commits commit-msg hook (default: yes)."
  - "Tests on pre-push (default: yes; only the fast tests if the suite takes minutes)."
verify:
  - { name: git-hooks-install, phase: setup, run: lefthook install }
  - { name: git-hooks-validate, run: lefthook validate }
---

# Git hooks (lefthook)

Write `lefthook.yml` at the root for the installed lefthook (its schema changed between majors; `lefthook validate` confirms it).

## What to add

**Install.** `lefthook` must be on PATH (verify calls it). Add `lefthook install` to `make install` so fresh clones get the hooks, skipped when `CI` is set (runners don't have lefthook), and note in `AGENTS.md` how to install lefthook.

**pre-commit**: staged files only, one job per language area (glob, plus root in a monorepo). Format with fixes re-staged (stage-fixed), then lint in check mode if the project has a linter, with the same tools and config as the project's commands. Tools that need the whole project (golangci-lint) run the project's lint command instead. A few seconds total.

**commit-msg**: a few lines of shell (no commitlint in a non-JS project) requiring `type(scope)!: description`, types `feat fix docs style refactor perf test build ci chore revert`, scope and `!` optional. Allow merges, git reverts, `fixup!`/`squash!`. On failure print the format and an example.

**pre-push**: the project's test target. Add the lint target only if pre-commit lints just staged files.

**Prove it** before finishing: run the pre-commit hook on all files (`lefthook run pre-commit` with its all-files flag; it only sees tracked files, so `git add -A` first in a repo with no commits), then `printf 'bad\n' > /tmp/msg && lefthook run commit-msg /tmp/msg` must fail and the same with `feat: add thing` must pass.

## AGENTS.md

A **Git hooks** section: what each hook runs, the commit format, how hooks are installed, and no `--no-verify`: fix the cause or the hook.
