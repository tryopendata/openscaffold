---
schema_version: 1
id: ci-github
kind: fragment
category: ci
name: GitHub Actions CI
description: A GitHub Actions workflow that runs the project's own make targets or package scripts on every push and pull request, with SHA-pinned actions, least-privilege permissions, and path-filtered jobs for monorepos.
tags: [ci, github]
applies_to: []
tools: [git]
decisions:
  - "Runners: ubuntu-latest (default) or self-hosted labels."
  - "Required check: one aggregate ci-ok job (default)."
  - "CI runs the coverage target instead of plain tests (default: yes)."
---

# GitHub Actions CI

Write `.github/workflows/ci.yml` against current action versions.

## What to add

- **Triggers**: `push` to the default branch, `pull_request`, `workflow_dispatch`; never `pull_request_target`. **Permissions**: top-level `contents: read`, more only at job level.
- **Jobs call the project's make targets (or package.json scripts, where the stack has no Makefile)**, never re-implemented inline; a CI-only check gets a target or script first. Official setup actions, versions read from the project, frozen-lockfile installs.
- **Generated-code drift**: if generated code is committed, regenerate and fail on `git diff --exit-code`.
<!-- openscaffold:when preset=default -->
- **Concurrency**: group per workflow and ref, `cancel-in-progress: ${{ github.event_name == 'pull_request' }}` (cancelling on the default branch can let an untested commit reach deploy).
- **Pin actions by full commit SHA** with the tag in a comment, resolved with `git ls-remote --tags https://github.com/<owner>/<repo>` (dereference annotated tags). Never invent one; if you can't resolve it, list it under Pending user actions. `timeout-minutes` on every job.
<!-- openscaffold:end -->
<!-- openscaffold:when preset=sandbox -->

Sandbox: keep the workflow minimal, with `timeout-minutes` per job. Major-tag action refs are fine; list SHA pinning under Deferred.
<!-- openscaffold:end -->

<!-- openscaffold:when tag=monorepo -->
**Monorepo.** A `changes` job (paths-filter action) outputs one boolean per area; each filter covers the area's directory, shared lockfiles and config, the Makefile, and `.github/workflows/**`, and the frontend's also covers the backend's API and schema paths. One job per area gated on its output. A final `ci-ok` job (`needs:` all, `if: always()`) fails if any needed job failed or was cancelled; make it the required check, or path-skipped jobs block merges forever.
<!-- openscaffold:end -->
<!-- openscaffold:when stack=go-cli,astro-blog,react-router-ai -->
One job with sequential steps is enough for this project; name it `ci-ok` so it is the required check.
<!-- openscaffold:end -->

<!-- openscaffold:when stack=go-cli -->
**go-cli.** `actions/setup-go` with `go-version-file: go.mod`. Steps: `make fmt-check`, lint, `make coverage`, `make vuln`, `make build`. Lint is the one sanctioned exception to "call make targets": use golangci-lint's official action with `version` read from `.golangci-version` (the file `make lint` checks against), because the action installs and caches the exact binary.
<!-- openscaffold:end -->
<!-- openscaffold:when stack=astro-blog -->
**astro-blog.** bun's setup action (it reads the `packageManager` field in `package.json`; set it to the bun version you installed), `make install` (frozen when `CI` is set), then `make check`, `make coverage` (or `make test` if the coverage decision is no), `make build`.
<!-- openscaffold:end -->
<!-- openscaffold:when stack=react-router-ai -->
**react-router-ai.** bun's setup action (it reads `packageManager` in `package.json`), then Node's setup action with `node-version-file: .node-version` (vitest, Vite, and the build run on Node). The project has no Makefile: steps call package.json scripts. `bun install --frozen-lockfile` (the `prepare` script skips itself when `CI` is set), `bun run lint`, `bun run typecheck`, `bun run coverage`, then Playwright's Chromium with its system dependencies (`bunx playwright install --with-deps chromium`) and `bun run e2e`, which builds first. On failure, upload `playwright-report/` and `test-results/` as an artifact with a short retention. No `OPENROUTER_API_KEY` in CI: the tests never touch the network.
<!-- openscaffold:end -->
<!-- openscaffold:when stack=python-react -->
**python-react.** Backend job: uv's setup action (cache on, `.python-version`), then `make backend-install backend-lint backend-typecheck backend-coverage`. Frontend job: bun's setup action (reads `packageManager` from `frontend/package.json`), then `make frontend-install frontend-lint frontend-typecheck frontend-coverage frontend-build check-api`; `check-api` also needs uv and `make backend-install`. Use the `-test` targets instead of `-coverage` if the coverage decision is no. Playwright, if wanted, is its own job.
<!-- openscaffold:end -->

Before finishing, run `actionlint` if installed and make sure every command the workflow calls passes locally.

## AGENTS.md

A short **CI** section: workflow path, what each job runs, the required check, and how to bump pinned actions.
