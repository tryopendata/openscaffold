---
schema_version: 1
id: python-react
kind: stack
name: Python API + React SPA
description: FastAPI backend (uv, ruff, mypy strict, pytest) plus a React single-page app (Vite, React Router in SPA mode, TanStack Query, Tailwind, shadcn/ui) that talks to the API through a typed client generated from its OpenAPI spec.
tags: [python, typescript, react, web, api, fullstack, monorepo]
deps:
  backend: [fastapi, uvicorn, pydantic, pydantic-settings, structlog]
  backend-dev: [ruff, mypy, pytest, pytest-asyncio, pytest-xdist, pytest-cov, pytest-randomly, httpx]
  frontend: [react, react-dom, react-router, "@tanstack/react-query", zod, tailwindcss, "@tailwindcss/vite", class-variance-authority, clsx, tailwind-merge, lucide-react]
  frontend-dev: ["@react-router/dev", vite, typescript, eslint, "@eslint/js", typescript-eslint, eslint-plugin-react-hooks, eslint-plugin-jsx-a11y, prettier, vitest, "@vitest/coverage-v8", happy-dom, "@testing-library/react", "@testing-library/jest-dom", "@testing-library/user-event", msw, orval, "@playwright/test"]
tools: [uv, bun, make, git]
decisions:
  - "Python version: the newest stable CPython that FastAPI, ruff and mypy all support (default: newest stable)."
  - "Frontend package manager: bun (default), or npm/pnpm if the user prefers. Every command below assumes bun; swap consistently if not."
  - "Database: none by default. Add the postgres fragment (--with postgres) for Postgres + SQLAlchemy + Alembic."
  - "Auth: none by default. Leave a clear seam (a FastAPI dependency that resolves the current user) and add a provider later."
  - "Production serving of the SPA: static host or CDN on the same origin as the API behind a reverse proxy (default), or FastAPI serving the built assets."
  - "Commit the generated API client and openapi.json (default: yes, so the frontend builds and tests without a running backend)."
env:
  PORT_API: "8000"
  PORT_WEB: "5173"
fragments:
  default: [agent-ops, git-hooks, ci-github, posthog]
  optional: [postgres, docker-deploy, rr, ce-plugin]
verify:
  - { name: install, phase: setup, run: make install }
  - { name: lint, run: make lint }
  - { name: typecheck, run: make typecheck }
  - { name: test, run: make test }
  - { name: build, run: make build, tags: [prod] }
  - name: api
    phase: serve
    run: make dev-api
    expect: { http: "http://localhost:${PORT_API}/health", within: 90s }
  - name: web
    phase: serve
    run: make dev-web
    expect: { http: "http://localhost:${PORT_WEB}/", within: 90s }
---

# Python API + React SPA

Two apps in one repo: `backend/` is a FastAPI service managed by uv, `frontend/` is a React SPA built with React Router's framework mode with SSR turned off. The frontend never hand-writes API types: the backend's OpenAPI spec is dumped to a committed file and orval generates TypeScript types, zod schemas, TanStack Query hooks, and MSW mock handlers from it. The root `Makefile` is the single entry point for every command, locally and in CI.

## Layout

```
.
├── Makefile                 root entry point; every target cds into backend/ or frontend/
├── .env.example             ports and settings; copy to .env
├── backend/
│   ├── pyproject.toml       deps + ruff, mypy, pytest, coverage config
│   ├── uv.lock              committed
│   ├── app/
│   │   ├── main.py          create_app() factory and module-level `app = create_app()`
│   │   ├── config.py        Settings (pydantic-settings) + cached get_settings()
│   │   ├── lifespan.py      startup/shutdown of shared resources
│   │   ├── errors.py        AppError hierarchy + exception handlers
│   │   ├── logging.py       structlog setup, request-id binding
│   │   ├── routers.py       register_routers(app): the one place routers are mounted
│   │   ├── api/             one module per area, each exporting `router` (health.py first)
│   │   ├── schemas/         pydantic request/response models
│   │   └── services/        plain Python business logic, no FastAPI imports
│   ├── scripts/dump_openapi.py   writes a deterministic spec to a path argument
│   └── tests/               conftest.py, test_*.py mirroring app/
└── frontend/
    ├── package.json         scripts: dev, build, typecheck, lint, format, test, test:e2e, generate:api
    ├── react-router.config.ts    ssr: false
    ├── vite.config.ts       Tailwind plugin, React Router plugin, /api dev proxy
    ├── vitest.config.ts
    ├── playwright.config.ts
    ├── orval.config.ts
    ├── components.json      shadcn config
    ├── openapi.json         committed copy of the backend spec (generated, do not edit)
    ├── app/
    │   ├── root.tsx         providers (QueryClientProvider), layout, error boundary
    │   ├── routes.ts        route table
    │   ├── routes/          one file per route
    │   ├── components/ui/   shadcn components (generated, then owned)
    │   ├── lib/             api fetcher (orval mutator), query client, utils
    │   └── api/generated/   orval output (committed, never hand-edited)
    └── tests/
        ├── setup.ts         jest-dom matchers + MSW server lifecycle
        ├── mocks/           MSW server + generated handlers
        └── e2e/             Playwright specs
```

## Setup

Work through these in order. The project root already contains files openscaffold wrote (Makefile, README, .gitignore, .editorconfig, .env.example, and agent config), so every generator runs inside its own subdirectory, never at the root.

1. **Backend.** Run `uv init` non-interactively inside `backend/` as an application (not a library), then `uv add` the backend deps and `uv add --dev` the backend-dev deps. Remove any `hello.py`/`main.py` stub uv created at the backend root and create the `app/` package from the layout above. Pin the Python version uv chose in `.python-version` (uv writes it) so CI and local agree.
2. **Backend skeleton.** Write `config.py`, `errors.py`, `logging.py`, `lifespan.py`, `routers.py`, `api/health.py`, and `main.py` per Conventions. `GET /health` returns `{"status": "ok"}` and has no external dependencies. Add `scripts/dump_openapi.py`.
3. **Backend config.** Add the ruff, mypy, pytest and coverage blocks to `backend/pyproject.toml` per Tool configuration. Write the first tests (health, error envelope, validation error shape) and get `uv run pytest` green before moving on.
4. **Frontend.** Run the official React Router project generator non-interactively into `frontend/` (tell it not to init git or install, if it offers; the repo already has git). Install with bun. Turn SSR off in `react-router.config.ts` so the build is a static SPA. If the template didn't set up Tailwind, add it through its Vite plugin.
5. **shadcn/ui.** Run the shadcn CLI's init non-interactively inside `frontend/`, pointing its aliases at `~/components`, `~/components/ui`, `~/lib`, `~/lib/utils`, `~/hooks` (the `~` alias maps to `app/`, which the React Router template already configures in tsconfig). Add one component (button) to prove the pipeline.
6. **Data layer.** Add TanStack Query with a single `QueryClient` created in `app/lib/query-client.ts` and provided in `root.tsx`. Add the Vite dev proxy (see Conventions).
7. **Typed client.** Run `make generate-api` (the backend dumps `frontend/openapi.json`, orval generates into `app/api/generated/` and `tests/mocks/generated/`). Make the home route call the health endpoint through a generated hook and render the result, so there is one real round trip from UI to API.
8. **Frontend tooling.** Write the ESLint flat config, Prettier config, `vitest.config.ts`, `tests/setup.ts`, and `playwright.config.ts` per Tool configuration. Write a component test for the home route (rendered against MSW) and one Playwright smoke spec.
9. **Wire it together.** Make sure every root Makefile target works, then run `openscaffold verify` and loop until it passes.

## Conventions

**Backend**

- **App factory.** `create_app(settings: Settings | None = None) -> FastAPI` builds the app: configures logging, attaches the lifespan, installs middleware (request id, CORS from settings), registers exception handlers, and calls `register_routers(app)`. `main.py` ends with `app = create_app()` for uvicorn. Importing `app.main` must have no side effects beyond building the object: no network, no DB, no file writes. That is what lets `dump_openapi.py` and tests import it freely.
- **Config.** One `Settings(BaseSettings)` class with typed fields and defaults that work for local dev (`environment="development"`, `log_level="INFO"`, `cors_origins=["http://localhost:5173"]`). Read from the environment and from the repo-root `.env` (configure `env_file` so it resolves from `backend/` too). Use `SecretStr` for secrets. Expose `get_settings()` wrapped in `functools.lru_cache` and inject it with `Depends(get_settings)` so tests can override it through `app.dependency_overrides`. Group related fields into nested models once there are more than a handful; use a nested delimiter (`__`) for env overrides.
- **Lifespan.** An `asynccontextmanager` in `lifespan.py` owns every long-lived resource (HTTP clients, DB engines, caches): create on startup, store on `app.state`, close on shutdown. No module-level singletons that open connections at import.
- **Routers.** Each `api/<area>.py` exports `router = APIRouter(prefix=..., tags=[...])`. `routers.py` has `register_routers(app)`, the only place routers are mounted, so ordering is visible in one file. Application routes live under `/api` (versioned `/api/v1` if the user expects external consumers); `/health` stays at the root for probes and load balancers.
- **Dependencies.** Use `Annotated[T, Depends(fn)]` parameter style. It avoids ruff's B008 complaints and reads better than defaults.
- **Structured errors.** `errors.py` defines `AppError(Exception)` with `code: str` (UPPER_SNAKE), `message: str`, `status_code: int`, `details: dict | None`, plus a few subclasses (`NotFoundError`, `ConflictError`, `ValidationFailed`, `Unauthorized`, `Forbidden`). Handlers render every error, including FastAPI's `RequestValidationError` and `HTTPException`, as one envelope: `{"error": {"code": ..., "message": ..., "details": ..., "request_id": ...}}`. A catch-all handler logs the exception with its traceback and returns `INTERNAL_ERROR` with a generic message; only in development does it include the exception type and message. Routes raise `AppError` subclasses; they never build error responses by hand. Declare the envelope as a pydantic model and list it in `responses=` for documented error codes so the generated client knows its shape.
- **Logging.** structlog, JSON output outside development, console output in development. A middleware accepts or generates `X-Request-ID`, binds it to the log context, and echoes it on the response.
- **Schemas vs services.** Pydantic models in `schemas/` define the API contract. Services in `services/` take and return plain types or domain models and never import FastAPI, so they're testable without HTTP.
- **OpenAPI is the contract.** Give every route a `response_model` and stable `operation_id`s (set a `generate_unique_id_function` that produces `<tag>_<function_name>`) so generated client names don't churn. `dump_openapi.py` writes `app.openapi()` with sorted keys and a trailing newline so diffs are stable.

**Frontend**

- **SPA mode.** SSR is off. There is no server runtime: no server `loader`/`action` exports. Fetch data with the generated TanStack Query hooks (or `clientLoader` when a route must block on data before rendering).
- **API access.** The browser calls relative `/api/...` URLs. In dev, Vite proxies `/api` and `/health` to `http://localhost:${PORT_API}` (read `PORT_API` from the environment in `vite.config.ts`, default 8000), so there's no CORS in development. In production the SPA and API share an origin behind a reverse proxy, or the fetcher prefixes `VITE_API_BASE_URL` when set. All requests go through one fetch wrapper in `app/lib/api.ts` (orval's mutator), which parses the error envelope into a typed `ApiError` with `code`, `message`, and `status`.
- **Generated code is read-only.** `app/api/generated/` and `tests/mocks/generated/` are regenerated by `make generate-api` and never edited. Exclude them from ESLint, Prettier checks, and coverage.
- **Components.** shadcn components in `components/ui/` are copied source you own; restyle them there. Feature components go in `components/<feature>/`. Use the `cn()` helper from `lib/utils` for class merging.
- **Query keys and invalidation.** Use the query keys orval generates; invalidate by those keys after mutations. One `QueryClient` for the app; tests create a fresh one per test with retries off.
- **Env.** Only `VITE_`-prefixed variables reach the browser, and they're baked in at build time. Never put secrets in them.

## Tool configuration

Write these for the versions you installed; check each tool's current docs for key names.

- **ruff** (in `backend/pyproject.toml`): target the project's Python version, line length 100, sources `app` and `tests`. Select E, W, F, I, B, C4, UP, ARG, SIM, TC (type-checking imports), PTH, ERA, PL, RUF, ASYNC, S, T20. Ignore E501 (the formatter owns line length) and PLR0913. Tests may ignore S101, PLR2004, ARG. Treat `app` as first-party for isort. Use `ruff format` as the formatter (double quotes, spaces).
- **mypy**: `strict = true` plus `warn_unused_ignores`, `warn_redundant_casts`, `show_error_codes`, and the pydantic mypy plugin. Relax `disallow_untyped_defs` for `tests.*` only. Add `ignore_missing_imports` overrides per module, only for libraries that ship no types, never globally.
- **pytest**: `asyncio_mode = "auto"` with function-scoped event loops, `testpaths = ["tests"]`, addopts `--strict-markers --strict-config -ra`, markers `slow` and `integration`, and `filterwarnings = ["error"]` so deprecations surface. Add targeted ignores (with a comment explaining each) instead of dropping `error`.
- **coverage**: `source = ["app"]`, branch coverage on, `parallel = true` (xdist), omit `app/main.py`'s uvicorn entry and `scripts/`, `fail_under = 80`, exclude `if TYPE_CHECKING:`, `raise NotImplementedError`, `@abstractmethod`, and `if __name__ == "__main__":`.
- **ESLint** (flat config in `frontend/`): `@eslint/js` recommended, typescript-eslint recommended, react-hooks recommended, jsx-a11y recommended; `@typescript-eslint/no-unused-vars` errors with `^_` ignored. Ignore `build/`, `.react-router/`, `app/api/generated/`, `tests/mocks/generated/`, `playwright-report/`, `test-results/`.
- **Prettier**: defaults, with the same ignores. `lint` runs ESLint and `prettier --check`; `format` writes.
- **TypeScript**: strict (the template's default). The `~/*` path alias maps to `app/*`; keep `@react-router/dev`'s generated route types in `include`.
- **Vitest**: its own `vitest.config.ts` (don't reuse `vite.config.ts`; the React Router plugin doesn't belong in tests), React plugin, `happy-dom` environment, `globals: true`, `setupFiles: ["./tests/setup.ts"]`, include `app/**/*.test.{ts,tsx}`, exclude `tests/e2e/**`, same path aliases as tsconfig, and force `VITE_PUBLIC_POSTHOG_KEY` (and any other vendor key) to an empty string in `test.env` so vendor SDKs stay off. Coverage via v8 with text + lcov reporters, include `app/**`, exclude generated code and route entry files, thresholds of 80 lines/statements, 70 branches, 75 functions.
- **tests/setup.ts**: import jest-dom's vitest matchers; start the MSW node server `beforeAll` with `onUnhandledRequest: "error"`, `resetHandlers` after each test, `close` after all; clean up Testing Library after each test.
- **orval**: two outputs from `./openapi.json`. (1) The client: TanStack Query hooks plus zod schemas for responses, in `app/api/generated/`, using the `app/lib/api.ts` fetcher as a custom mutator so every call gets the same base URL and error parsing. (2) Mocks: MSW handlers with generated fake data in `tests/mocks/generated/`. Run Prettier on the output after generation. If the API uses snake_case and the frontend prefers camelCase, decide once and do it consistently (either configure the backend's pydantic aliases or transform in orval), not per call site.
- **Playwright**: `testDir: "tests/e2e"`, chromium only by default, `forbidOnly` and 2 retries in CI, `trace: "on-first-retry"`, screenshots on failure, reporter `line` plus HTML with `open: "never"` (so an agent or remote run never blocks on a report server). `webServer` starts both `make dev-api` and `make dev-web` with the ports from env, `reuseExistingServer` only outside CI, and the web server uses `--strictPort` so a busy port fails loudly instead of silently testing another checkout's server.

## Testing

- **Backend unit and API tests** (`backend/tests/`): exercise the real app through `httpx.AsyncClient` with `ASGITransport(app=create_app(test_settings))`, using a fixture that builds settings for the test and enters the app's lifespan. Test behavior at the HTTP boundary: status codes, the error envelope for 404/422/500, response bodies. Test services directly when they hold logic. Don't mock your own code; if the app calls external HTTP services, stub them at the transport level (respx or an injected `httpx.MockTransport`).
- **Frontend component tests** (`app/**/*.test.tsx`): Testing Library queries by role and label, `user-event` for interaction, rendered inside a test `QueryClientProvider`. Network goes through MSW using the orval-generated handlers; override a handler inline to test error and empty states. Assert what the user sees, not hook internals.
- **E2E** (`frontend/tests/e2e/`): Playwright against the real backend and frontend. Keep it to a few smoke paths (app loads, home shows API health). Not part of `openscaffold verify` because browser downloads are slow; run with `make e2e`.
- **Coverage**: `make coverage` enforces the thresholds above for both halves. CI runs it; `make test` stays fast for the inner loop.

## Commands

The root `Makefile` (shipped as a starting point, adapt it) exposes these. `openscaffold verify` calls the first seven. Mirror this list in AGENTS.md's Commands section.

| Target | What it does |
|---|---|
| `make install` | `uv sync` in backend/, `bun install` in frontend/ |
| `make lint` | ruff check + ruff format --check; ESLint + prettier --check |
| `make typecheck` | mypy on app and tests; React Router typegen then `tsc` |
| `make test` | pytest (parallel via xdist); `vitest run` |
| `make build` | production frontend build (static files in `frontend/build/client`) |
| `make dev-api` | uvicorn with reload on `127.0.0.1:${PORT_API}` |
| `make dev-web` | Vite dev server on `${PORT_WEB}` with `--strictPort` |
| `make dev` | both dev servers in parallel |
| `make format` | ruff format + ruff check --fix; prettier --write |
| `make coverage` | tests with coverage thresholds enforced |
| `make generate-api` | dump OpenAPI from the backend into `frontend/openapi.json`, run orval |
| `make check-api` | regenerate and fail if the committed spec or client changed (CI uses this) |
| `make e2e` | install the Playwright browser if missing, run Playwright |
| `make clean` | remove caches and build output |

Package scripts in `frontend/package.json` back the frontend half: `dev`, `build`, `typecheck` (`react-router typegen && tsc`), `lint`, `format`, `test` (`vitest run`, never bare `vitest`), `test:e2e`, `generate:api`.

## Gotchas

- Bare `vitest` starts watch mode in a TTY and never exits. Scripts that verify or CI call must use `vitest run`.
- React Router generates route types; `tsc` fails on missing `./+types/...` imports until typegen runs. `typecheck` must run typegen first, and `.react-router/` belongs in `.gitignore`.
- A static SPA needs its host to fall back to `index.html` for unknown paths, or deep links 404 in production.
- Vite bakes `import.meta.env` at build and dev-server start. Changing `.env` needs a dev server restart, and a production bundle keeps whatever was set at build time.
- The OpenAPI dump imports the app. If `create_app()` touches the network or requires secrets, generation breaks in CI and in the git hook. Keep side effects in the lifespan.
- Generated client drift is the usual cause of "works locally, fails in CI". Regenerate after any backend route or schema change and commit both `openapi.json` and the generated code together. Only generate from committed code: a spec dumped from unstaged changes won't match what CI produces.
- `filterwarnings = error` turns third-party deprecation warnings into failures after upgrades. Add a targeted ignore with a comment; don't delete the rule.
- pytest-xdist workers share the machine. Use `-n auto` locally, but cap workers in CI or on shared runners if memory is tight.
- ruff renames rule prefixes across releases (the type-checking-imports family has moved before). If ruff warns about a deprecated code, switch to the new one rather than ignoring the warning.
- uv creates `backend/.venv`; run backend tools through `uv run` (or the Makefile) so the right interpreter is used.
- Serve steps probe `localhost`. Bind uvicorn to `127.0.0.1` for dev; bind to `0.0.0.0` only inside containers.
- Playwright needs a browser download (`bunx playwright install chromium`). `make install` skips it to stay fast; `make e2e` installs it on first use.
- Auth is not included. A Clerk fragment is planned but doesn't exist yet; if the user needs auth now, add it by hand behind the current-user dependency seam.
