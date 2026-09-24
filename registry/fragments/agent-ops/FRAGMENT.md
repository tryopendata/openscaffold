---
schema_version: 1
id: agent-ops
kind: fragment
category: agent-ops
name: Agent operations
description: AGENTS.md for every coding agent, plus a Claude Code adapter with CLAUDE.md, settings, and hooks guarding destructive commands and secrets, linting on write, and formatting the agent's own edits on stop.
tags: [agents, claude, codex, cursor, opencode]
applies_to: []
tools: [git, jq]
merge: [.claude/settings.json]
verify:
  - name: agents-md-filled
    run: "test -s AGENTS.md && ! grep -n 'openscaffold:fill' AGENTS.md"
---

# Agent operations

One canonical instruction file for every coding agent, `AGENTS.md`, plus a Claude Code adapter.

## What to add

**`AGENTS.md`** is a skeleton. Fill it last, once verify is nearly green, from the project as built:

- Replace each `openscaffold:fill` comment with real content; empty sections get "None yet."
- Commands match the real Makefile or scripts, each run once, including a single-test-file command. The architecture map lists only directories that exist.
- **Build workarounds** lists every pin, patch, disabled rule, or hack you added to get green, with when to remove it. **Deferred** and **Pending user actions** record what you left out and what only the user can do.
- Under about 200 lines. Other fragments' sections go under their own `##` near related ones (database after Architecture map, CI and deploy before Deferred).

<!-- openscaffold:when mode=add -->
When the repo already has an `AGENTS.md`, the skeleton isn't copied (it's listed as "merge needed"). Keep the existing file and add the skeleton's missing sections (Commands, Build workarounds, Deferred, Pending user actions). An existing `CLAUDE.md` must import `AGENTS.md` (`@AGENTS.md`) instead of duplicating it; move shared content into `AGENTS.md`.
<!-- openscaffold:end -->

**Claude Code adapter** (when Claude is a target): `CLAUDE.md` imports `AGENTS.md` via `@AGENTS.md` (Claude Code ignores `AGENTS.md` otherwise; never remove the line). `.claude/settings.json` wires the hooks; other fragments deep-merge into it. The hooks need `jq`; if it's missing, tell the user and list it under Pending user actions.

`.claude/settings.json` pre-approves only read-only git (`status`, `diff`, `log`, `show`, `branch --show-current`). Once the Commands section of `AGENTS.md` is settled, add `permissions.allow` rules for the project's own non-destructive commands, in the same `Bash(<cmd>)` / `Bash(<cmd> *)` shape: lint, format, typecheck, test, and the single-test-file command (`make lint`, `make test`, the test runner). Never allow deploy, publish, release, migrate, or anything that deletes data; those should keep prompting.

If the project has a linter, confirm `lint-on-write.sh` reports a deliberate lint error, then revert. If it's silent, check the linter is where the hook looks (`.venv`, `node_modules/.bin`, PATH); `session-start.sh` also flags a `package.json` or `pyproject.toml` whose dependencies aren't installed. `format-changed.sh` formats, on Stop, only the files the current session wrote (lint-on-write records them per session), so parallel agents in one checkout don't reformat each other's work in progress. If the project uses biome or eslint, add `.claude/worktrees/` to the root `.gitignore`: both discover nested config and trip over Claude Code worktrees. Project-specific guards (a generated file never hand-edited) belong in hooks written like the existing ones (bash 3.2, `set -euo pipefail`, quiet exit when a tool is missing).
