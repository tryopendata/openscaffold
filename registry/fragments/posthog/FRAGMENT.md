---
schema_version: 1
id: posthog
kind: fragment
category: vendor
name: PostHog analytics
description: PostHog product analytics in the web client, initialized from env vars and fully disabled when no key is set, so tests, CI, and sandboxes run without an account; includes pageview handling, a typed event catalog, and a pre-init event buffer.
tags: [analytics, vendor, web]
applies_to: [web]
deps:
  web: [posthog-js]
decisions:
  - "PostHog region/host: US cloud (default), EU cloud, self-hosted, or a first-party reverse proxy domain."
  - "Consent: no banner, PostHog's cookieless/memory persistence until the user adds one (default), or a consent banner that opts in to cookies."
  - "Session recording and autocapture: off (default); turn on deliberately once there's a privacy review."
---

# PostHog analytics

Add PostHog to the web client so it's inert without a key. A missing `*_POSTHOG_KEY` is the normal state in development, tests, CI, and `--sandbox` projects, and nothing may fail or log noisily because of it.

## What to add

**Env vars.** Add these to `.env.example` (empty values, with a comment that analytics is off while the key is empty). Use the framework's public prefix:
- Vite/React Router apps: `VITE_PUBLIC_POSTHOG_KEY`, `VITE_PUBLIC_POSTHOG_HOST`
- Astro: `PUBLIC_POSTHOG_KEY`, `PUBLIC_POSTHOG_HOST`

The project key is public (it ships in the bundle), but keep it out of committed `.env` files anyway so dev traffic doesn't pollute production data. The host defaults to PostHog's US cloud when unset.

**One analytics module** owns the SDK. Nothing else imports `posthog-js` directly.
- React SPA: `app/lib/analytics.ts` exporting `initAnalytics()`, `track(event, properties?)`, `identify(id, traits?)`, `reset()`.
- Astro: `src/lib/analytics.ts` with the same surface, initialized from a module script in `BaseLayout.astro`'s head.

**Init rules.**
- If the key is empty, or the code isn't running in a browser, `initAnalytics()` returns without loading the SDK and every other function is a no-op.
- Load the SDK with a dynamic `import("posthog-js")` inside `initAnalytics()`, so pages without a key never download it.
- Call `initAnalytics()` exactly once: from the SPA's root component effect, or the Astro layout's head script. Guard against double init under hot reload or remounts.
- Config: API host from the host env var; person profiles only for identified users (the SDK has an identified-only setting); persistence per the consent decision; autocapture and session recording per the decision (off by default).

**Pre-init buffer.** Child components can call `track()` before init finishes (React runs child effects before the parent's; Astro islands can hydrate before the dynamic import resolves). Queue those calls in a small bounded array (about 50 entries) and replay them in the SDK's `loaded` callback. When the key is absent, drop calls without queueing. On overflow, drop and `console.warn` once. In Astro, expose the queue as a stub on `window.posthog` so islands can call it before the real client exists, then swap in the real client.

**Pageviews.** In the SPA, route changes don't reload the page. Use the SDK's history-change pageview mode if the installed version has one; otherwise turn off automatic pageviews and capture `$pageview` from an effect keyed on the router location. In Astro (full page loads), the default pageview capture is enough.

**Event catalog.** `events.ts` (no SDK import, so tests can use it) exports a const object of event names, and `track()` only accepts those names. Names are `snake_case` `object_verb` in past tense (`post_shared`, `signup_completed`). Properties are snake_case too.

**Privacy.** Don't send free text users typed (search queries, messages, form contents), emails, or tokens as event properties. Identify users only after sign-in, by stable internal id. Call `reset()` on sign-out.

**Backend (optional).** Server-side events or feature flags from a Python or Go backend use PostHog's server SDK behind the same rule: no key, no client, no-op. Don't add this unless the user asks for it.

## Testing

- The test runner sets the key to an empty string (the stack's vitest config already does this). Tests confirm `track()` is a silent no-op without a key and that nothing tries to load the SDK.
- Unit-test the buffer: calls before init are replayed in order after `loaded`, overflow drops and warns once, no queueing without a key.
- In Playwright, block or fulfill requests to the PostHog host so e2e runs never send real events.

## Verify

No verify step of its own. The stack's lint, typecheck, test, and build steps must pass with the key unset.

## AGENTS.md

Add an **Analytics** section: which module owns PostHog, the env var names, that analytics is off without a key, where the event catalog lives and the naming rule, and the privacy rule about free text and PII. If the user hasn't provided a key, add "create a PostHog project and set the key in the deploy environment" under Pending user actions.
