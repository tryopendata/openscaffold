---
paths:
  - "app/**"
  - "tests/**"
  - "e2e/**"
---

# Before calling work done

Run `bun run check` (lint, typecheck, test, e2e) and read the output. `bun run e2e` builds first, the only check that catches server code leaking into the client bundle, and is the only one that runs the real client in a browser.

- A clean exit code isn't a pass. A `-t` filter that matches nothing exits 0 with every test skipped; read the counts.
- UI or streaming changes: `bun run e2e` covers the main chat path in Chromium. For anything it doesn't cover, exercise the path in a browser if you have one. Without an API key, check the not-configured state; with one, send a message that triggers a tool and confirm tokens and cost show.
- To run the app yourself, `bun run dev:bg`: it reuses the dev server already running from this checkout or starts one, and returns once it's healthy, printing its URL (usually `http://localhost:5173`; use the port it prints). Then hit the routes. A chat turn from the shell (one real, tiny request when a key is set; replace both ids with fresh UUIDs):
  ```bash
  curl -s localhost:5173/api/chat -H 'content-type: application/json' \
    -d '{"id":"<uuid>","message":{"id":"<uuid>","role":"user","parts":[{"type":"text","text":"Reply with just: ok"}]}}'
  ```
  The stream should end with a `finish` event carrying usage, and `logs/server.jsonl` should gain a `request` line (status 200) and a `chat request` line with the same `requestId`. For any failure, read `logs/server.jsonl` (structured) and `logs/dev.log` (the whole terminal, including Vite and render errors) before guessing; AGENTS.md, Debugging, has `jq` queries. When done, `bun run dev:stop` if you started the server; leave the user's running. Never `pkill` it.
- A green commit isn't a complete one: after a hook-running commit, check `git status` for files a hook rewrote and left unstaged.
- Don't report a cause you didn't observe. Quote the error output you're basing it on.
