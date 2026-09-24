---
schema_version: 1
id: ci-github
kind: fragment
category: ci
name: GitHub Actions CI
description: A GitHub Actions workflow that runs the project's own lint, typecheck, test, and build targets on every push and pull request, with path-filtered jobs for monorepos, dependency caching, SHA-pinned actions, least-privilege permissions, and superseded-run cancellation.
tags: [ci, github]
applies_to: []
tools: [git]
decisions:
  - "Runners: GitHub-hosted ubuntu-latest (default) or self-hosted labels the user provides."
  - "Required status check: a single aggregate job named ci-ok (default), so branch protection doesn't have to list every job."
  - "Coverage gate in CI: run the coverage target instead of the plain test target (default: yes)."
---

# GitHub Actions CI

Write `.github/workflows/ci.yml` for this project. Nothing is copied for you, because action versions and runner images change too often to ship a file. Resolve current versions of every action as you write it.

## What to add

**Triggers.** `push` to the default branch, `pull_request` (all branches), and `workflow_dispatch`. Never use `pull_request_target` for build and test jobs; it runs fork code with repository secrets.

**Permissions.** Top-level `permissions: { contents: read }`. Any job that needs more (a coverage comment, a package push) asks for it at job level, and only for that job.

**Concurrency.** `group: ci-${{ github.workflow }}-${{ github.ref }}`. Cancel in-progress runs for pull requests. On the default branch, only cancel if the next run re-tests everything the cancelled one covered. With path filters that compare against the previous commit, cancelling on main can let a commit reach deploy without any finished CI run having tested it. The simple safe setting is `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`.

**Jobs call the project's commands.** Every job runs the same Makefile targets (or package scripts) developers run locally: `make lint`, `make typecheck`, `make test` (or `make coverage`), `make build`. CI never re-implements a check inline, so local and CI can't drift. If a check only exists in CI, add a target for it first.

**Single-area projects** (a CLI, a blog): one job per concern is fine (`lint`, `test`, `build`), or one job with sequential steps if the whole thing takes under a few minutes. Prefer fewer jobs over more setup overhead.

**Monorepos** (for example `backend/` + `frontend/`):
- A `changes` job uses a paths-filter action to output one boolean per area. Every filter includes the area's directory, the shared lockfiles and root config it depends on, the Makefile, and `.github/workflows/**`, so a CI or tooling change re-tests everything.
- Code generated across areas counts as both: if the frontend's API client is generated from backend routes, the frontend filter includes the backend's API and schema paths.
- One job per area (`backend`, `frontend`), `needs: changes`, `if:` on that area's output, each running lint, typecheck, test, and build for that area.
- A final `ci-ok` job with `needs:` on every other job and `if: always()` fails if any needed job failed or was cancelled and passes when they succeeded or were skipped. Make that the required check. Otherwise a path-skipped job leaves branch protection waiting forever.

**Toolchains and caching.** Use each ecosystem's official setup action and read the version from the project instead of hardcoding it: `go-version-file: go.mod` for Go, uv's setup action with caching enabled plus the project's `.python-version` for Python, bun's setup action (reading `packageManager` or a `.bun-version` if present) with the bun install cache keyed on `bun.lock`. Install with frozen lockfiles (`uv sync --locked`, `bun install --frozen-lockfile`, `go mod download`) so CI fails when a lockfile is stale.

**Pin actions by commit SHA.** Every `uses:` references a full 40-character commit SHA with the human tag in a trailing comment (`uses: actions/checkout@<sha> # v<major>`). Look up the SHA for the current release tag when you write the file (`git ls-remote --tags https://github.com/<owner>/<repo>` or `gh api repos/<owner>/<repo>/git/ref/tags/<tag>`); dereference annotated tags to the commit. Don't invent SHAs. If you can't resolve one, stop and say so under Pending user actions in AGENTS.md.

**Timeouts.** Set `timeout-minutes` on every job (10 to 20 for typical lint/test jobs) so a hung test can't burn hours.

**Readable failures.** Let test output go to the log uncluttered. Upload coverage reports or test artifacts with short retention only when someone will look at them. A short `$GITHUB_STEP_SUMMARY` with pass/fail counts and total coverage is welcome but optional.

**Generated-code drift.** If the project commits generated code (an OpenAPI client, a spec file), add a step that regenerates it and fails on `git diff --exit-code`. For python-react that's `make check-api` in the frontend job, after the backend deps are installed.

**Stack notes.**
- *python-react*: backend job runs `make` targets scoped to the backend (split the root targets into `backend-*`/`frontend-*` sub-targets if that's cleaner, keeping the combined ones for local use). The frontend job needs the backend's environment only for `check-api`. Playwright e2e, if wanted in CI, is a separate job that installs the browser with its system deps and caches the browser directory.
- *go-cli*: a formatting check (`make fmt-check`), golangci-lint through its official action at the version recorded in the project (the same one the Makefile uses), `make coverage` (race detector on), `make build`. A `govulncheck ./...` job is cheap and worth adding.
- *astro-blog*: `make check`, `make test`, `make build`.

## Verify

No verify step: the workflow only runs on GitHub. Before finishing, lint the workflow with `actionlint` if it's installed (skip silently if not), and make sure every command the workflow calls passes locally.

## AGENTS.md

Add a short **CI** section: the workflow file path, what each job runs (as make targets), that `ci-ok` is the required check (if used), that actions are SHA-pinned and how to bump them, and that CI calls the same targets as local development, so a green `openscaffold verify` should mean green CI.
