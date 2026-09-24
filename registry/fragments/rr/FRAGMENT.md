---
schema_version: 1
id: rr
kind: fragment
category: tooling
name: rr remote runner
description: Configures rr (github.com/rileyhilliard/rr) so the project's test, lint, and build commands can run on remote machines over SSH, with a committed .rr.yaml of named tasks, an AGENTS.md section, and the rr Claude Code plugin.
tags: [testing, remote, ssh]
applies_to: []
requires_tools: [rr]
tools: [rr]
merge: [.claude/settings.json]
decisions:
  - "Which rr hosts the project should use (default: every host in the user's ~/.rr/config.yaml, by leaving hosts out of .rr.yaml). If the user has no hosts configured, write .rr.yaml anyway and record host setup under Pending user actions."
  - "Fall back to running locally when no host is reachable (default: no; a run that can't reach a host fails loudly rather than quietly using the laptop)."
verify:
  - name: rr-config
    run: rr tasks
---

# rr remote runner

rr syncs the working tree to a remote machine with rsync and runs a command there, with host failover, per-host locking, and structured results (pass/fail counts and failing tests with file and line) that an agent can read without scrolling. It turns a slow local test suite into a remote one without changing the suite. It's an accelerator, not a dependency: every command must still work locally, and `openscaffold verify` runs locally.

rr has two config files. `~/.rr/config.yaml` is personal (SSH hosts, remote directories) and is never written by you without the user. `.rr.yaml` in the project is shared and committed (tasks, requirements, sync rules). You write `.rr.yaml`.

## What to add

**`.rr.yaml`**, written for the rr version installed. Run `rr init --help` and read the rr skill or docs for the current schema rather than relying on memory. It should contain:

- **Tasks that wrap the project's existing commands**, not new logic: typically `test` (calling the same Makefile target or script as local), `lint`, and one task per test area in a monorepo (`test-backend`, `test-frontend`), plus a parallel task that runs them together. Single-command tasks accept extra arguments, so scoped runs (`rr test -- <file or filter>`) work without extra task definitions; use an `{args}` placeholder if the command has pipes or `&&`. Don't name a task after a built-in rr command (`run`, `exec`, `sync`, and so on); rr rejects it.
- **`require:`** listing the tools the tasks need on the remote (the language toolchain, the package manager, `make`), so a missing tool fails with a clear error before syncing. Include a setup step (project `defaults.setup` or the task's own) that installs dependencies on the remote from the lockfile, since the remote has its own `.venv`/`node_modules`.
- **Sync rules** only if the defaults don't fit. rr already excludes `.git`, `.venv`, `node_modules`, caches, and agent directories, and applies `.gitignore`. A custom `sync.exclude` list replaces the defaults, so repeat them if you set one.
- **No `hosts:`** unless the user wants specific hosts: when omitted, rr uses every host in the user's global config, which keeps personal host names out of the shared file.

**Host setup** is the user's call. If `~/.rr/config.yaml` has hosts, run `rr doctor` and then one real task (`rr test`) to confirm it works end to end; `rr provision` can install missing tools the hosts need. If there are no hosts, don't invent any: add "configure an rr host (`rr host add`, then `rr doctor`)" to Pending user actions in `AGENTS.md`. In Claude Code, the rr plugin's `/rr:setup` command walks the user through this interactively.

**Claude Code adapter.** Merges into `.claude/settings.json`: registers the `rr` plugin marketplace and enables `rr@rr` (the `rr:rr` skill and `/rr:setup`), and allows rr's read-only commands (`rr doctor`, `rr status`, `rr tasks`) without prompting. `rr run`, `rr exec`, and tasks run arbitrary commands on another machine, so they still prompt. Once `.rr.yaml` exists, add allow rules for the project's own test tasks (for example `Bash(rr test *)`) to `.claude/settings.json` if the user wants them unprompted. Copies `.claude/rules/rr.md`, which loads when test files or `.rr.yaml` are open and points at the skill.

## AGENTS.md

Add an **rr (remote tests)** section after Testing:

- One line on what rr is and that it's optional: the same commands run locally.
- A table of the `.rr.yaml` tasks, what each runs, and when to use it (scoped run while iterating, full suite before finishing).
- How to scope a run (`rr test -- <path or filter>`), and that flags for the test runner go after `--`.
- How to read results: the final result event on stderr, `details.failures`, `details.no_tests` (zero tests is not a pass), and `details.log_file`.
- Recovering from a stuck lock (`rr unlock <host>`) and diagnosing connectivity (`rr doctor`).

Also add `rr` to the Commands table as an alternative way to run the test commands, not a replacement.

## Verify

`rr-config` runs `rr tasks`, which loads and validates `.rr.yaml` without contacting any host. It fails if the file is missing or invalid (for example, a task named after a built-in command). Nothing in verify needs a reachable host.
