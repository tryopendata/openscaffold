---
paths:
  - "tests/**"
  - "app/**/*.test.ts"
  - "app/**/*.test.tsx"
  - "vitest.config.ts"
  - "e2e/**"
  - "playwright.config.ts"
---

# Testing

## No network, fakes only at the boundary

- Tests never reach the network: the process env has an empty key and an unreachable base URL, and `makeTestLayer` adds a dummy key (pass `OPENROUTER_API_KEY: ""` for not-configured cases) plus the mock model.
- The only fakes are for third parties: the AI SDK's mock language model for the LLM, a local stub HTTP server for OpenRouter's HTTP APIs. Never mock our own modules or services; build a test runtime from real in-memory layers instead.
- Route tests call loaders and actions with a real `Request` on a test runtime set through the runtime setter.

## Required coverage

- The closed-loop chat test: render the chat, route its transport's `fetch` into the real `api.chat` action, assert streamed text and a tool result reach the DOM. It's the check that server stream format and client `useChat` agree. Keep it passing; never skip it.
- Error paths for every route, each status it can return: for the chat and extract actions that's no key 503, bad body 400, wrong content type 415, rate limited 429 with `Retry-After`, unknown model 400; for a GET route, a bad param 400 and a missing thing 404.
- Rate limiter and retry schedules with `TestClock`. Never sleep to wait for time; a short real yield between clock steps is only for letting real I/O (the stub server) complete, and waiting on a condition (`vi.waitFor`) beats a fixed delay.
- The OpenRouter request shape against the stub server.

## Effect tests

- `it.effect` runs on the TestClock (starts at 0, moves only on `TestClock.adjust`; fork the program, adjust, then join) and silences the default logger.
- The TestClock doesn't reach routes run through `useTestRuntime` (a separate `ManagedRuntime` on the live clock). Test time-based behavior on the program or service with `Effect.provide(makeTestLayer(...))`.
- `it.layer` shares one layer build across its block; use a fresh `makeTestLayer`/`*Memory` layer per test when state must not leak. More in the `effect` skill.

## Running

- Scoped first: `bun run test tests/<file>.test.ts` (add `-t "<name>"` for one test). Then `bun run test` before calling it done.
- Server tests run in the `node` environment; component tests opt into `happy-dom` per file. happy-dom replaces `fetch` and enforces same-origin rules, so a test that hits the stub server from happy-dom disables its same-origin policy for that file.
- Components that render router links need `createRoutesStub`.
- `bun run e2e` is one Playwright smoke of the main chat path in a real browser (`e2e/chat.spec.ts`). Add to it only when a change could break in the browser but not in happy-dom (hydration, the client bundle, a download); test behavior in vitest. On failure, read `test-results/<test>/error-context.md` first: it has the error and a snapshot of the page.

## Discipline

- A bug fix starts with a test that fails for the bug's reason. Reintroduce the bug once to see it go red.
- A validation or limit test must prove the check bites: feed input that should be rejected and assert the rejection, not just that valid input passes.
- Weakening an assertion, adding `.skip`, or loosening a limit to get green is a failure, not a fix.
- A subagent asked to write tests touches only test files; check with `git diff --stat`.
