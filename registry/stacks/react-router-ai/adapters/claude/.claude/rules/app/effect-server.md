---
paths:
  - "app/.server/**"
---

# Server code (Effect)

Everything under `app/.server/` is Effect: services, config, errors, and the runtime that loaders and actions run programs on. Nothing here is imported by client code (a hook denies it from components, hooks, client libs, and schemas).

Load the `effect` skill before non-trivial Effect work or any Effect doc lookup. It's written for the installed Effect major, and most docs show whichever major is newest, whose names may not exist here.

## Services and the runtime

- A service is a `Context.Tag` plus a Live layer in `services/`. Add it to `AppLayer` in `runtime.ts`; never build a second runtime for app code.
- `runtime.ts` owns the one `ManagedRuntime`. It's settable so tests can swap in one built from test layers, and in dev it disposes the previous runtime (kept on `globalThis`) before building a new one on hot reload. Don't cache service instances outside the runtime.
- Long-lived in-memory state (the chat Map, rate-limiter buckets) lives on `globalThis` in dev so hot reload doesn't wipe it.
- Services depend on other services through the context (`yield* OtherService`), never by importing a Live layer directly.

## Config and errors

- Every env var is read in `config.ts` through Effect Config. Secrets are redacted values. Nothing else touches `process.env`.
- Expected failures are tagged errors in `errors.ts`. Each maps to one HTTP status in `runRoute` (`http.ts`). Add the error and its mapping together, and give it a user-safe message.
- Unexpected failures are defects: `runRoute` logs them once and returns a generic 500. Don't catch and swallow them earlier, and don't turn a defect into a tagged error to make it "handled".

## Retry, timeout, limits

- Effect retry and timeout are for non-streaming calls (models list, structured output), with the underlying SDK's own retries turned off so there is one retry layer. Retry only errors that can succeed on retry (429, 5xx, network), with a jittered exponential schedule and a cap.
- Streaming LLM calls are not wrapped in Effect retry or timeout. See `ai-sdk.md`.
- Limits (input size, message count, output tokens, tool steps, stream duration) come from Config. Enforce them before calling a model, not after.

## Effect traps

The names below are Effect 3's; the `effect` skill has their equivalents if the project is on another major.

- `catchAll` catches typed failures only; defects and interruption need `catchAllCause`. `Effect.promise` and a throw inside `Effect.sync` are defects: wrap third-party promises with `Effect.tryPromise({ try, catch })` (pass its `signal` through) and throwing code with `Effect.try`, mapping to a tagged error.
- Fail with `return yield* new SomeError({...})`.
- Every program forked from an AI SDK callback (`Runtime.runFork`) ends in `Effect.catchAllCause(... Effect.logError ...)`: a failing forked fiber prints nothing otherwise.
- No `Effect.runPromise`/`runSync` inside Effect code, and no `Effect.provide(SomeLive)` in a service or per request (v3 rebuilds the layer on every provide). Services come from the runtime.
- A layer whose constructor registers finalizers is `Layer.scoped`, not `Layer.effect`.
- Service methods return `Effect<A, E, never>`: yield dependencies in the layer constructor, not in each method.
- Time comes from `Clock`, not `Date.now()`, in anything a test drives with `TestClock`.

## Logging

`Effect.logInfo` / `logWarning` / `logError` with annotations, not `console.*`. `logging.ts` formats them: one line per record in the terminal, JSON lines in `logs/server.jsonl` (dev) and on stdout (production). Annotation keys become top-level JSON keys, so use stable camelCase names and don't reuse `time`, `level`, `msg`, `detail`, or `error`. `runRoute`/`runData` already log one `request` line per call and annotate everything under them with `requestId`; don't add per-route access logging. One structured line per chat request (see `openrouter.md`). Never log message content, prompts, or the API key, and don't log whole third-party error objects (the AI SDK's carry the request body): pass the error as a log argument and `logging.ts` keeps only its name, message, status, and stack.
