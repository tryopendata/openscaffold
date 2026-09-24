---
schema_version: 1
id: react-router-ai
kind: stack
name: React Router AI app (OpenRouter)
description: A React Router app in framework mode with an OpenRouter-backed streaming chat (Vercel AI SDK, useChat, searchable model picker, per-message tokens and cost, fallback models and provider routing), Effect services behind resource routes (typed errors, token-bucket rate limiting, retry and timeout), Effect Schema, Tailwind and shadcn/ui, vitest, and Biome.
tags: [typescript, react, web, ai, llm, effect, openrouter, fullstack]
deps:
  app: [react, react-dom, react-router, "@react-router/node", "@react-router/serve", isbot, effect, ai, "@ai-sdk/react", "@openrouter/ai-sdk-provider", "@openrouter/sdk", tailwindcss, "@tailwindcss/vite", class-variance-authority, lucide-react]
  dev: ["@react-router/dev", vite, "@vitejs/plugin-react", typescript, "@biomejs/biome", vitest, "@effect/vitest", "@vitest/coverage-v8", happy-dom, "@testing-library/react", "@testing-library/jest-dom", "@testing-library/user-event", "@types/node"]
tools: [bun, node, make, git]
decisions:
  - "Node version: the current LTS (default), written to `.node-version` and `engines.node`."
  - "Effect major: the newest stable (default). Add `effect` as a dependency and `@effect/vitest` as a dev dependency in the same step, and check their majors match."
  - "Default model: a cheap current chat model picked from OpenRouter's models list at setup, written to `OPENROUTER_MODEL` in `.env.example` (default)."
  - "OpenRouter routing defaults: no fallback models, no provider sort, provider fallbacks allowed, data collection allowed (default). All of it comes from env, so changing it needs no code edit."
  - "Storage: an in-memory Map (default), or SQLite behind the same ChatStore service when chats must survive a restart."
  - "Auth: none (default); a `CurrentUser` service is the seam for adding it."
  - "Example tool and structured-output example: included (default)."
env:
  PORT_WEB: "5173"
fragments:
  default: [agent-ops, git-hooks, ci-github, effect-schema]
  optional: [posthog, docker-deploy, rr, ce-plugin]
verify:
  - { name: install, phase: setup, run: make install }
  - { name: lint, run: make lint }
  - { name: typecheck, run: make typecheck }
  - { name: test, run: make test }
  - { name: build, run: make build }
  - name: web
    phase: serve
    run: make dev
    expect: { http: "http://localhost:${PORT_WEB}/c/00000000-0000-4000-8000-000000000000", within: 90s }
  - name: readme-filled
    run: "test -s README.md && ! grep -n 'openscaffold:fill' README.md"
---

# React Router AI app (OpenRouter)

One React Router app in framework mode with SSR. The browser talks only to the app's own loaders, actions, and resource routes. Server code is Effect services composed into one runtime, and LLM calls go to OpenRouter through the Vercel AI SDK. The app builds, tests, and renders with no API key; chat just reports that it isn't configured. The root `Makefile` is the entry point for everything.

## Layout

```
Makefile, package.json, bun.lock, .node-version, biome.json, tsconfig.json,
vite.config.ts, vitest.config.ts, react-router.config.ts, components.json, .env.example
app/
  root.tsx, routes.ts, app.css
  routes/
    chat.tsx          "/" and "/c/:chatId"; "/" redirects to a new random-UUID chat id
    api.chat.ts       resource route: the chat action, streams the reply
    api.models.ts     resource route: models list for the picker
    api.extract.ts    resource route: structured-output example
    extract.tsx       small page that drives the extract example
    healthz.ts        {"status":"ok"}; touches no LLM, network, or storage
  schemas/            Effect Schema shared by client and server (see the effect-schema section)
  components/ui/      shadcn components (generated, then owned)
  components/chat/    message list (with usage under each reply), composer, model picker, error + retry
  .server/            server-only code; React Router keeps it out of the client bundle
    runtime.ts        AppLayer and the one ManagedRuntime
    config.ts         every env var, read through Effect Config
    errors.ts         tagged errors
    http.ts           runRoute(): runs a program, maps errors to responses
    openrouter.ts     provider options: fallback models, provider routing, usage accounting
    prompts.ts        default system prompt
    services/         Llm, OpenRouter, ChatStore, RateLimiter, StreamSlots (a Tag + Live layer each)
    tools/            AI SDK tools; one example tool
    extract.ts        the structured-output program
tests/                vitest: server programs, routes, components, the closed-loop chat test
```

## Setup

1. **Generate.** Run the official React Router generator (`bun create react-router`) non-interactively into a temp directory (for example `.rr-init/`), with its default framework-mode template and without git init, install, or its agent/AI skill files (agent-ops owns agent config). Move its files to the root without overwriting what's there: merge its `.gitignore` entries, discard its README, delete its Dockerfile, `.dockerignore`, and any ESLint or Prettier config, set `package.json` `name` to the project slug, then delete the temp dir. Keep SSR on.
2. **Install.** `bun install`. Set `packageManager` in `package.json` to the installed bun version (CI's bun setup reads it), write the current Node LTS major to `.node-version`, and set `engines.node` to match. Add the deps listed above that the template doesn't already have, and keep the template's versions for the ones it has. Check peer ranges before installing (`npm view <pkg> peerDependencies`); see Gotchas for the `@effect/vitest` case.
3. **Lint and format.** Biome, configured per Tool configuration. Remove any other linter or formatter the template brought.
4. **UI.** Tailwind through its Vite plugin if the template didn't set it up. Run shadcn's init non-interactively (check its `--help`: current versions need a style or preset and base-library choice to skip every prompt), check that `components.json` aliases point into `app/`, then add the components the chat needs: button, textarea, scroll-area, command, popover, badge, alert, skeleton. Let it add whatever utility and runtime packages it wants (they change between releases), and remove any web-font links or theme blocks the template left that the shadcn theme replaces.
5. **Server.** Write `app/.server/` per Conventions: config, errors, runtime, `runRoute`, the services, the example tool, and the extract program.
6. **Routes and UI.** The chat page and components, `api.chat`, `api.models`, `api.extract` with its page, and `healthz`.
7. **Tests** per Testing, including the closed-loop chat test. Fill the README's `openscaffold:fill` markers, and pick the default model for `.env.example` from OpenRouter's public models list.
8. Run `openscaffold verify` until it passes.

## Conventions

### Server structure

- **Services.** Each service in `.server/services/` is a `Context.Tag` plus a Live layer. `runtime.ts` composes them into one `AppLayer` and builds one `ManagedRuntime` from it. The runtime is settable: `runRoute` reads the current runtime, and tests replace it with one built from test layers (`setRuntimeForTests`, or the same idea under another name). In dev, Vite re-evaluates `runtime.ts` on edit, so dispose the previous runtime (kept on `globalThis`) before building the new one. That keeps service edits live without leaking the old runtime.
- **Config.** `config.ts` reads every env var through Effect Config: `OPENROUTER_API_KEY` as an optional redacted value, `OPENROUTER_MODEL`, `SYSTEM_PROMPT` (falling back to `prompts.ts`), the routing settings, and the limits (max input characters, max messages per request, max output tokens, max tool steps, rate-limit capacity and refill rate, max concurrent streams, max stream duration). Nothing else reads `process.env`.
- **Errors.** `errors.ts` defines tagged errors: `LlmNotConfigured` (503), `BadRequest` (400), `UnsupportedMediaType` (415), `UnknownModel` (400), `RateLimited` (429, carrying the retry delay), `UpstreamUnavailable` (502), and `InvalidModelOutput` (502, structured output that fails its schema). `runRoute(request, program)` runs the program on the current runtime and maps each tagged error to its status with a JSON body `{ "message": ... }`. A `RateLimited` response also sets `Retry-After`. Anything else is a defect: log it once and return a generic 500.
- **Thin routes.** A loader or action decodes its input with a schema, calls one program through `runRoute`, and returns data. Components never import Effect. Nothing under `.server/` is imported by client code.
- **Logging.** Effect's logger: JSON in production, pretty in dev.

### Chat request: who owns what

Effect and the AI SDK each own one part of a chat request. Keep them apart.

- **Effect owns everything before the stream starts**: reject non-JSON content types, decode the body, check the key is configured, apply the limits, resolve the model, take a stream slot, and load the chat's history. Failures here become HTTP errors through `runRoute`. A full set of stream slots is a 429 with a short `Retry-After`, like the rate limiter.
- **History lives on the server.** The client sends only the new message (configure the `useChat` transport's request preparation to do that), and the action appends it to the stored history, truncating first on regenerate. "Max messages" is then a per-chat cap, enforced with a 400. If you validate the incoming UI messages with the AI SDK's validator and a metadata schema, the metadata schema must accept `undefined`: user messages carry none.
- **The AI SDK owns the stream.** Call `streamText` with the OpenRouter model, the system prompt (its option name changed across majors), the tools, a max-steps stop condition from Config, max output tokens, and `abortSignal: AbortSignal.any([request.signal, AbortSignal.timeout(maxStreamDuration)])`. The SDK's own retries cover opening the stream, so don't wrap `streamText` in Effect retry or timeout. Upstream errors after the response has started arrive inside the stream: map them to user-safe text in the stream response's `onError`, since the default hides everything.
- **Work that outlives the returned Response** runs from the SDK's end-of-stream, error, and abort callbacks (whatever the installed major calls them) through `runtime.runFork`, with its own logging, because the request's Effect has already completed. Callbacks typed to return `void` or a promise must not return the forked fiber. That covers releasing the stream slot (exactly once, guarded), saving the messages, and the request log line.
- **Effect retry and timeout** are for non-streaming calls: the models list, and the extract program's structured-output call (called with the SDK's own retries set to 0, so only one retry layer exists).

### Chat flow

- `/` redirects to `/c/<random UUID>`. The chat loader returns that chat's stored messages, which become `useChat`'s initial messages. The composer sends the picked model id in the request body.
- **Saving.** The UI-message stream response's finish callback receives the original messages plus the new assistant message. Write the whole list to ChatStore there. On abort, including a client disconnect (newer majors report the two separately), save the partial reply with `interrupted: true` in its message metadata, so a reload shows what the user saw.
- **ChatStore** is a Tag with `get(chatId)` and `save(chatId, messages)`. The Live layer is a Map, kept on `globalThis` in dev so edits don't wipe chats. SQLite, if chosen, is another layer behind the same Tag. Chats have no owner: anyone with the URL can read one. AGENTS.md says so.
- **Models.** `api.models` returns the models list from the OpenRouter service (id, name, provider, context length, prices), fetched client-side so the chat page never waits on it. The picker is a shadcn Command combobox with search, grouped by provider. When the list can't be fetched (no network), it shows only the default model. A requested model id that isn't in the list returns 400 `UnknownModel`. `OPENROUTER_MODEL` is used only when the request names no model.
- **Usage and cost.** Usage accounting is turned on in the OpenRouter provider options. OpenRouter's cost and the serving provider arrive in the provider metadata of each step's finish part, and the served model id in that step's response metadata; the final finish part carries only total token usage. Collect across steps and attach the totals to the assistant message as typed message metadata (a schema in `app/schemas/`) when the stream finishes. The stream response's message-metadata hook may be called for every part, and anything it returns emits a metadata chunk, so return nothing except on the parts you mean. The message list shows the totals under each reply.
- **Errors in the UI.** When the action returns non-2xx, `useChat`'s error holds the raw body. Parse the `{ message }` JSON, show it in an alert, and offer a retry. With no key, the alert says to set `OPENROUTER_API_KEY` in `.env`.

### OpenRouter

- `openrouter.ts` builds the provider options from Config: fallback models (OpenRouter's `models` array), provider routing (`sort` by price, throughput, or latency; `allow_fallbacks`; data collection and zero-data-retention preferences), and usage accounting. Pass them through the provider's settings or its extra-body option, whichever the installed `@openrouter/ai-sdk-provider` exposes.
- The OpenRouter service wraps `@openrouter/sdk` for the models list (and later credits or key info). The list may be paginated: iterate every page. Turn off the SDK's own retries so Effect's retry is the only one, and cache the list in memory with a TTL, with Effect retry and timeout around the fetch. The models endpoint needs no key. If the model type has no provider field, derive the provider from the id prefix (`openai/...`).
- **Request log line.** One structured line per chat request from the finish callback (`Effect.logInfo` with annotations): chat id, requested model, the model and provider that served it (from the response metadata), time to first token (timestamp the first chunk), input and output tokens, cost, finish reason, and whether it was aborted.

### Rate limiting

- `RateLimiter` is a Tag with `check(key)` that returns either allowed or a retry delay. The Live layer is an in-memory token bucket (GCRA is fine too) with capacity and refill rate from Config, state kept on `globalThis` in dev so hot reload doesn't reset it. Use a token bucket, not a fixed window: a fixed window lets a client burst to twice the limit across a window boundary.
- One `rateLimitKey(request)` function picks the key. It returns `"global"` for now, and a per-user or per-API-key limit is a change to that function. Making it distributed means another layer (Redis, say) behind the same Tag.
- `StreamSlots` caps concurrent streams separately, as the abuse backstop.
- Put "set a credit limit on the OpenRouter key" under Pending user actions. It's the real spend guardrail for an endpoint without auth.

### Tools and structured output

- Tool input schemas are Effect Schemas converted with `JSONSchema.make` and passed to the AI SDK's `jsonSchema()` helper, with a validate function built on the schema's decoder. Effect's Standard Schema adapter carries no JSON Schema converter, so on its own it can't describe a tool to the model (the AI SDK accepts Standard Schema only when it also exposes JSON Schema). Give tool and output schemas a `title`/`description`, not an `identifier`: an identifier makes `JSONSchema.make` emit a top-level `$ref`.
- The example tool is small and deterministic (the current time in a given IANA time zone, say), so tests can assert its result.
- `extract.ts` defines an Effect Schema (for example contact details pulled from free text), converts it the same way, asks for structured output (`generateObject`, or `generateText` with an object output where `generateObject` is deprecated), and decodes the result with the schema before returning it; a failed decode is `InvalidModelOutput`. The model's output is a trust boundary.

### Env

The Makefile runs everything through `bun run <script>`, and bun loads `.env` into the script's environment, which is where Effect Config reads it. Vite puts only `VITE_`-prefixed values into `import.meta.env`, never into server `process.env`. `make start` maps `PORT_WEB` to the `PORT` that `react-router-serve` reads.

## Tool configuration

- **package.json scripts**: `dev` (`react-router dev`), `build`, `start` (`react-router-serve` on the build), `typecheck` (`react-router typegen && tsc`), `lint` (`biome check .`), `format` (`biome check --write .`), `test` (`vitest run`). The Makefile calls these.
- **Biome**: start from `biome init`'s output (the config schema changes between majors), then add recommended rules plus `useImportType`, `useExportType`, `noUnusedImports`, and `useConst` as errors. Enable its Tailwind directive parsing for CSS. 2-space indent, width 100, organized imports. Ignore `build/`, `.react-router/`, and coverage. shadcn's generated components are owned source and get linted too; fix or narrowly suppress what the recommended rules flag in them.
- **TypeScript**: strict, plus `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, and `noEmit`; bundler module resolution; `~/*` points at `app/*`; include React Router's generated route types.
- **Vitest**: its own `vitest.config.ts` with the React plugin (not the React Router plugin), `node` by default and `happy-dom` for component tests (a per-file environment comment, or projects), a setup file with jest-dom matchers and Testing Library cleanup, the `~` alias, and `OPENROUTER_API_KEY` set to `""` in `test.env` so no test can reach the network by accident. v8 coverage over `app/`, excluding `components/ui/`.
- **React Router**: `ssr: true`. Routes are listed explicitly in `app/routes.ts`.

## Testing

Tests never touch the network. The fakes are at the third-party boundary only.

- **Server programs** run with `@effect/vitest` against test layers. ChatStore, RateLimiter, and StreamSlots use their real in-memory layers. The LLM is the AI SDK's mock language model (from `ai/test`), injected through the Llm layer. `@openrouter/sdk` and the OpenRouter provider are pointed at a local stub HTTP server through their base-URL or fetch options. Nothing is module-mocked.
- **Closed-loop chat test (required).** Render the chat component, route its transport's `fetch` into the real `api.chat` action on a test runtime (mock model, real store), type a message, and assert that the streamed text and the example tool's result appear in the DOM. This is the check that the server's stream format and the client's `useChat` agree, which is what breaks across AI SDK majors. Two snags: happy-dom replaces `fetch` in server code too and enforces same-origin rules, so disable its same-origin policy for that file (an environment option) or the stub-server calls fail; and components that render router links need `createRoutesStub`.
- **Route tests** call loaders and actions with a real `Request`: no key → 503, bad body → 400, non-JSON content type → 415, over the limit → 429 with `Retry-After`, unknown model → 400, no model → the `OPENROUTER_MODEL` default.
- **Rate limiter** with `TestClock`: bursts up to capacity then rejects, refills over time, separate keys have separate buckets, and there's no double burst across a boundary.
- **OpenRouter request shape**: with the real provider pointed at the stub server, assert that the captured request body carries the fallback `models`, the `provider` routing object, and usage accounting, and that usage in the stub's response ends up in message metadata.
- **Persistence**: after a finished reply the store holds both turns. After an abort it holds the partial reply marked interrupted.
- **Structured output**: valid mock output decodes, invalid output is a typed error, and the retry schedule works under `TestClock`. The models-list retry is tested the same way.
- `make test` stays fast. `make coverage` adds the report.

## Commands

The shipped Makefile (`make help`): install, dev, start, lint, format, typecheck, test, coverage, build, clean. Adapt the recipes and keep the names. Mirror them in AGENTS.md.

## Gotchas

- Trust the installed packages' type definitions over memory. The AI SDK changed its chat and streaming APIs across majors (`useChat` input handling, transports, `maxSteps` versus stop conditions, tool `parameters` versus input schemas, the stream response helpers). If an API this brief implies doesn't exist or is marked deprecated, use its replacement from the installed package.
- `@openrouter/ai-sdk-provider` supports specific `ai` majors. If the latest of each don't fit together, install the provider release that matches the installed `ai`, or step `ai` down, and record it under Build workarounds.
- Never install `@effect/schema` (it's part of `effect` now). Keep `@effect/vitest` on the same major as `effect`. Effect v3 and v4 put some modules in different places: check the installed version's docs.
- If the `@effect/vitest` release for the installed `effect` major caps `vitest` below the latest (it happens when `effect`'s next major is still prerelease), install `vitest` and `@vitest/coverage-v8` at the range it accepts, and a `@vitejs/plugin-react` that supports the Vite version that vitest uses (it can differ from the app's Vite). Record it under Build workarounds. A type cast on the plugin in `vitest.config.ts` is acceptable there.
- `@openrouter/ai-sdk-provider` may pull in `zod` as a peer. That's expected and doesn't mean the app should use zod.
- Verify's `web` probe requests a fixed chat URL (`/c/00000000-0000-4000-8000-000000000000`, a valid UUID with no stored messages) because it doesn't follow redirects. That page must render with the key unset and the models list unreachable, and the chat id schema must accept that UUID.
- `tsc` fails on missing `./+types/...` until `react-router typegen` runs; `.react-router/` is gitignored.
- Bare `vitest` is watch mode in a TTY; scripts use `vitest run`. Never add `--bun` to vitest or React Router commands: they run on Node.
- Importing anything under `.server/` from client code fails the build. `make build` is in verify for that reason.
- If SQLite is chosen and its driver needs a native build, add it to `trustedDependencies` so bun runs its install script.
- For server-wide middleware (CORS, security headers, request logging across every route), `react-router-hono-server` wraps the app in Hono. Add it only when that's needed; it changes the dev and start commands.
