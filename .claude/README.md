# `.claude/`: Claude Code config

```
settings.json        shared config: env, allow/deny rules, hooks wiring
settings.local.json  your machine-only overrides (gitignored, create as needed)
hooks/               shell hooks, described below
rules/               path-scoped guidance, loaded when a rule's `paths:` globs match
commands/            slash commands (/e2e)
```

Project instructions live in `AGENTS.md` at the repo root, which every coding agent reads. The root `CLAUDE.md` imports it and adds only Claude-specific notes, so edit `AGENTS.md` for anything that isn't Claude-specific.

## Dogfooding agent-ops

This config is what the `agent-ops` fragment ships, applied to this repo: `CLAUDE.md`, `.claude/.gitignore`, and every hook except `validate-registry.sh` are copies of `registry/fragments/agent-ops/adapters/claude/`, and `AGENTS.md` is its `files/AGENTS.md.tmpl` filled in by hand. Change a shipped hook in the registry first (where `tests/hooks.test.ts` covers it), then copy it here. To see drift:

```bash
diff -r registry/fragments/agent-ops/adapters/claude/.claude/hooks .claude/hooks
```

The only expected difference is `validate-registry.sh`, which is specific to this repo.

## Hooks

| Hook | Event | What it does |
| --- | --- | --- |
| `session-start.sh` | SessionStart | Adds branch, dirty-file count, a warning on `main`, missing `node_modules/`, and a note when jq is missing. |
| `block-destructive.sh` | PreToolUse `Bash` | Denies commands that destroy work or data: `rm` of `/`, `~` or `.`, `git reset --hard`, `git clean -f`, force push (`--force-with-lease` is allowed), publishing a release (`bun publish`, `npm publish`). The agent sees the reason and asks you instead. |
| `detect-secrets.sh` | PreToolUse `Edit\|Write` | Denies writes containing credential-shaped strings (cloud and SaaS keys, private keys, tokens, connection strings with passwords). |
| `lint-on-write.sh` | PostToolUse `Edit\|Write` | Runs Biome on the `.ts`/`.js`/`.json` file just written (shellcheck for `.sh`) and hands diagnostics back to the agent. `registry/` is excluded by `biome.json`, so it stays quiet there. Also records the path for `format-changed.sh`. |
| `validate-registry.sh` | PostToolUse `Edit\|Write` | After a write under `registry/`, runs `bun src/cli.ts validate registry --json` (~0.1s) and hands back any errors or warnings. Repo-specific. |
| `format-changed.sh` | Stop | Formats the files this session wrote with `biome check --write`, then forgets them. `lint-on-write.sh` records each path written through Edit/Write in a per-session list under `$TMPDIR/openscaffold-hooks/`, keyed by the session id. Files you or other agents in the same checkout are editing aren't touched; no session id means nothing is formatted. |
| `_destructive-patterns.sh` | (sourced) | The pattern list behind `block-destructive.sh`. |
| `_lib.sh` | (sourced) | Shared helpers: jq check, project root, `find_up`, a portable `with_timeout`, the per-session file list. |

How they behave:

- **Quiet when there's nothing to do.** A hook whose tool isn't installed exits 0 with no output. Without jq, every hook that reads its input is a no-op, which is why the worst destructive commands are also in `permissions.deny`.
- **Guards deny; everything else advises.** Only `block-destructive.sh` and `detect-secrets.sh` block anything.
- **Nothing is downloaded.** Biome runs from `node_modules/.bin`; the hooks never call `npx` or `bunx`.
- Scripts are invoked as `bash "${CLAUDE_PROJECT_DIR}/.claude/hooks/<name>.sh"` and target bash 3.2 (the macOS default) under `set -euo pipefail`.

To try a hook by hand, pipe it a payload:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"git push -f"}}' | bash .claude/hooks/block-destructive.sh
echo "{\"tool_input\":{\"file_path\":\"$PWD/src/cli.ts\"}}" | bash .claude/hooks/lint-on-write.sh
```

## Settings

`settings.json` is shared and committed. It sets `OPENSCAFFOLD_OFFLINE=1` for every command Claude runs (tests and validate need it until the registry is published; override inline with `OPENSCAFFOLD_OFFLINE=0` to exercise the remote fetch), pre-approves the project's own commands (`bun run *`, `bun src/cli.ts *`, `node dist/cli.js *`, `bunx biome|vitest|tsc`, read-only git), and wires the hooks. Allow rules take effect after you trust the folder in Claude Code; deny rules apply right away. Put anything personal in `settings.local.json`.

`permissions.deny` repeats the worst destructive shapes so they stay blocked on a machine without jq. They are exact rules on purpose: a wildcard such as `Bash(rm -rf /*)` would match every `rm -rf /some/abs/path`, and a deny rule can't be overridden by an allow rule.
