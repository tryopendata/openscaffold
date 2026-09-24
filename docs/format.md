# Stack and fragment format

This is the reference for writing openscaffold stacks and fragments. The zod schemas in `src/schema/index.ts` are the source of truth; `openscaffold validate <path>` checks everything described here.

## The idea in one paragraph

A stack says what a project is built from and how it should be set up. It does not say which versions. The CLI copies a few version-agnostic files, writes a brief, and hands off to a coding agent. The agent runs the official generators, installs the latest compatible versions, writes tool config for those versions, and loops until `openscaffold verify` passes. Anything that would pin the project to a point in time belongs in prose the agent interprets, not in files the CLI copies.

## Two kinds of entry

A stack is a complete project type (`python-react`, `go-cli`, `astro-blog`). A fragment is a smaller piece that composes into stacks: CI, agent config, a vendor SDK, a database service, a deploy target. Fragments are the only way to compose. There are no layers or partial stacks.

Both live in a directory named after their id:

```
registry/
  stacks/<id>/
    STACK.md              required: frontmatter + agent guidance
    files/                optional: copied into the project root for every agent
    adapters/<agent>/     optional: copied only when <agent> is a target (claude, codex, opencode, cursor)
  fragments/<id>/
    FRAGMENT.md
    files/
    adapters/<agent>/
```

User-owned entries use the same layout under `~/.openscaffold/{stacks,fragments}/` or a project's `./.openscaffold/{stacks,fragments}/`.

## Frontmatter

Shared fields:

| Field | Type | Notes |
|---|---|---|
| `schema_version` | int | Currently `1`. The CLI ignores registry entries with a newer major and falls back to its bundled copy. |
| `id` | kebab-case | Must match the directory name. |
| `kind` | `stack` \| `fragment` | |
| `name` | string | Human title. |
| `description` | string | One sentence. Agents read this from `openscaffold list --json` to pick a stack, so say what it's for. |
| `tags` | string[] | Languages, domains (`python`, `web`, `cli`, `api`). Used for `applies_to` matching and for agents choosing. |
| `deps` | map of role -> names | Package names only, grouped by role (`backend`, `frontend-dev`, ...). Never versions. |
| `tools` | string[] | CLIs the agent needs (`uv`, `bun`, `go`, `make`). |
| `decisions` | string[] | Questions the agent confirms with the user unless `--yes`/`--sandbox`. Each one should state the default. Quote any entry containing `: ` or YAML reads it as a mapping. |
| `env` | map | Defaults written to the manifest and passed to `verify` (e.g. `PORT_API: "8000"`). Use env vars for ports so they can be moved on a busy machine. |
| `verify` | step[] | See Verify. |
| `merge` | string[] | Output paths this entry contributes that are JSON and may be deep-merged with other contributors. |

Stack only:

| Field | Notes |
|---|---|
| `fragments.default` | Fragment ids applied unless `--without`'d. Vendors can be defaults (PostHog on a web stack). |
| `fragments.optional` | Fragment ids that are known to fit, surfaced to the agent and via `show`. Any compatible fragment can still be added with `--with`. |

Fragment only:

| Field | Notes |
|---|---|
| `category` | `agent-ops`, `ci`, `deploy`, `release`, `service`, `vendor`, `tooling`. `--sandbox` drops `deploy` and `release`. |
| `applies_to` | Stack ids or tags the fragment fits. Empty means anywhere. |
| `requires` | Fragment ids that must also be present (pulled in automatically). |
| `conflicts` | Fragment ids that cannot be combined with this one (composition error). |
| `requires_tools` | CLIs the fragment needs at runtime (`docker` for `postgres`). Missing ones are reported before handoff. |

## Body: guidance prose

The markdown body is written for the agent that will build the project. It is copied into the brief. Use these sections for stacks (skip any that don't apply):

- `## Layout`: the directory skeleton and what goes where.
- `## Setup`: which official generators to run and in what order. Say "non-interactively" and name the target subdirectory; don't name flags that may change.
- `## Conventions`: patterns the codebase should follow (error handling, config loading, module boundaries).
- `## Tool configuration`: what each tool's config must enforce, described as intent. "Enable govet, errcheck, staticcheck, gosec, revive; fail on new issues only." Not a pasted config file.
- `## Testing`: test layers, what's real and what's mocked, coverage expectations, how tests are invoked.
- `## Commands`: the commands the project must expose (usually Makefile targets or package scripts) and what each does. Verify steps call these.
- `## Gotchas`: known traps with the current ecosystem, phrased so they stay true across versions.

Fragments use whatever headings fit, usually `## What to add`, `## Tool configuration`, `## Verify`, and an `## AGENTS.md` section describing what the fragment contributes to the project's agent instructions.

Write intent, not version-specific instructions. "Configure Tailwind through its Vite plugin" ages better than "edit tailwind.config.js". If a statement would be wrong after the next major release of a tool, rephrase it or move it into Gotchas with the condition that makes it true.

### Conditional prose

Prose that only applies to some projects (a fragment's notes for one stack, instructions that only matter for `add`) goes in a conditional block, so briefs for other projects don't carry it:

```markdown
<!-- openscaffold:when stack=go-cli,python-react -->
Wire the client into the Makefile's `test` target.
<!-- openscaffold:end -->
```

| Key | Matches |
|---|---|
| `stack` | The stack id. |
| `tag` | Any of the stack's tags. |
| `mode` | `new` or `add`. |
| `preset` | `default` or `sandbox`. |
| `with` | A fragment id present in the composed project (for `add`, including fragments applied earlier). |

Commas mean OR within a key (`stack=go-cli,python-react`). Several keys on one marker must all match (`tag=web preset=sandbox`). Blocks don't nest. When the brief is written, a block whose condition doesn't match is removed entirely, and a matching block loses only its two marker lines. Each marker must be on its own line. `validate` reports unknown keys, bad `mode`/`preset` values, nesting, and unclosed blocks. `show` prints the body unfiltered.

## files/ and adapters/

Only version-agnostic content goes in `files/`: an AGENTS.md skeleton, agent hooks and settings, lefthook config, `.editorconfig`, `.gitignore`, `.env.example`, docs skeletons, Makefile targets that call tools by name. Tool configs whose schema changes between releases (`.golangci.yml`, `vitest.config.ts`, `tsconfig.json`, `pyproject.toml`, `astro.config.mjs`, CI workflows, Dockerfiles) are described in prose instead. `validate` warns when it sees a known version-sensitive filename in `files/`.

`adapters/<agent>/` holds files that only make sense for one agent: `.claude/settings.json` and hooks for `claude`, `.cursor/rules/` for `cursor`, and so on. AGENTS.md is the canonical instruction file for every agent; an agent with no adapter still gets it.

### Templating

Only files whose name ends in `.tmpl` are rendered; the suffix is stripped on output. Every other file is copied byte for byte, so `${{ secrets.X }}` in a workflow or `{{ .Version }}` in a Go template is safe.

Available variables: `{{project_name}}`, `{{project_slug}}`, `{{package_scope}}`, `{{author}}`, `{{year}}`. An unknown variable in a `.tmpl` file is an error. There are no conditionals or loops; anything conditional belongs in prose for the agent.

### Ownership and merging

Each output path has exactly one owner. If two entries write the same path, composition fails, unless every contributor lists that path in its `merge` field, in which case the files are parsed as JSON and deep-merged in composition order (objects merge recursively, arrays concatenate with duplicates removed, later scalars win). This is how `agent-ops`, `rr`, and `ce-plugin` all contribute to `.claude/settings.json`.

Shared prose files (AGENTS.md sections, README, Makefile targets) are never merged by the CLI. The owning fragment ships the skeleton; other fragments describe their additions in prose and the agent writes them.

On `openscaffold add` against an existing repo, files that already exist are never overwritten. openscaffold's version of each one is written to `.openscaffold/incoming/<path>`, and the brief lists them as "merge needed" so the agent can reconcile the two and then delete `incoming/`.

## Verify

`openscaffold verify` is how a project proves it is ready to work in. Steps come from the stack first, then from fragments in composition order. Step names must be unique across the composed project.

```yaml
verify:
  - { name: install, phase: setup, run: make install }
  - { name: lint, run: make lint }
  - { name: test, run: make test }
  - { name: build, run: make build, tags: [prod] }
  - name: api
    phase: serve
    run: make dev-api
    expect: { http: "http://localhost:${PORT_API}/health", within: 90s }
```

| Field | Notes |
|---|---|
| `name` | kebab-case, unique. |
| `run` | Shell command, run from the project root or `cwd`. Prefer calling a project command (`make test`) over raw tool invocations, so the command stays correct when the agent's config differs from what you imagined. |
| `cwd` | Relative directory. |
| `phase` | `setup` (install deps, start services), `check` (default: lint, typecheck, test, build), `serve` (start a dev server and probe it), `teardown` (stop what setup started). Run in that order. |
| `tags` | `prod` marks steps skipped under `--sandbox` (production builds, image builds). |
| `expect.http` | Required for `serve`. The URL is polled until it returns a non-5xx status or `within` elapses. `${VAR}` expands from `env`. |

Serve steps run in their own process group, and the whole group is killed after the probe. Teardown steps always run, even when earlier steps fail.

## Trust

Bundled entries, the main registry (reviewed by PR), and your own `~/.openscaffold` and `./.openscaffold` are trusted. The exception is a `./.openscaffold` entry that shadows a bundled or registry id: a cloned repo can ship one, so it produces a warning and is marked untrusted (`trusted: false` in `list --json` and `show --json`). When any composed entry is untrusted, `new` and `add` never auto-launch an agent; they print the brief path and the instruction instead. `new` and `add` never run commands from an entry. `verify` runs the commands in the project's `manifest.yaml` and prints each one before running it.
