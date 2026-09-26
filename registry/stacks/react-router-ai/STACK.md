---
schema_version: 1
id: react-router-ai
kind: stack
name: React Router AI app (OpenRouter)
description: A React Router app in framework mode with an OpenRouter-backed streaming chat (Vercel AI SDK, useChat, searchable model picker, per-message tokens and cost, fallback models and provider routing), Effect services behind resource routes (typed errors, token-bucket rate limiting, retry and timeout), Effect Schema, Tailwind and shadcn/ui with a dark design system, structured dev logs for agents, vitest, a Playwright smoke, and Biome.
tags: [typescript, react, web, ai, llm, effect, openrouter, fullstack]
deps:
  app: [react, react-dom, react-router, "@react-router/node", "@react-router/serve", isbot, effect, ai, "@ai-sdk/react", "@openrouter/ai-sdk-provider", "@openrouter/sdk", tailwindcss, "@tailwindcss/vite", class-variance-authority, lucide-react, "@fontsource-variable/inter", "@fontsource-variable/jetbrains-mono"]
  dev: ["@react-router/dev", vite, "@vitejs/plugin-react", typescript, "@biomejs/biome", vitest, "@effect/vitest", "@vitest/coverage-v8", happy-dom, "@testing-library/react", "@testing-library/jest-dom", "@testing-library/user-event", "@types/node", "@playwright/test"]
tools: [bun, node, git, perl, curl]
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
merge: [.claude/settings.json]
fragments:
  default: [agent-ops, git-hooks, ci-github, effect-schema]
  optional: [posthog, rr, ce-plugin]
verify:
  - { name: install, phase: setup, run: bun install }
  - { name: lint, run: bun run lint }
  - { name: typecheck, run: bun run typecheck }
  - { name: test, run: bun run test }
  - { name: build, run: bun run build }
  - name: web
    phase: serve
    run: "bun run dev:server --port ${PORT_WEB} --strictPort"
    expect: { http: "http://localhost:${PORT_WEB}/c/00000000-0000-4000-8000-000000000000", within: 90s }
  - name: readme-filled
    run: "test -s README.md && ! grep -n 'openscaffold:fill' README.md"
---

# React Router AI app (OpenRouter)

One React Router app in framework mode with SSR. The browser talks only to the app's own loaders, actions, and resource routes. Server code is Effect services composed into one runtime, and LLM calls go to OpenRouter through the Vercel AI SDK. The app builds, tests, and renders with no API key; chat just reports that it isn't configured. The `package.json` scripts are the entry point for everything (no Makefile), and the dev server keeps its logs on disk so an agent reads the same output a person sees.

## Layout

```
package.json, bun.lock, .node-version, biome.json, tsconfig.json, vite.config.ts,
vitest.config.ts, playwright.config.ts, react-router.config.ts, components.json,
.env.example, DESIGN.md (shipped), .vscode/ (shipped)
biome-plugins/styling.grit   shipped: the style rules Biome enforces (see Design system)
scripts/              shipped: dev.sh (`bun run dev`), dev-bg.sh (`dev:bg`/`dev:stop`), prepare.sh
logs/                 written by `bun run dev`: dev.log, server.jsonl, dev.pid (gitignored)
app/
  root.tsx, routes.ts, app.css
  routes/
    chat.tsx          "/" and "/c/:chatId"; "/" redirects to a new random-UUID chat id
    api.chat.ts       resource route: the chat action, streams the reply
    api.models.ts     resource route: models list for the picker
    api.extract.ts    resource route: structured-output example
    api.chats.$chatId.export.ts   resource route: a stored chat as a Markdown download
    extract.tsx       small page that drives the extract example
    healthz.ts        {"status":"ok"}; touches no LLM or storage
  schemas/            Effect Schema shared by client and server, one file per domain (chat, models,
                      extract, tools), re-exported from index.ts (see the effect-schema section)
  lib/                chat.ts (ChatUIMessage, the ChatTools type map, error parsing), utils.ts
  components/ui/      shadcn components (generated, then owned)
  components/chat/    chat, message-list (MessageParts; usage under each reply), tool-step, composer,
                      model-picker, export-actions (Export + Copy as Markdown)
  components/         page-header (PageHeader, HeaderLink), prompt-card, error-row: shared by chat
                      and extract; extract-form (the extract page's form)
  .server/            server-only code; React Router keeps it out of the client bundle
    runtime.ts        AppLayer, the AppServices union, and the one ManagedRuntime
    config.ts         every env var, read through Effect Config, including the log config
    logging.ts        the log record shape, terminal and JSON formats, the dev log file
    errors.ts         tagged errors and statusFor (their HTTP statuses)
    http.ts           runRoute / runData, readJsonBody, decodeInput, enforceRateLimit
    chat.ts           the chat action program and the chat page loader program
    export.ts         a stored chat as Markdown
    models.ts         models list and model resolution
    openrouter.ts     provider options: fallback models, provider routing, usage accounting
    prompts.ts        DEFAULT_SYSTEM_PROMPT
    services/         Llm, OpenRouter, ChatStore, RateLimiter, StreamSlots (a Tag + Live layer each)
    tools/            index.ts (makeTools, ToolDeps, the currentTime example tool), schema.ts (toAiSchema)
    extract.ts        the structured-output program
tests/
  helpers/            runtime.ts (makeTestLayer, useTestRuntime), stub-openrouter.ts
                      (startStubOpenRouter), mock-model.ts (mock models, toolCallReply)
  chat-routes.test.ts, chat-closed-loop.test.tsx, chat-export.test.ts, extract.test.ts,
  tools.test.ts, message-list.test.tsx, logging.test.ts, ... (one file per area)
e2e/                  chat.spec.ts (the Playwright smoke), stub-server.ts
```

The Claude Code rules and commands name these files and exports (`makeTestLayer`, `runData`, `toolCallReply`, `tests/chat-export.test.ts`, ...). Use these names, or update the `.claude/` files that mention them in the same change.

## Setup

1. **Generate.** Run the official React Router generator (`bun create react-router`) non-interactively into a temp directory (for example `.rr-init/`), with its default framework-mode template and without git init, install, or its agent/AI skill files (agent-ops owns agent config). Move its files to the root without overwriting what's there: merge its `.gitignore` entries, discard its README, delete its Dockerfile, `.dockerignore`, and any ESLint or Prettier config, set `package.json` `name` to the project slug, then delete the temp dir. Keep SSR on.
2. **Install.** `bun install`. Set `packageManager` in `package.json` to the installed bun version (CI's bun setup reads it), write the current Node LTS major to `.node-version`, and set `engines.node` to match. Add the deps listed above that the template doesn't already have, and keep the template's versions for the ones it has. Check peer ranges before installing (`npm view <pkg> peerDependencies`); see Gotchas for the `@effect/vitest` case.
3. **Lint and format.** Biome, configured per Tool configuration. Remove any other linter or formatter the template brought.
4. **UI.** Tailwind through its Vite plugin if the template didn't set it up. Run shadcn's init non-interactively (check its `--help`: current versions need a style or preset and base-library choice to skip every prompt), check that `components.json` aliases point into `app/`, then add the components the chat needs: button, textarea, command, popover, tooltip, alert, and whatever those pull in (input-group, dialog). Remove any you end up not using. Let it add whatever utility and runtime packages it wants (they change between releases), and remove any web-font links or theme blocks the template left that the shadcn theme replaces.
5. **Scripts.** Add the package.json scripts per Commands. `scripts/` is shipped; call its files as `bash scripts/<name>.sh` so they work whether or not the executable bit survived.
6. **Server.** Write `app/.server/` per Conventions: config, logging, errors, runtime, `runRoute`/`runData`, the services, the example tool, the extract program, and the export.
7. **Routes and UI.** The chat page and components, `api.chat`, `api.models`, `api.extract` with its page, the export route, and `healthz`, styled per Design system and the shipped `DESIGN.md`.
8. **Tests** per Testing, including the closed-loop chat test and the e2e smoke. Fill the README's `openscaffold:fill` markers, and pick the default model for `.env.example` from OpenRouter's public models list.
9. **Claude Code config** per its section below, including writing the `effect` skill.
10. Run `openscaffold verify` until it passes, then `bun run check`, which adds the e2e smoke. Verify leaves e2e out to keep its loop short; `bun install` has already fetched Chromium through `prepare` (outside CI), so `check` only needs the build.

## Conventions

### Server structure

- **Services.** Each service in `.server/services/` is a `Context.Tag` plus a Live layer. `runtime.ts` composes them into one `AppLayer` (with an `AppServices` union of their Tags) and builds one `ManagedRuntime` from it. The runtime is settable: `runRoute` reads the current runtime, and tests replace it with one built from test layers (`setRuntimeForTests`, or the same idea under another name). In dev, Vite re-evaluates `runtime.ts` on edit, so dispose the previous runtime (kept on `globalThis`) before building the new one. That keeps service edits live without leaking the old runtime.
- **Config.** `config.ts` reads every env var through Effect Config: `OPENROUTER_API_KEY` as an optional redacted value, `OPENROUTER_MODEL`, `SYSTEM_PROMPT` (falling back to `prompts.ts`), the routing settings, and the limits (max input characters, max messages per request, max output tokens, max tool steps, rate-limit capacity and refill rate, max concurrent streams, max stream duration). Nothing else reads `process.env`.
- **Errors.** `errors.ts` defines tagged errors: `LlmNotConfigured` (503), `BadRequest` (400), `NotFound` (404), `UnsupportedMediaType` (415), `UnknownModel` (400), `RateLimited` (429, carrying the retry delay), `UpstreamUnavailable` (502), and `InvalidModelOutput` (502, structured output that fails its schema), with `statusFor` mapping each to its status. Every tagged error carries a fixed user-safe message; the raw upstream cause is logged, never sent to the client.
- **`runRoute` and `runData`** (`http.ts`). `runRoute(request, program)` runs a resource route's program on the current runtime and maps each tagged error to its status with a JSON body `{ "message": ... }`. A `RateLimited` response also sets `Retry-After`. Anything else is a defect: log it once and return a generic 500. `runData` does the same for page loaders, throwing the error Response to the route's ErrorBoundary; the root ErrorBoundary shows the server's `{ message }`. Both always produce a Response: a runtime that can't build (invalid config) and an aborted request become responses too, never a rejected promise. `healthz` goes through the runtime, so bad config fails it. `http.ts` also holds the shared steps programs compose: `readJsonBody` (415 on a non-JSON content type), `decodeInput(Schema)` (400), and `enforceRateLimit(request)`.
- **Thin routes.** A loader or action is one line: `return runRoute(request, someProgram(request))` (or `runData`). The program decodes its input and hands it to a function that does the work, so the core is testable without a Request. Components never import Effect. Nothing under `.server/` is imported by client code.

### Logging

Agents debug from files, so the dev server writes everything to `logs/` and the log format is fixed. The shipped `.claude/hooks/dev-server-status.sh` and the verification rule parse it.

- **Record shape.** `logging.ts` is a custom Effect logger (Effect's built-in JSON logger uses different field names). Each record is one compact JSON object per line: `time` (UTC ISO), `level` (lowercase: `debug`, `info`, `warn`, `error`, `fatal`), `msg`, the annotations as top-level keys (an annotation named like a record field is written as `<key>_`), `detail` for extra log arguments, and `error` for a cause (name, message, status, and stack only: third-party error objects can carry request bodies).
- **Where it goes.** In dev, the terminal gets one readable line per record (local time, colors unless `NO_COLOR`), and `logs/server.jsonl` gets the JSON lines. In production, the JSON lines go to stdout and no files are written. `LOG_LEVEL` (Config) sets the minimum level; health checks log at debug. The file sink never fails a request: it recreates a deleted `logs/`, and otherwise warns once and drops lines.
- **Request lines.** `runRoute`/`runData` log one `request` line per completed call (`method`, `path`, `status`, `durationMs`, `requestId`, and `errorTag`/`errorMessage` for tagged errors; defects log once, here, at level `error` with the cause), and annotate every log under the call with a short `requestId`, returned as the `x-request-id` header. A client disconnect isn't a stream-error warning. The startup line warns when `OPENROUTER_API_KEY` is empty.
- **`scripts/dev.sh`** (shipped) runs `dev:server`, copies the terminal to `logs/dev.log` with ANSI stripped (Vite and SSR errors appear only there), rotates the previous run to `logs/*.prev.*`, holds `logs/dev.pid` (`<pid> <port>`), and refuses to start when another dev server from this checkout runs or the port is taken. `scripts/dev-bg.sh` (`dev:bg`/`dev:stop`) reuses or starts that server detached and waits for `/healthz`, and stops it by process group. Agents use those, never `pkill`.

### Chat request: who owns what

Effect and the AI SDK each own one part of a chat request. Keep them apart.

- **Effect owns everything before the stream starts**: reject non-JSON content types, decode the body, check the key is configured, apply the limits, resolve the model, take a stream slot, and load the chat's history. Failures here become HTTP errors through `runRoute`. A full set of stream slots is a 429 with a short `Retry-After`, like the rate limiter.
- **History lives on the server.** The client sends only the new message (configure the `useChat` transport's request preparation to do that), and the action appends it to the stored history, truncating first on regenerate. "Max messages" is then a per-chat cap, enforced with a 400, and it counts the reply the turn will store. If you validate the incoming UI messages with the AI SDK's validator and a metadata schema, the metadata schema must accept `undefined`: user messages carry none.
- **The AI SDK owns the stream.** Call `streamText` with the OpenRouter model, the system prompt (its option name changed across majors), the tools, a max-steps stop condition from Config, max output tokens, and `abortSignal: AbortSignal.any([request.signal, AbortSignal.timeout(maxStreamDuration)])`. The SDK's own retries cover opening the stream, so don't wrap `streamText` in Effect retry or timeout. Upstream errors after the response has started arrive inside the stream: map them to user-safe text in the stream response's `onError`, since the default hides everything.
- **Work that outlives the returned Response** runs from the SDK's end-of-stream, error, and abort callbacks (whatever the installed major calls them) through `runtime.runFork`, with its own logging, because the request's Effect has already completed. Callbacks typed to return `void` or a promise must not return the forked fiber. That covers releasing the stream slot (exactly once, guarded), saving the messages, and the request log line.
- **Effect retry and timeout** are for non-streaming calls: the models list, and the extract program's structured-output call (called with the SDK's own retries set to 0, so only one retry layer exists). They retry only retryable upstream errors (429, 5xx, network), with jitter, and show fixed user-safe text while logging the raw cause.

### Chat flow

- `/` redirects to `/c/<random UUID>`. The chat loader returns that chat's stored messages, which become `useChat`'s initial messages. The composer sends the picked model id in the request body.
- **Saving.** The UI-message stream response's finish callback receives the original messages plus the new assistant message. Write the whole list to ChatStore there. On abort, including a client disconnect (newer majors report the two separately), save the partial reply with `interrupted: true` in its message metadata, so a reload shows what the user saw.
- **ChatStore** is a Tag with `get(chatId)` and `save(chatId, messages)`. The Live layer is a Map, kept on `globalThis` in dev so edits don't wipe chats. SQLite, if chosen, is another layer behind the same Tag. Chats have no owner: anyone with the URL can read one. AGENTS.md says so.
- **Models.** `api.models` returns the models list from the OpenRouter service (id, name, provider, context length, prices), fetched client-side so the chat page never waits on it. The picker is a shadcn Command combobox with search, grouped by provider. When the list can't be fetched (no network), it shows only the default model. A requested model id that isn't in the list returns 400 `UnknownModel`. `OPENROUTER_MODEL` is used only when the request names no model.
- **Usage and cost.** Usage accounting is turned on in the OpenRouter provider options. OpenRouter's cost and the serving provider arrive in the provider metadata of each step's finish part, and the served model id in that step's response metadata; the final finish part carries only total token usage. Collect across steps and attach the totals to the assistant message as typed message metadata (a schema in `app/schemas/`) when the stream finishes. The stream response's message-metadata hook may be called for every part, and anything it returns emits a metadata chunk, so return nothing except on the parts you mean. The message list shows the totals under each reply.
- **Errors in the UI.** When the action returns non-2xx, `useChat`'s error holds the raw body. Parse the `{ message }` JSON, show it in an inline error row with Retry. With no key, it says to set `OPENROUTER_API_KEY` in `.env`. A reply stopped with Stop shows "interrupted" without a reload.
- **Tool steps** render as a row with a status pip (pending, done, failed), label, and detail. Each tool has a hand-kept entry in the `ChatTools` type map in `app/lib/chat.ts` and a `tool-<name>` branch in `MessageParts`; an unknown part type renders nothing.
- **Export.** `GET /api/chats/:chatId/export` (`export.ts`, through `runRoute`) returns the stored chat as a Markdown download: role headings, text, one quoted line per tool call, model and tokens under each reply. A chat with no stored messages is 404 `NotFound`; a bad id is 400. The chat header shows Export (a real `<a download>`) and Copy as Markdown as one segmented control once a reply exists, both waiting while a reply streams. Copy reads the same route into the clipboard (`ClipboardItem` with a promise so Safari keeps the user gesture, `writeText` as the fallback) and shows "Copied" or "Couldn't copy" as visible text.

### OpenRouter

- `openrouter.ts` builds the provider options from Config: fallback models (OpenRouter's `models` array), provider routing (`sort` by price, throughput, or latency; `allow_fallbacks`; data collection and zero-data-retention preferences), and usage accounting. Pass them through the provider's settings or its extra-body option, whichever the installed `@openrouter/ai-sdk-provider` exposes.
- The OpenRouter service wraps `@openrouter/sdk` for the models list (and later credits or key info). The list may be paginated: iterate every page. Turn off the SDK's own retries so Effect's retry is the only one, and cache the list in memory with a TTL, with Effect retry and timeout around the fetch. The models endpoint needs no key. If the model type has no provider field, derive the provider from the id prefix (`openai/...`).
- **Request log line.** One structured line per chat request from the finish callback (`Effect.logInfo` with annotations): chat id, requested model, the model and provider that served it (from the response metadata), time to first token (timestamp the first chunk), input and output tokens, cost, finish reason, and whether it was aborted.

### Rate limiting

- `RateLimiter` is a Tag with `check(key)` that returns either allowed or a retry delay. The Live layer is an in-memory token bucket (GCRA is fine too) with capacity and refill rate from Config, state kept on `globalThis` in dev so hot reload doesn't reset it. Use a token bucket, not a fixed window: a fixed window lets a client burst to twice the limit across a window boundary.
- `enforceRateLimit(request)` in `http.ts` spends a token and fails with `RateLimited`. Every program that calls a paid model uses it: chat and extract.
- One `rateLimitKey(request)` function picks the key. It returns `"global"` for now, and a per-user or per-API-key limit is a change to that function. Making it distributed means another layer (Redis, say) behind the same Tag.
- `StreamSlots` caps concurrent streams separately, as the abuse backstop.
- Put "set a credit limit on the OpenRouter key" under Pending user actions. It's the real spend guardrail for an endpoint without auth.

### Tools and structured output

- Tool input schemas are Effect Schemas converted with `JSONSchema.make` and passed to the AI SDK's `jsonSchema()` helper, with a validate function built on the schema's decoder; `toAiSchema()` in `tools/schema.ts` does both. `makeTools(deps)` in `tools/index.ts` builds the tool set, with dependencies passed in as `ToolDeps` (built in `chat.ts` from the runtime) rather than imported Live layers. Effect's Standard Schema adapter carries no JSON Schema converter, so on its own it can't describe a tool to the model (the AI SDK accepts Standard Schema only when it also exposes JSON Schema). Give tool and output schemas a `title`/`description`, not an `identifier`: an identifier makes `JSONSchema.make` emit a top-level `$ref`.
- The example tool is small and deterministic (the current time in a given IANA time zone, say), so tests can assert its result.
- `extract.ts` defines an Effect Schema (for example contact details pulled from free text), converts it the same way, asks for structured output (`generateObject`, or `generateText` with an object output where `generateObject` is deprecated), and decodes the result with the schema before returning it; a failed decode is `InvalidModelOutput`. The model's output is a trust boundary.

### Env

The dev server loads `.env` through React Router's Vite plugin. `bun run` doesn't pass `.env` on to a `node` it starts, so `start` runs `react-router-serve` with `node --env-file-if-exists=.env`, and maps `PORT_WEB` (read from the shell, not `.env`) to the `PORT` it reads. Vite puts only `VITE_`-prefixed values into `import.meta.env`, never into server `process.env`. Empty values count as unset. Tests don't need `.env`.

### Design system

The shipped `DESIGN.md` is the spec: roles, type, shape, layout, components, and motion, each with the reason. Build `app/app.css` and the components to it.

- Dark only: `class="dark"` on `<html>` and `color-scheme: dark`, near-black surfaces stepped by luminance (background, card, popover), translucent white borders, one accent. Replace shadcn's theme tokens rather than keeping a light palette.
- Inter Variable (with `cv01`, `ss03` on `font-sans` only) and JetBrains Mono for model ids, tokens, and cost, both self-hosted through the fontsource variable packages. Remap `font-medium` to 510 in `@theme`, and add t-shirt `--text-*` sizes (`2xs`, `md`) for meta and reading text.
- Motion is CSS only, in `app.css` under `@layer components`: `--dur-fast`, `--dur-entry`, `--dur-word`, `ease-out-expo` as the theme's default transition duration and easing, and the `anim-module`, `anim-fade-in`, `anim-word`, `anim-pulse-dot`, `anim-spin` classes, all behind `prefers-reduced-motion: no-preference`. History loaded with the page never animates. shadcn overlays lose their `zoom-*` classes and gate the rest behind `motion-safe:`.
- Shared components for what chat and extract both draw: `PageHeader` and `HeaderLink`, `PromptCard`, `ErrorRow`. Button variants `quiet` and `accent`, size `icon-md`.
- `biome-plugins/styling.grit` (shipped) enforces what a regex can: no arbitrary sizes where the scale has one, no palette or hex colors in classes, no `font-bold` or heavier, no ungated `animate-*`, no `duration-*`/`ease-*` classes, `motion-safe:` on every `transition-*`. `app/components/ui/` is exempt from the size and color checks. Its messages name the tokens and classes above, so keep those names.

## Tool configuration

- **package.json scripts** are listed under Commands.
- **Biome**: start from `biome init`'s output (the config schema changes between majors), then add recommended rules plus `useImportType`, `useExportType`, `noUnusedImports`, and `useConst` as errors, and `biome-plugins/styling.grit` under `plugins`. Enable its Tailwind directive parsing for CSS. 2-space indent, width 100, double quotes, organized imports, VCS ignore file on. Ignore `build/`, `.react-router/`, and coverage. shadcn's generated components are owned source and get linted too; fix or narrowly suppress what the recommended rules flag in them.
- **TypeScript**: strict, plus `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, and `noEmit`; bundler module resolution; `~/*` points at `app/*`; include React Router's generated route types.
- **Vitest**: its own `vitest.config.ts` with the React plugin (not the React Router plugin), `node` by default and `happy-dom` for component tests (a per-file environment comment, or projects), a setup file with jest-dom matchers and Testing Library cleanup, the `~` alias, and in `test.env` `OPENROUTER_API_KEY` set to `""` and `OPENROUTER_BASE_URL` pointed at an unreachable local address, so no test can reach the network by accident. v8 coverage over `app/`, excluding `components/ui/`. Exclude `e2e/` from vitest.
- **Playwright**: `testDir: "e2e"`, Chromium only, one worker (the stub and the server's in-memory state are shared), `forbidOnly` in CI, list reporter (plus HTML in CI), trace retained on failure. Two web servers on fixed ports away from the dev port, so e2e can run while `bun run dev` does: `e2e/stub-server.ts` (bun runs `startStubOpenRouter` from `tests/helpers/stub-openrouter.ts`), and the production build (`react-router build` then `react-router-serve`, not `bun run start`, which would load `.env` and a real key) with `NODE_ENV=production`, a dummy key, `OPENROUTER_BASE_URL` at the stub, and its stdout piped so server log lines print as `[WebServer]`.
- **React Router**: `ssr: true`. Routes are listed explicitly in `app/routes.ts`.

## Testing

Tests never touch the network. The fakes are at the third-party boundary only.

- **Server programs** run with `@effect/vitest` against test layers. ChatStore, RateLimiter, and StreamSlots use their real in-memory layers. The LLM is the AI SDK's mock language model (from `ai/test`), injected through the Llm layer. `@openrouter/sdk` and the OpenRouter provider are pointed at a local stub HTTP server through their base-URL or fetch options. Nothing is module-mocked.
- **Closed-loop chat test (required).** Render the chat component, route its transport's `fetch` into the real `api.chat` action on a test runtime (mock model, real store), type a message, and assert that the streamed text and the example tool's result appear in the DOM. This is the check that the server's stream format and the client's `useChat` agree, which is what breaks across AI SDK majors. Two snags: happy-dom replaces `fetch` in server code too and enforces same-origin rules, so disable its same-origin policy for that file (an environment option) or the stub-server calls fail; and components that render router links need `createRoutesStub`.
- **Test runtime.** `tests/helpers/runtime.ts` exports `makeTestLayer(opts)`, the app's services with real config parsing, the real `*Memory` layers with fresh state, the real OpenRouter service, a dummy key, and the mock model through the Llm layer (pass `env: { OPENROUTER_API_KEY: "" }` for not-configured cases), and `useTestRuntime`, which also swaps it in for routes and disposes it after each test. `tests/helpers/mock-model.ts` builds mock replies (`toolCallReply` for a tool call).
- **Route tests** call loaders and actions with a real `Request`, covering every status each route can return. For chat and extract: no key → 503, bad body → 400, non-JSON content type → 415, over the limit → 429 with `Retry-After`, unknown model → 400, no model → the `OPENROUTER_MODEL` default. For a GET route like the export: bad param → 400, missing thing → 404. Plus invalid config, the chat loader, and MAX_MESSAGES.
- **Effect time.** `it.effect` runs on the TestClock: fork, adjust, join. The TestClock doesn't reach routes run through `useTestRuntime` (a separate runtime on the live clock), so test time-based behavior on the program with `Effect.provide(makeTestLayer(...))`. Never sleep to wait for time; wait on a condition (`vi.waitFor`).
- **Rate limiter** with `TestClock`: bursts up to capacity then rejects, refills over time, separate keys have separate buckets, and there's no double burst across a boundary.
- **OpenRouter request shape**: with the real provider pointed at the stub server, assert that the captured request body carries the fallback `models`, the `provider` routing object, and usage accounting, and that usage in the stub's response ends up in message metadata.
- **Persistence**: after a finished reply the store holds both turns. After an abort it holds the partial reply marked interrupted.
- **Structured output**: valid mock output decodes, invalid output is a typed error, a non-retryable upstream error isn't retried, and the retry schedule works under `TestClock`. The models-list retry is tested the same way.
- **Logging** (`tests/logging.test.ts`): the record shape, `requestId` on the request line and the `x-request-id` header, defects logged once, and the file sink surviving a deleted `logs/`. Tests that exercise the runtime failure path assert its stderr line instead of printing it.
- **UI**: message list states (waiting, tool steps, interrupted, no fade on history loaded with the page), the model picker when the list is unavailable, and the export actions (copy, failure, busy, no clipboard, the `writeText` fallback).
- **E2E smoke** (`e2e/chat.spec.ts`, `bun run e2e`): one test that opens `/`, lands on `/c/<uuid>`, sends a message, sees the stub's reply and usage, reloads and sees it again (server render plus hydration), and downloads the export. An auto fixture fails the test on any browser `pageerror` or console error, which is where hydration mismatches show up. Keep it to the main path; behavior belongs in vitest.
- `bun run test` stays fast. `bun run coverage` adds the report.

## Claude Code config

The stack ships its own Claude Code config next to agent-ops', and its `settings.json` deep-merges with agent-ops'.

- **`.claude/rules/app/`**: path-scoped rules for `app/.server/` (Effect), the AI SDK boundary, OpenRouter, rate limiting, routes, UI, styling, testing, and verification. Each loads only when the agent works on matching files.
- **`.claude/hooks/`** (self-contained, so they work without agent-ops):
  - `guard-generated.sh` denies hand edits to `.react-router/`, `build/`, `coverage/`, and `bun.lock`.
  - `guard-server-imports.sh` denies components, hooks, client libs, and schemas that import `app/.server/` or a `*.server` module.
  - `guard-commands.sh` denies `--bun` on vitest, Vite, or React Router, `bun test` (bun's own runner), and installing `@effect/schema`.
  - `typecheck-on-write.sh` runs `tsc` incrementally after each `.ts`/`.tsx` write (typegen first for route files) and hands back the errors, the written file's first.
  - `dev-server-status.sh` (SessionStart) reports a dev server already running from this checkout (`logs/dev.pid`) and the warn/error count in its `logs/server.jsonl`.
- **`.claude/commands/`**: `/check` (the gate), `/test` (scoped, then full), `/add-route` (a feature slice end to end, modeled on extract), `/add-tool`, `/add-service`.
- **`.claude/agents/`**: `architect` (read-only design) and `reviewer` (read-only review against the rules).
- **`.claude/skills/frontend-design-slop/`**: generic AI design patterns to avoid, beyond what `DESIGN.md` covers.
- **`settings.json`**: allows the project's scripts (lint, format, typecheck, test, coverage, build, check, e2e, dev:bg, dev:stop) and `curl` against the local dev server, denies reading `.env`, and wires the hooks.

While building:

- **Write `.claude/skills/effect/SKILL.md`** for the installed Effect major, once the server compiles. Frontmatter `name: effect` and a description that says to load it before writing Effect code or looking up Effect docs. Cover, from the installed package and its docs: the Context7 library id for this major (the default ids may point at another major); names from the other major that don't exist here, with the local equivalent; the traps in `effect-server.md` in this major's names (typed failures versus defects, wrapping promises with a signal, forked fibers that fail silently, no per-request `provide`, scoped layers for finalizers, `Clock` over `Date.now()`); Schema notes (tagged errors, JSON Schema for tools); and the installed `@effect/vitest` API (`it.effect`, `it.layer`, TestClock). About 100 lines. Point `effect-server.md` and AGENTS.md's Deeper context at it.
- The rules' `paths:` globs and the commands assume the names in Layout. If you name something differently, update the `.claude/` files that mention it.
- Add the stack's hooks to the hook table in `.claude/README.md`, and list the rules, commands, skills, and agents there too.
- Once verify is green, pipe each guard a payload it should deny (for example `{"tool_input":{"file_path":"<project>/.react-router/x.ts","content":"x"}}` into `guard-generated.sh`) and confirm the deny. Write a deliberate type error in a `.ts` file, pipe `typecheck-on-write.sh` its payload, confirm it reports the error, then revert.
- Mention `/check`, `/add-route`, and the reviewer agent in AGENTS.md under Commands, and put the log files and `jq` queries (`select(.level == "error" or .level == "warn")`, `select(.msg == "request" and .status >= 400)`) under Debugging.

## Commands

package.json scripts are the only entry points. Keep these names (the shipped scripts, Claude config, and CI call them) and mirror them in AGENTS.md and the README:

| Script | Runs |
| --- | --- |
| `dev` | `bash scripts/dev.sh` (foreground, logs to `logs/`) |
| `dev:server` | `react-router dev` (what dev.sh and verify call) |
| `dev:bg` / `dev:stop` | `bash scripts/dev-bg.sh start` / `stop` |
| `build` | `react-router build` |
| `start` | build, then `react-router-serve` on `PORT_WEB` with `.env` loaded (see Env) |
| `typecheck` | `react-router typegen && tsc` |
| `lint` / `format` | `biome check .` / `biome check --write .` |
| `test` / `test:watch` / `coverage` | `vitest run` / `vitest` / `vitest run --coverage` |
| `e2e` | `playwright test` |
| `check` | lint, typecheck, test, and e2e (which builds first): the full gate (CI runs the same, with coverage for test) |
| `clean` | remove `build`, `.react-router`, `coverage`, `logs`, `test-results`, `playwright-report` |
| `prepare` | `bash scripts/prepare.sh`: lefthook install and Playwright's Chromium, skipped when `CI` is set |

Verify's `web` step calls `dev:server` directly, not `dev`: the wrapper refuses to start while an agent's `dev:bg` server runs and rotates `logs/`.

## Gotchas

- Trust the installed packages' type definitions over memory. The AI SDK changed its chat and streaming APIs across majors (`useChat` input handling, transports, `maxSteps` versus stop conditions, tool `parameters` versus input schemas, the stream response helpers). If an API this brief implies doesn't exist or is marked deprecated, use its replacement from the installed package.
- `@openrouter/ai-sdk-provider` supports specific `ai` majors. If the latest of each don't fit together, install the provider release that matches the installed `ai`, or step `ai` down, and record it under Build workarounds.
- Never install `@effect/schema` (it's part of `effect` now). Keep `@effect/vitest` on the same major as `effect`. Effect v3 and v4 put some modules in different places: check the installed version's docs.
- If the `@effect/vitest` release for the installed `effect` major caps `vitest` below the latest (it happens when `effect`'s next major is still prerelease), install `vitest` and `@vitest/coverage-v8` at the range it accepts, and a `@vitejs/plugin-react` that supports the Vite version that vitest uses (it can differ from the app's Vite). Record it under Build workarounds. A type cast on the plugin in `vitest.config.ts` is acceptable there.
- `@openrouter/sdk` may read and validate its own `OPENROUTER_*` env vars when a client is constructed, even when the server URL is passed explicitly, and reject an empty value (`OPENROUTER_BASE_URL=` fails as an invalid URL). Leave optional SDK-owned vars commented out in `.env.example`, and test that an empty one in the environment doesn't break the models list.
- `@openrouter/ai-sdk-provider` may pull in `zod` as a peer. That's expected and doesn't mean the app should use zod.
- Verify's `web` probe requests a fixed chat URL (`/c/00000000-0000-4000-8000-000000000000`, a valid UUID with no stored messages) because it doesn't follow redirects. That page must render with the key unset and the models list unreachable, and the chat id schema must accept that UUID.
- `tsc` fails on missing `./+types/...` until `react-router typegen` runs; `.react-router/` is gitignored.
- Bare `vitest` is watch mode in a TTY; scripts use `vitest run`. Never add `--bun` to vitest or React Router commands: they run on Node.
- Importing anything under `.server/` from client code fails the build. `bun run build` is in verify for that reason.
- `bun test` runs bun's own test runner, not vitest; the tests are `bun run test`.
- `bun run` doesn't pass `.env` to a `node` it launches; `start` loads it with `node --env-file-if-exists`, which needs a Node release that has that flag.
- If shadcn's utility helper uses the `cn` package (a tailwind-merge replacement) rather than tailwind-merge, it reads any `text-*` that isn't a t-shirt size as a color, so a custom `--text-body` would silently drop a text color in `cn(...)`. Name custom sizes `2xs`, `md`, `3xl`, and so on.
- Biome's GritQL plugin support is newer than its linter. If the installed Biome rejects `biome-plugins/styling.grit`'s syntax, adapt the plugin to the installed version's plugin docs, keeping every rule and message, and record it under Build workarounds.
- Playwright's Chromium needs system libraries on a bare Linux box; CI installs them with Playwright's `--with-deps`.
- If SQLite is chosen and its driver needs a native build, add it to `trustedDependencies` so bun runs its install script.
- For server-wide middleware (CORS, security headers, request logging across every route), `react-router-hono-server` wraps the app in Hono. Add it only when that's needed; it changes the dev and start commands.
