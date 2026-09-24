# Roadmap

v1 ships the CLI, the stack/fragment format, the openscaffold skill, four stacks (`python-react`, `go-cli`, `astro-blog`, `react-router-ai`), and eleven fragments. Everything below is planned follow-up work. Each item should get a GitHub issue once the repo is public; link it here when it does.

## Phase 2: remaining stacks

These are ported from existing projects that already run in production. Each one needs a STACK.md, version-agnostic `files/`, verify steps, and one end-to-end run with a real agent (`new <stack> --sandbox` until `verify` is green) before it ships.

| Stack | Shape | Source to mine |
|---|---|---|
| `mcp-server` | TypeScript MCP server on bun + Hono with streamable HTTP transport, zod tool schemas, one tool per file, auth via protected-resource metadata. Optional `mcp-app-ui` fragment for MCP Apps (React + Vite single-file build). | `~/Projects/opendata/mcp` |
| `slidev-deck` | Slidev decks with a deck registry (`decks.json`), one runner script for dev/build/export/new/check, one file per slide, a local shared addon, screenshot tooling for visual checks. | `~/Projects/opendata/talks` |
| `mobile-expo` | bun workspaces: Expo + Expo Router app, Hono API with a typed client, Drizzle + Postgres, shared zod schemas package, NativeWind, jest-expo + Testing Library, Maestro e2e. | `~/Projects/poker` |
| `claude-plugin-marketplace` | A Claude Code plugin marketplace repo: `.claude-plugin/marketplace.json`, plugins with skills, commands, agents and hooks, validation via `claude plugin validate`, conventional commits. | `~/Projects/claude-configs` |
| `fullstack-ts` | A separate stack from `react-router-ai` (the single-app AI shape, already shipped). wrkhub's shape modernized: bun workspaces with a shared package, Hono API, Drizzle, React Router v7 web app, Biome, vitest + Playwright, a Docker image per service. | `~/Projects/wrkhub` (layout), `~/Projects/poker` (conventions) |

## `react-router-ai` follow-ups

Shipped with a sandbox end-to-end run to a green `verify` (2026-09-24). Still open:

- `docker-deploy` and `posthog` blocks for the stack (both are optional fragments with no stack-specific guidance yet), then a run with `--with docker-deploy,posthog`.
- One run without `--sandbox` to exercise SHA-pinned CI actions and the default preset.
- A live check with a real `OPENROUTER_API_KEY`: model picker, example tool, per-message cost, a 429 with `Retry-After`, history after reload, the extract page.

## Phase 2: fragments

- `auth-clerk`: Clerk on the API (JWT verification against JWKS) and the client, with an offline test path that doesn't mock our own code (see poker's locally generated key pair).
- `otel`: OpenTelemetry traces and metrics, disabled without an endpoint.
- `renovate`: grouped dependency updates, respecting ecosystems that must upgrade together (Expo SDK).
- `claude-github-action`: the Claude Code GitHub Action workflow.
- `mcp-registry`: `server.json` manifest for the MCP registry.
- `mcp-app-ui`: see `mcp-server` above.

## Phase 2: third-party sources

`openscaffold source add <git-url>` for stacks hosted outside the main registry. Requirements from the v1 design review:

- Pin each source to a commit SHA and show the diff on update.
- On first use, list every hook, script, and executable file the source would write, and require confirmation.
- Never auto-launch an agent into a project composed from an untrusted source until it's trusted.
- `list --json` already reports `origin` and `trusted`; untrusted entries must be clearly marked there.

Also in this bucket: `openscaffold create stack|fragment <id>` authoring skeletons, and a Claude plugin marketplace entry that installs the skill.

## Phase 2: agent adapters

v1 ships full native config for Claude Code only; Codex, OpenCode, and Cursor get AGENTS.md. Add `adapters/<agent>/` content to `agent-ops` (and any other fragment with agent config) as each agent's native formats are confirmed from its docs:

- Cursor: project rules and hooks.
- OpenCode: config and plugins.
- Codex: project config.

## Later

- Stack directory: a web app ranking stacks and fragments by usage and verify success, with the same stats exposed in `list --json` for agents. Spec: [plans/2026-09-23-stack-directory.md](plans/2026-09-23-stack-directory.md). The telemetry opt-in vs opt-out decision should be made before the first public npm release, even though the directory ships later.
- Hooks into spec-driven workflows (spec-kit, BMAD) so a scaffolded project can move straight into feature work.
- An optional canary that scaffolds each stack headlessly on a schedule. v1 deliberately leaves compatibility to the agent; revisit if stacks are found to rot in ways an agent can't recover from.
