---
description: Run the full quality gate (lint, typecheck, test, e2e with its build) and fix what fails
---

Run the project's gate and fix everything it reports.

1. `bun run lint`. If it fails, `bun run format` fixes formatting and safe lint issues; fix the rest by hand. Re-run until clean.
2. `bun run typecheck`. This runs React Router typegen first, so new or renamed routes get their types.
3. `bun run test`. Read the pass/skip counts, not just the exit code.
4. `bun run e2e`. It builds first, which catches server-only code leaking into the client bundle, then runs the Playwright smoke in Chromium; the server's log lines print as `[WebServer]`. On failure, read `test-results/<test>/error-context.md` (the error and a snapshot of the page); `bunx playwright show-trace <trace.zip>` has the rest.

Fix the underlying problem each time. Don't skip or weaken a test, loosen a lint rule, or add a type cast to get green; if one of those is truly the right call, say so and why.

Done when all four pass in one run. Report what you changed to get there.
