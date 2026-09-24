# openscaffold

Instructions for coding agents working in this repository. Keep this file under about 200 lines: it is loaded at the start of every session. Put detail that matters only for one area in a doc and link it from Deeper context.

## Overview

openscaffold is a thin TypeScript CLI that composes version-less stack definitions (`registry/stacks/*/STACK.md`) and fragments (`registry/fragments/*/FRAGMENT.md`) into a new or existing project, writes `.openscaffold/BRIEF.md` and `manifest.yaml`, and hands off to a coding agent that builds the project until `openscaffold verify` passes. The CLI never calls an LLM, and `new`/`add` never run commands from an entry. Stack: bun for dev, tsup to a Node ESM bundle, commander, zod, yaml, execa, giget; vitest, Biome, `tsc --noEmit`, lefthook.

## Commands

Run these from the repo root. They are the only supported way to build, test, and run the project; if a command here is wrong, fix it here in the same change.

| Command | What it does |
| --- | --- |
| `bun install` | Install dependencies. Run `bunx lefthook install` once to enable the git hooks |
| `bun run dev <args>` | Run the CLI from source (`bun src/cli.ts <args>`), e.g. `bun run dev list --json` |
| `bun run test` | All vitest tests (`tests/**/*.test.ts`). Needs `OPENSCAFFOLD_OFFLINE=1` (see Testing) |
| `bun run test tests/render.test.ts` | One test file; add `-t "<name>"` for one test |
| `bun run lint` / `bun run lint:fix` | `biome check .` / with safe fixes and formatting applied |
| `bun run typecheck` | `tsc --noEmit` over src, tests, scripts, and config files |
| `bun run validate` | `openscaffold validate registry` from source: frontmatter, conditionals, templates, composition |
| `bun run check` | The gate: lint, typecheck, test, validate. Run it before calling work done |
| `bun run build` | tsup bundle to `dist/cli.js` (Node 20+, shebang added) |
| `node dist/cli.js <args>` | Smoke-test the built CLI under Node, as CI does |
| `bun run schema` | Regenerate `schema/*.json` from the zod schemas after changing `src/schema/index.ts` |

## Architecture map

```
src/
  cli.ts            commander entry; maps OpenScaffoldError to `error:`/`hint:` (or JSON) and exit 1
  commands/         one file per subcommand; each exports register(program), and new/add export runNew/runAdd
  registry/         scan.ts reads entry dirs, remote.ts fetches+caches the GitHub registry, index.ts merges origins
  schema/index.ts   zod schemas for STACK.md, FRAGMENT.md, manifest, user config (source of truth)
  compose.ts        resolves stack + fragments (requires, conflicts, applies_to, sandbox) into a plan
  conditionals.ts   `<!-- openscaffold:when ... -->` blocks in entry bodies
  render.ts         writes files: .tmpl rendering, JSON deep-merge for `merge` paths, incoming/ for add
  brief.ts          builds BRIEF.md;  manifest.ts reads/writes manifest.yaml
  handoff.ts        detects the calling agent, launches or prints the next step
  verify.ts         runs manifest verify steps by phase, probes serve steps, always runs teardown
  scaffold.ts       options and helpers shared by new and add (CommonRunOptions)
registry/           the bundled registry: stacks/<id>/ and fragments/<id>/ (STACK.md|FRAGMENT.md, files/, adapters/<agent>/)
tests/              vitest; fixtures/registry-*/ are small registries, helpers/scaffold.ts builds sandboxes
skills/openscaffold/  the agent skill shipped via `npx skills add`
schema/             generated JSON Schemas (never hand-edit; run `bun run schema`)
docs/               format.md (entry format reference), authoring.md, roadmap.md, plans/
```

Flow: `commands/new|add` load the registry (project, user, remote, bundled origins), `compose` a plan, `render` files into the target, then write the brief and manifest and call `handoff`. `commands/verify` reads the manifest and runs `verify.ts`.

## Conventions

- Output is written for agents. Every read command (`list`, `show`, `validate`, `verify`, plus `new`/`add`) takes `--json`; human output says what to do next. Print through `src/output.ts` (`println`, `printJson`, `warn` to stderr).
- User-facing failures throw `OpenScaffoldError(code, message, hint)` from `src/errors.ts`. `code` is snake_case and stable (it appears in `--json` errors), `hint` tells the reader the next step. Any other thrown error is treated as a bug.
- Commands take their environment through options (`CommonRunOptions`: cwd, home, bundledDir, offline, env, isTTY, hasTool, now, print, spawn) instead of reading globals, so tests inject them.
- Registry entries are version-less. Anything that ages with a tool release goes in prose, not `files/`. See `.claude/rules/registry.md` and `docs/format.md` before editing `registry/`.
- ESM with `.js` import specifiers (NodeNext). Biome formats: 2-space indent, double quotes, width 100.
- Conventional Commits are enforced by lefthook (`feat(cli): ...`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `ci:`, `build:`, `perf:`, `style:`, `revert:`). Pre-commit runs Biome on staged files and `validate registry`; pre-push runs typecheck and tests.
- Prefer the project's existing patterns and dependencies over new ones. Add a dependency only when nothing in the project already covers the need.
- Keep changes scoped to the task. Mention unrelated problems you notice instead of fixing them in the same change.

## Testing

- vitest, integration-style: tests call `runNew`/`runAdd`/`validatePath`/`runVerify` and friends against real temp directories (`mkdtempSync`) and the fixture registries in `tests/fixtures/`, and assert on the files written. `tests/helpers/scaffold.ts` `makeSandbox()` gives an isolated cwd, home, and bundled registry with no network, TTY, or agent launch.
- `tests/cli.test.ts` spawns the real CLI; `tests/hooks.test.ts` runs the agent-ops Claude hooks with JSON on stdin under every bash found (including macOS `/bin/bash` 3.2).
- Set `OPENSCAFFOLD_OFFLINE=1` for tests and validate. The remote registry isn't published yet and 404s; CI sets it too. `.claude/settings.json` sets it for Claude Code sessions.
- Behavior-focused tests against real dependencies where practical. Fake only what crosses the network to third parties, and time (`now`).
- A bug fix starts with a test that reproduces the bug.
- Weakening or skipping a test to get green is a failure, not a fix.

## Error handling

- Expected failures (bad input, unknown id, composition conflict, missing file) throw `OpenScaffoldError` with a hint. `src/cli.ts` is the one place they're printed and turned into exit code 1. `verify` exits 1 on a failed step and 130 when interrupted.
- Never swallow an error. Handle it, or add context and pass it on.
- Log an error once, at the boundary that handles it.

## Debugging

- If a fix hasn't worked after two attempts with no new diagnostic step in between, stop. Write down what you learned, list two or three other root-cause hypotheses, and ask which to pursue. Running a new diagnostic between attempts resets the count.
- Read logs and error output before guessing.
- Add `--json` to see the full structured result or error. `bun run dev new <stack> <tmpdir> --sandbox --no-launch` scaffolds without launching an agent; read the generated `.openscaffold/BRIEF.md` to see what an agent would get.
- The remote registry is cached in `~/.openscaffold/cache/registry` (24h TTL, with backoff after failures); `--offline` or `OPENSCAFFOLD_OFFLINE=1` skips the fetch.

## Build workarounds

None yet.

## Deferred

See `docs/roadmap.md`: more stacks and fragments, third-party registry sources, native adapters for Codex, OpenCode, and Cursor, and the stack directory.

## Pending user actions

- Publish the repo (so `gh:tryopendata/openscaffold/registry#main` resolves) and the npm package. Until then the remote fetch 404s; confirm with `OPENSCAFFOLD_OFFLINE=0 bun run dev list` showing no registry warning.

## Deeper context

Read these only when the task needs them.

| Need | Read |
| --- | --- |
| What the tool does and its commands | `README.md` |
| STACK.md / FRAGMENT.md format, templating, merging, verify | `docs/format.md` |
| How to write a good stack or fragment | `docs/authoring.md` |
| Planned work | `docs/roadmap.md`, `docs/plans/` |
| The skill agents use to drive the CLI | `skills/openscaffold/SKILL.md` |
| Claude Code hooks and settings in this repo | `.claude/README.md` |
