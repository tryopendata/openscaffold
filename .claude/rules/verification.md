---
paths:
  - "src/**"
  - "tests/**"
  - "registry/**"
  - "skills/**"
  - "scripts/**"
  - "package.json"
  - "biome.json"
  - "tsconfig.json"
  - "tsup.config.ts"
  - "vitest.config.ts"
---

# Verification before done

Before saying a change is done, run `bun run check` (lint, typecheck, test, validate) and read its output. It is the same gate CI runs, minus the build. Also run `bun run build && node dist/cli.js --version` when you touched `src/cli.ts`, `src/version.ts`, the build config, or anything that resolves paths relative to the package (`PACKAGE_ROOT`, `BUNDLED_REGISTRY`): tests run from `src/`, and only the built bundle proves the published entry point works under Node.

## A clean exit code is not a pass

- Check that the work actually happened. A `-t` filter that matches nothing exits 0 with every test skipped; `validate` prints how many stacks and fragments it read. Read the counts, not just the exit status.
- When the real work is done by a subprocess (a scaffolded project's `verify`, a hook), check its output, not the wrapper's status.
- Don't report a cause you didn't observe. If you say "the registry fetch failed", have the error output to show.

## Prove new tests

A regression test has to fail without the fix. Reintroduce the bug by editing the source, run the one test and see it go red with the expected message, then restore the fix. A test that passes either way isn't testing the fix.

## User-visible changes

- CLI behavior: run the command for real (`bun run dev <cmd>`, with and without `--json`) and read the output as an agent would. Error paths should print `error:` plus a `hint:` that says what to do next.
- Scaffolding, brief, or registry content: scaffold into a scratch dir (`/e2e <stack>`) and read the generated `BRIEF.md` and file tree.
- Docs that list commands or flags (`README.md`, `AGENTS.md`, `skills/openscaffold/SKILL.md`, `docs/format.md`, the guide in `src/commands/guide.ts`) must still match the CLI. Update them in the same change.

## After committing

lefthook runs Biome on staged files and `validate registry` on commit, and typecheck plus tests on push. Check `git status` after a hook-running commit; a hook that rewrites files can leave part of the change unstaged.
