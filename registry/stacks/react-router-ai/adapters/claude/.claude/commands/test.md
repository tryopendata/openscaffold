---
description: Run tests scoped to what changed, then the full suite
argument-hint: "[test file or -t pattern]"
---

Run tests for: $ARGUMENTS

1. If a file or pattern was given, run just that: `bun run test <file>` or `bun run test -t "<name>"`. Otherwise pick the test files covering what changed (`git diff --name-only` against the last commit), and run those.
2. When they pass, run `bun run test` for the whole suite.
3. For a failure, read the assertion and the stack, find the cause, and fix the code (or the test, if the test was wrong: say which and why). Never skip, weaken, or delete a test to get green.

Report the pass/fail/skip counts from the final run.
