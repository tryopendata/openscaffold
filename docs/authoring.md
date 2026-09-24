# Writing a stack

The format itself is described in [format.md](format.md). This guide covers how to write a stack that an agent can turn into a working project, and that still works a year from now.

## Start from a project you trust

The best stacks are distilled from a real project that already works: its layout, its test setup, the lint rules you settled on, the Makefile targets you actually use. Go through that project and sort what you find into three piles:

| Pile | Where it goes | Examples |
|---|---|---|
| What the project is made of | `deps`, `tools`, `tags` in frontmatter | fastapi, pytest, ruff, uv |
| How it should be built and why | Prose in the body | layout, conventions, what the linter must enforce, how tests reach the database |
| Files that stay the same across versions | `files/` or `adapters/<agent>/` | `.gitignore`, `.editorconfig`, a Makefile skeleton, agent hooks |

Leave the business logic out. If a section would only make sense for the original project, cut it.

## Put anything that goes stale in prose

The first question for every file you want to ship: would it still be correct after the next major release of the tool that reads it? `tsconfig.json`, `vitest.config.ts`, `.golangci.yml`, `pyproject.toml`, CI workflows, and Dockerfiles all fail that test. Describe what they must do instead:

```markdown
## Tool configuration

- ruff: line length 100; enable pyflakes, pycodestyle, isort, bugbear, pyupgrade,
  simplify, and the security rules; allow asserts in tests only.
- mypy: strict, with the pydantic plugin.
- pytest: asyncio auto mode, strict markers, warnings as errors, random order.
```

The agent writes the actual config for whatever versions it installs, and your intent survives version changes. `openscaffold validate` warns when a version-sensitive filename shows up in `files/`.

The same applies inside prose. "Add Tailwind through its Vite plugin" survives longer than "create tailwind.config.js with a content array." When a statement is only true for some versions, put it under Gotchas along with the condition that makes it true.

## Make Setup an ordered procedure

The Setup section is what the agent does first, so write it as numbered steps:

1. Name the official generator and the directory it runs in (`backend/`, `frontend/`). The CLI has already put files at the project root, so a generator must target a subdirectory, or run in a temp dir whose output the agent merges.
2. Say "non-interactively". Don't name flags: they change between releases, and the agent can look them up.
3. List what to install after the generator, by role.
4. Say which starter files to adapt (the Makefile, `.env.example`) rather than replace.

## Write verify steps that prove the project works

Verify steps are the definition of done. A good set:

- installs dependencies in `setup`;
- runs lint, typecheck, and tests in `check`;
- runs the production build, tagged `prod` so `--sandbox` skips it;
- starts every dev server in `serve` and probes an endpoint that exercises the app (a `/health` route that hits the framework, not a static file);
- calls project commands (`make test`) instead of raw tool invocations, so the steps stay valid when the agent's config differs from what you pictured.

Read ports from `env` (`PORT_API: "8000"`) and use `${PORT_API}` in probes, so someone on a busy machine can move them.

Keep verify fast. Browser e2e suites and coverage gates belong in their own commands (`make e2e`, `make coverage`) that the brief mentions but verify doesn't run.

## Decisions

List the choices the agent should confirm with the user, and state the default in each one: `"Package manager for the frontend (default: bun)"`. Under `--yes` or `--sandbox` the agent uses the defaults without asking, so every decision needs one.

## Fragments

Before putting something in a stack, check whether it belongs in a fragment. Anything that could apply to more than one stack (CI, agent config, a vendor SDK, a database, a deploy target) should be a fragment, with the stack listing it under `fragments.default` or `fragments.optional`.

Rules for fragments:

- A fragment owns its files. If it needs to change a file another entry owns (AGENTS.md, the Makefile, README), describe the change in prose and let the agent make it.
- JSON config that several fragments contribute to must be listed in `merge` by every contributor.
- Set `category` accurately. `--sandbox` drops `deploy` and `release` fragments.
- Put CLIs the fragment needs in `requires_tools`, so a missing tool is reported before handoff instead of halfway through the build.
- Verify step names must not collide with the stack's or other fragments'. Prefix them (`db-up`, `release-check`).
- Don't ship symlinks. `validate` reports them, and an entry from the main registry with a symlink, an unknown template variable, or a malformed conditional block is skipped in favor of the next copy down (usually bundled).
- For guidance that only applies to some stacks, modes, or presets, use conditional blocks; see [Conditional prose](format.md#conditional-prose).

## Test it for real

`openscaffold validate <dir>` catches format and composition errors. It doesn't tell you whether an agent can follow your prose. Before you submit:

```bash
npx openscaffold new <your-stack> /tmp/try-it --sandbox
```

Let an agent run the brief with no help from you, and watch where it hesitates or guesses. Every hesitation points at prose to clarify. Then run the stack once without `--sandbox`, so the `prod` steps and default fragments get exercised too.

## Personal stacks

To keep a stack to yourself, put it in `~/.openscaffold/stacks/<id>/`. To change a built-in stack, copy it there under the same id: yours shadows the built-in one, and `openscaffold list` shows which copy is in use. Fragments you want on every project go in `~/.openscaffold/config.yaml` under `always`.
