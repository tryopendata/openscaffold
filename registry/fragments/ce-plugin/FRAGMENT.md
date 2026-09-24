---
schema_version: 1
id: ce-plugin
kind: fragment
category: agent-ops
name: Claude Essentials plugin
description: Enables the claude-essentials (ce) Claude Code plugin for the project and adds path-scoped rules that point Claude at its skills for testing, error handling, debugging, and writing.
tags: [agents, claude]
applies_to: []
requires: [agent-ops]
merge: [.claude/settings.json]
---

# Claude Essentials plugin

[claude-essentials](https://github.com/rileyhilliard/claude-essentials) is a Claude Code plugin marketplace whose `ce` plugin packages general engineering practice as skills and agents. This fragment turns it on for everyone who opens the project in Claude Code and wires it to the project through rules. It only affects Claude Code; other agents see nothing from it.

What `ce` provides:

- **Skills** (loaded on demand as `ce:<name>`): `writing-tests`, `fixing-flaky-tests`, `systematic-debugging`, `handling-errors`, `optimizing-performance`, `architecting-systems`, `executing-plans`, `writer`, `visualizing-with-mermaid`, `managing-databases`, `writing-sql`, `managing-pipelines`, `design`, `planning-products`, `post-mortem`, `strategy-writer`, `structuring-articles`.
- **Agents**: `ce:code-reviewer`, `ce:log-reader`, `ce:devils-advocate`, `ce:copywriter`.
- **Command**: `/ce:setup`, which audits or bootstraps a repo's `.claude/` config.

## What to add

**Settings (merged into `.claude/settings.json`).** Registers the `claude-essentials` marketplace from GitHub and enables `ce@claude-essentials`. Claude Code applies marketplace entries only after the user trusts the project folder, so the plugin appears on the next trusted session, not necessarily in the one doing the scaffolding. Nothing else to do for it.

**Rules (copied to `.claude/rules/`).** Each rule is short and tells Claude which `ce` skill to load, deferring to `AGENTS.md` for project facts:

| Rule | Loads for | Points at |
| --- | --- | --- |
| `testing.md` | test files and test directories | `ce:writing-tests`, `ce:fixing-flaky-tests` |
| `error-handling.md` | source files (TS/JS, Python, Go, Rust) | `ce:handling-errors` |
| `debugging.md` | always | `ce:systematic-debugging`, `ce:optimizing-performance`, the debugging budget in `AGENTS.md` |
| `writing.md` | Markdown and `docs/` | `ce:writer`, `ce:visualizing-with-mermaid` |

Once the project exists, check the `paths:` globs in `testing.md` and `error-handling.md` against the real layout and tighten them if they match far more than they should (for example, a vendored directory). If the project has a stack-specific testing pattern worth enforcing (the harness to use, what may be faked), add a short `## Project specifics` section to `testing.md` rather than repeating what `AGENTS.md` already says. Add a rule for another skill (`ce:managing-databases` for schema and migration files, `ce:managing-pipelines` for CI workflows) only when the project has files for it to attach to.

Don't copy skill content into the rules or `AGENTS.md`. The rules exist to route to the skills.

**CLAUDE.md.** Add one line to the Claude Code section noting that the `ce` plugin is enabled and that `.claude/rules/` routes to its skills.

## Gotchas

- Skills are referenced by their current names above. If a rule names a skill that doesn't exist, Claude silently gets nothing; check the plugin's skill list if you add rules.
- `autoUpdate` is on, so the plugin follows the marketplace, consistent with openscaffold's no-pinning policy.
