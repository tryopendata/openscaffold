---
paths:
  - "app/.server/openrouter*"
  - "app/.server/models*"
  - "app/.server/chat*"
  - "app/.server/services/OpenRouter*"
  - "app/.server/services/Llm*"
  - "app/routes/api.models*"
  - "app/routes/api.chat*"
---

# OpenRouter

## Provider options

`openrouter.ts` builds them from Config and nothing else sets them:

- **Fallback models**: OpenRouter's `models` array, tried in order when the primary fails.
- **Provider routing**: `sort` (price, throughput, latency), `allow_fallbacks`, data collection, zero-data-retention.
- **Usage accounting** on, so cost comes back with every step.

Pass them through the provider's settings or extra-body option, whichever the installed `@openrouter/ai-sdk-provider` exposes. A test points the real provider at a local stub server and asserts on the request body, so a renamed option shows up as a failing test, not a silent no-op.

## Models list

- `@openrouter/sdk` wraps the models endpoint (no key needed). The list can be paginated: read every page.
- Turn off the SDK's own retries; Effect retries and times out the fetch, and caches the list in memory with a TTL.
- The picker falls back to the configured default model when the list can't be fetched. A requested model that isn't in the list is a 400; `OPENROUTER_MODEL` applies only when no model was sent.

## What to record per request

One structured log line from the end-of-stream callback: chat id, requested model, served model and provider (from each step's response and provider metadata), time to first token, input and output tokens, cost, finish reason, aborted. Never the prompt or reply text, never the key.

## No key

`OPENROUTER_API_KEY` is optional. Without it the app builds, tests, and renders; chat returns `LlmNotConfigured` (503) and the UI says to set the key. In tests the process env key is empty, but `makeTestLayer` passes a dummy key so chat paths run against the mock model; pass `env: { OPENROUTER_API_KEY: "" }` to test the not-configured path.
