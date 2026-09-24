---
paths:
  - "tests/**"
  - "src/**/*.ts"
---

# Testing

Follow the `ce:writing-tests` skill (Testing Trophy: mostly integration, real dependencies, behavior over implementation). What that means here:

## Test through the real code paths

- Drive behavior through the same entry points the CLI uses: `runNew`, `runAdd`, `validatePath`, `runVerify`, `compose`, `loadRegistry`, and assert on the files written, the brief, the manifest, and the returned result. `tests/cli.test.ts` spawns `bun src/cli.ts` for argument parsing, exit codes, and `--json` error shapes.
- Pure-function unit tests are for logic with many cases (conditionals parsing, template rendering, deep merge, slugify). Don't unit-test a function that an integration test already covers end to end.
- Use real temp directories: `mkdtempSync(join(tmpdir(), "os-<area>-"))`, removed in `afterEach`/`afterAll`. For `new`/`add`, use `makeSandbox()` from `tests/helpers/scaffold.ts`: isolated cwd, home, and a copy of the scaffold fixture registry, offline, no TTY, and a `spawn` that throws if anything tries to launch an agent.
- Registry fixtures live in `tests/fixtures/registry-{good,bad,compose,scaffold}/`. Add the smallest entry that exercises the case to a fixture instead of depending on the real `registry/`, so editing a real stack can't break an unrelated test. Tests that are about the real content (`hooks.test.ts` runs the shipped agent-ops hooks; validate over `registry/`) are the exception.

## Fake only the edges

- Never `vi.mock` a module from `src/`. Code takes its environment through options (`CommonRunOptions`: `cwd`, `home`, `env`, `isTTY`, `hasTool`, `now`, `print`, `warn`, `spawn`; `LoadRegistryOptions.fetchRemote`), so pass a fake there. If a test needs a seam that doesn't exist, add the option to the production code rather than mocking.
- The network (the remote registry fetch) and time (`now`) are the things to fake. Env goes through `vi.stubEnv` or the `env` option, never by mutating `process.env` without restoring it.
- Run tests with `OPENSCAFFOLD_OFFLINE=1` (Claude Code sessions here set it in `.claude/settings.json`; CI sets it too). The remote registry 404s until the repo is published, and no test may depend on it.

## Waiting

- Poll for a condition with a deadline; don't `sleep` a fixed time and hope. A fixed sleep is either flaky or slow. `verify.ts` serve probes are the model: poll until the condition holds or `within` elapses.
- A test that checks something did *not* happen needs a positive signal that the thing had its chance (a marker file, a completed event), not a longer sleep.

## Hook tests

`tests/hooks.test.ts` runs the agent-ops hooks with JSON on stdin under every bash it finds, including macOS `/bin/bash` 3.2. For a new destructive or secret pattern, add one case that must be denied and one near miss that must pass.

## Snapshots and running

- `tests/__snapshots__/brief.test.ts.snap` pins the brief. Update with `bun run test tests/brief.test.ts -u` only when the brief change is intended, and read the snapshot diff before keeping it.
- Iterate on one file (`bun run test tests/<file>.test.ts`, `-t "<name>"` for one test), then run the whole suite once the change is done.
- A bug fix starts with a failing test. Confirm it fails for the right reason before fixing, and never weaken an assertion or add `.skip` to get green.
