---
schema_version: 1
id: agent-ops
kind: fragment
category: agent-ops
name: Agent operations
description: The project's agent instruction file (AGENTS.md, read by every coding agent) plus a Claude Code adapter with CLAUDE.md, shared settings, and guard hooks for destructive commands, secret detection, lint-on-write, format-on-stop, and session-start context.
tags: [agents, claude, codex, cursor, opencode]
applies_to: []
tools: [git, jq]
merge: [.claude/settings.json]
verify:
  - name: agents-md-filled
    run: "test -s AGENTS.md && ! grep -n 'openscaffold:fill' AGENTS.md"
---

# Agent operations

This fragment gives the project one canonical instruction file for coding agents, `AGENTS.md`, and a Claude Code adapter around it. It ships a skeleton; your job is to fill it from the project as it actually exists once setup is done.

## What to add

**`AGENTS.md` (copied as a skeleton).** Fill it last, after the stack's generators have run and `openscaffold verify` is close to green, so it describes the real project and not the plan:

- Every `<!-- openscaffold:fill ... -->` comment says what belongs there. Replace each with real content and delete the comment. The `agents-md-filled` verify step fails while any remain. A section that genuinely has nothing yet gets a one-line "None yet." rather than being padded.
- **Commands must match the real Makefile or package scripts exactly.** Copy target names from the file, run each one once, and only list commands that work. Include how to run a single test file, since that's what agents need most. Verify steps call these same commands, so the table and `openscaffold verify` must agree.
- **Architecture map** lists directories that exist, with one line each. Don't describe directories the stack might grow later.
- **Build workarounds**: every pin, patch, disabled lint rule, or config hack you added to get green goes in the table with the condition under which it can be removed ("drop when upstream fixes X", "remove after the next major of Y"). If you had to weaken anything to get a tool working, it belongs here, visibly.
- **Deferred** and **Pending user actions**: record what you consciously left out and what only the user can do (accounts, API keys, DNS). These stop the next session from re-reporting known gaps.
- Keep it under about 200 lines. Detail that only matters to one area goes in a doc linked from **Deeper context** (or, for Claude, a path-scoped rule).

Other fragments in this project will ask you to add their own sections to `AGENTS.md` (CI, database, deploy, git hooks, rr). Add each under its own `##` heading, placed near related sections (a database section after Architecture map, CI and deploy near the end, before Deferred), and keep the same tone: commands that exist, facts an agent would not guess.

When `add` runs against a repo that already has an `AGENTS.md`, the skeleton isn't copied and the brief lists it as "merge needed". Keep the existing file and add any missing sections from the skeleton's structure (Commands, Build workarounds, Deferred, Pending user actions) instead of replacing it. The same goes for an existing `CLAUDE.md`: make sure it imports `AGENTS.md` (`@AGENTS.md`) rather than duplicating it, moving shared content into `AGENTS.md`.

**Claude Code adapter (copied when Claude is a target).**

- `CLAUDE.md` imports `AGENTS.md` with `@AGENTS.md` and adds only Claude-specific notes. Claude Code reads `CLAUDE.md` in preference to `AGENTS.md`, so the import is what keeps one source of truth.
- `.claude/settings.json` wires the hooks and denies the worst destructive commands. Other fragments (rr, ce-plugin) deep-merge into this file; don't hand-copy their keys.
- `.claude/hooks/` holds the hooks, documented in `.claude/README.md`. They need `jq` and otherwise stay quiet. If `jq` isn't installed, tell the user (it's under `tools`), and add it to Pending user actions if they decline.
- `.claude/.gitignore` ignores `settings.local.json` and `worktrees/`.

After the project's linters are configured, write one file with a deliberate lint error and confirm `lint-on-write.sh` reports it, then revert. If it stays silent, check that the linter is installed where the hook looks (project `.venv`, `node_modules/.bin`, or PATH) and that its config file is at or above the file. Adjust the hook only for a real project layout it misses, and keep it tool-agnostic.

Project-specific guards belong in the hooks, not in prose: a generated file that must never be hand-edited, a service that must be running at session start. Add them when the project actually has such a thing, following the existing scripts (bash 3.2 compatible, `set -euo pipefail`, exit 0 quietly when a tool is missing, a timeout around anything external).

**Other agents.** Codex, OpenCode, and Cursor all read `AGENTS.md` natively from the project root, so they need no adapter and none is shipped. Cursor's own `.cursor/rules/*.mdc` format and each agent's hook system are left for later; don't create config for them unless the user asks.

## Gotchas

- Claude Code ignores `AGENTS.md` whenever a `CLAUDE.md` exists, unless `CLAUDE.md` imports it. Never remove the `@AGENTS.md` line.
- Claude Code creates worktrees under `.claude/worktrees/`. Linters that discover nested config files (biome, eslint) can trip over a worktree's copy of the repo; if one does, add `.claude/worktrees/` to the root `.gitignore` (the nested `.claude/.gitignore` is not enough for those tools).
- Hook scripts are invoked through `bash`, so they work without the executable bit, but keep them executable anyway so they can be run by hand.

## Verify

`agents-md-filled` fails when `AGENTS.md` is missing or empty, or while any `openscaffold:fill` marker remains in it. It checks presence, not quality: re-read the finished file once and make sure every command in it is one you ran.
