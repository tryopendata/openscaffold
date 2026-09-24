---
paths:
  - "**/*.{ts,tsx,js,jsx,mjs,cjs}"
  - "**/*.py"
  - "**/*.go"
  - "**/*.rs"
---

# Error handling

Load the `ce:handling-errors` skill when writing try/catch blocks, designing how errors propagate, or reviewing a catch that looks wrong.

The project's own error pattern (error types, where errors become responses or exit codes) is in the Error handling section of `AGENTS.md`. Follow it rather than inventing a local variant.

- Never swallow an error. Handle it, or add context and pass it on.
- Keep the original error when wrapping, so the cause survives.
- Log once, at the boundary that handles the error, not at every layer it passes through.
