---
paths:
  - "app/routes/**"
  - "app/routes.ts"
  - "app/root.tsx"
---

# Routes

- Routes are listed explicitly in `app/routes.ts`. Use the generated `Route.*` types from `./+types/<route>`; run `bun run typecheck` (which runs typegen) after adding or renaming a route.
- A loader or action decodes its input with a schema from `app/schemas/`, runs one program through `runRoute`, and returns data. No business logic, no direct SDK calls, no `process.env`.
- Resource routes (`api.*`) return JSON or a stream. Reject non-JSON bodies with 415 before decoding.
- Route modules may import from `app/.server/`, but only use it inside `loader`/`action`; anything else leaks into the client bundle and fails `bun run build`.
- The chat page must render with no API key and no network (the scaffolder's verify step and the closed-loop test render it that way).
- Expected errors come back as `{ message }` with the right status from `runRoute`; the UI shows `message`. Don't throw raw errors from a loader for expected cases.
