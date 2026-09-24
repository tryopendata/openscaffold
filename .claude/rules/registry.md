---
paths:
  - "registry/**"
  - "tests/fixtures/**"
---

# Editing the registry

`registry/` is product content: every file here ends up in someone's project or in the brief their agent reads. `docs/format.md` is the reference and `src/schema/index.ts` is the source of truth; `docs/authoring.md` says how to write an entry that still works in a year. Read the relevant parts before adding a new entry or field.

## Rules that `validate` can't fully enforce

- **Version-less.** Never pin a version in frontmatter (`deps` are package names grouped by role), prose, or files. Don't ship config whose schema changes between releases (`tsconfig.json`, `vitest.config.*`, `vite.config.*`, `pyproject.toml`, `.golangci.yml`, `package.json`, Dockerfiles, CI workflows) in `files/`; describe what it must enforce in the body and let the agent write it. `validate` warns on known version-sensitive names; treat the warning as an error.
- **Intent over steps that age.** "Configure Tailwind through its Vite plugin", not "edit tailwind.config.js". Name generators and say "non-interactively" without naming flags. A statement only true for some versions goes under `## Gotchas` with the condition that makes it true.
- **Templating is `.tmpl` only.** Only files ending in `.tmpl` are rendered (suffix stripped), with just `{{project_name}}`, `{{project_slug}}`, `{{package_scope}}`, `{{author}}`, `{{year}}`. No conditionals or loops. Every other file is copied byte for byte, so `${{ secrets.X }}` in a workflow is safe.
- **Conditional prose** uses `<!-- openscaffold:when key=a,b -->` / `<!-- openscaffold:end -->`, each marker on its own line, no nesting. Keys: `stack`, `tag`, `mode` (`new`|`add`), `preset` (`default`|`sandbox`), `with`. Use it for notes that only matter for some stacks or for `add`, so other briefs don't carry them.
- **One owner per output path.** Two entries writing the same path is a composition error unless every contributor lists it in `merge` (JSON only, deep-merged). Shared prose files (AGENTS.md, README, Makefile) are owned by one fragment; others describe their additions in prose.
- **Verify steps** call project commands (`make test`), have unique kebab-case names across the composed project (prefix fragment steps: `db-up`), tag production-only steps `prod`, and `serve` steps need `expect.http` with `${PORT_*}` from `env`.
- **Decisions** state their default (`"Package manager (default: bun)"`). Quote any YAML entry containing `: `.
- Hooks under `adapters/claude/.claude/hooks/` target bash 3.2 with `set -euo pipefail`, exit 0 quietly when a tool is missing, and never download anything (`npx`, `bunx`, `uv run`). Add a case to `tests/hooks.test.ts` for any new pattern. This repo's own `.claude/hooks/` are copies; see `.claude/README.md`.

## Checking your change

- `bun run validate` must pass with no warnings. The `validate-registry.sh` hook runs it after each write here and reports problems.
- Prose changes: `bun run dev show <id>` shows the body unfiltered; scaffold the stack (`/e2e <stack>`) to read the brief as an agent will get it, with conditionals applied.
- New or substantially changed stack: it isn't done until an agent has taken `new <stack> --sandbox` to a green `verify` at least once (see `docs/authoring.md`, "Test it for real").

`tests/fixtures/` registries follow the same format, except `registry-bad/`, which is deliberately invalid. Keep fixtures minimal.
