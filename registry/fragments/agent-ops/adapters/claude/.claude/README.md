# `.claude/`: Claude Code config

```
settings.json        shared config: hooks wiring, read-only allow rules, destructive-command deny rules
settings.local.json  your machine-only overrides (gitignored, create as needed)
hooks/               shell hooks, described below
rules/               path-scoped guidance, loaded when a rule's `paths:` globs match
```

Project instructions live in `AGENTS.md` at the repo root, which every coding agent reads. The root `CLAUDE.md` imports it and adds only Claude-specific notes, so edit `AGENTS.md` for anything that isn't Claude-specific.

## Hooks

| Hook | Event | What it does |
| --- | --- | --- |
| `session-start.sh` | SessionStart | Adds branch, dirty-file count, a warning on `main`, a missing `.env`, uninstalled dependencies (a `package.json` without `node_modules/` or a `pyproject.toml` without `.venv/`, at the root or one directory down, with the install command), compose services that aren't running, and a note when jq is missing. |
| `block-destructive.sh` | PreToolUse `Bash` | Denies commands that destroy work or data: `rm` of `/`, `~` or `.`, `git reset --hard`, `git clean -f`, force push (`--force-with-lease` is allowed), `DROP TABLE`, `docker compose down -v`, publishing a release. The agent sees the reason and asks you instead. |
| `detect-secrets.sh` | PreToolUse `Edit\|Write` | Denies writes containing credential-shaped strings (cloud and SaaS keys, private keys, tokens, connection strings with passwords). |
| `lint-on-write.sh` | PostToolUse `Edit\|Write` | Runs the project's linter on the file just written (ruff, biome or eslint, golangci-lint or gofmt, shellcheck) and hands diagnostics back to the agent. Also records the path for `format-changed.sh`. |
| `format-changed.sh` | Stop | Formats the files this session wrote with the formatters the project has configured (ruff, biome or prettier, gofmt), then forgets them. `lint-on-write.sh` records each path written through Edit/Write in a per-session list under `$TMPDIR/openscaffold-hooks/`, keyed by the session id. Files you or other agents in the same checkout are editing aren't touched; no session id means nothing is formatted. |
| `_destructive-patterns.sh` | (sourced) | The pattern list behind `block-destructive.sh`. Reuse it from any hook that approves or rewrites Bash commands. |
| `_lib.sh` | (sourced) | Shared helpers: jq check, project root, `find_up`, a portable `with_timeout`, the per-session file list. |

How they behave:

- **Quiet when there's nothing to do.** A hook whose tool isn't installed exits 0 with no output. Without jq, every hook that reads its input is a no-op, which is why the worst destructive commands are also in `permissions.deny` in `settings.json`, and why `session-start.sh` says so.
- **Guards deny; everything else advises.** Only `block-destructive.sh` and `detect-secrets.sh` block anything. Lint results arrive as context and never block a write.
- **Nothing is downloaded.** Linters and formatters run only from the project's own install (`.venv`, `node_modules/.bin`) or from PATH. The hooks never call `npx`, `bunx`, or `uv run`, which could fetch packages or sync environments mid-session.
- **Timeouts everywhere.** Each external call runs under a timeout, so a stuck linter or Docker daemon can't stall the session.
- Scripts are invoked as `bash "${CLAUDE_PROJECT_DIR}/.claude/hooks/<name>.sh"`, so they don't need the executable bit, and they target bash 3.2 (the macOS default) under `set -euo pipefail`.

To try a hook by hand, pipe it a payload:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"git reset --hard"}}' | bash .claude/hooks/block-destructive.sh
```

### Changing them

- Add a destructive pattern to `_destructive-patterns.sh`, not to `block-destructive.sh`.
- Project-specific checks (generated files that must not be hand-edited, a missing symlink at session start) go in the relevant hook or a new one wired in `settings.json`. A hook that fires on every tool call should cost milliseconds.
- If the project has hook tests, add a case for each new pattern: one command that must be denied and one near miss that must pass.

## Settings

`settings.json` is shared and committed. Some keys (permission allow rules, plugin marketplaces) only take effect after each person trusts the folder in Claude Code; deny rules apply right away. Put anything personal (extra permissions, env, personal MCP servers) in `settings.local.json`.

`permissions.allow` starts with read-only git only (`status`, `diff`, `log`, `show`, `branch --show-current`). Add the project's own non-destructive commands (lint, test, typecheck) as they settle; leave deploy, publish, and anything destructive to prompt.

`permissions.deny` repeats the worst destructive shapes (`rm -rf /`, `rm -rf ~`, `rm -rf .`, force push, `git reset --hard`) so they stay blocked on a machine without jq, where `block-destructive.sh` can't run. They are exact rules on purpose: a wildcard such as `Bash(rm -rf /*)` would match every `rm -rf /some/abs/path`, and a deny rule can't be overridden by an allow rule.

Depending on which openscaffold fragments are installed, `settings.json` may also:

- register the `claude-essentials` marketplace and enable its `ce` plugin (skills for testing, debugging, error handling, and writing; review agents), or
- register the `rr` marketplace and enable the `rr` plugin (the rr skill and `/rr:setup`), pre-approving rr's read-only commands (`rr doctor`, `rr status`, `rr tasks`). `rr run`/`exec` and named tasks still prompt, because they run commands on remote hosts.

Both take effect once each person trusts the folder in Claude Code.
