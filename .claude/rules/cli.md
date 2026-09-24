---
paths:
  - "src/**"
---

# CLI conventions

The main reader of this CLI's output is a coding agent. Every change to a command should keep it easy for an agent to act on without guessing.

- **`--json` on every read command.** `list`, `show`, `validate`, `verify`, `new`, and `add` take `--json`. A new command that reports anything takes it too. JSON goes to stdout via `printJson`, one document per run; warnings go to stderr via `warn` so they never corrupt the JSON. `src/cli.ts` detects `--json` from argv so even parse errors come out as `{"error":{"code","message","hint"}}`.
- **Errors are `OpenScaffoldError(code, message, hint)`.** `code` is a stable snake_case identifier (agents and tests match on it). `message` says what went wrong with the concrete value (`no stack named "pyton-react"`). `hint` says the next step, often a command to run (`closeMatches` in `src/registry/index.ts` suggests near misses). Throw it; don't print and exit from inside a command. Anything else that escapes is a bug and shows a stack trace.
- **Human output says what to do next.** End with the next command or action rather than a bare status. Prefer short, plain lines to tables or color.
- **Keep effects injectable.** Commands read cwd, home, env, TTY, tool lookup, time, printing, and process spawning from their options (`CommonRunOptions`), not from globals, so tests don't need mocks.
- **`new` and `add` never run entry commands.** Only `verify` executes commands, and it prints each one before running it. Don't add a code path that executes something from a STACK.md or FRAGMENT.md during scaffolding.
- **New flags or commands** go into `README.md` (Commands table), the guide in `src/commands/guide.ts`, and `skills/openscaffold/SKILL.md` when agents need to know.
