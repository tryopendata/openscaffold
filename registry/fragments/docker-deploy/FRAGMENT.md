---
schema_version: 1
id: docker-deploy
kind: fragment
category: deploy
name: Docker images + GHCR
description: Production container images (multi-stage, non-root, healthchecked) for each deployable part of the project, plus a GitHub Actions workflow that builds and publishes them to GitHub Container Registry after CI passes.
tags: [docker, deploy, containers, ghcr]
applies_to: [python-react, api]
requires_tools: [docker]
tools: [docker]
decisions:
  - "Where images run: publish to GHCR only (default); rollout to a host (Fly.io, Render, a VPS over SSH, Kubernetes) is a separate step the user chooses."
  - "Target platforms: linux/amd64 (default); add linux/arm64 if the hosts are ARM. Cross-building under emulation is slow, so build only what's needed."
  - "Publish trigger: after CI succeeds on the default branch plus on v* tags (default), or tags only."
  - "Frontend serving (python-react): a separate static-file image (default), or the API image serves the built SPA."
verify:
  - { name: image-build, run: make docker-build, tags: [prod] }
---

# Docker images + GHCR

Add a production image for each deployable part of the project and a workflow that publishes them. Write the Dockerfiles and workflow against current base images and action versions; nothing is copied for you.

## What to add

**Dockerfiles**, one per deployable, next to the code (`backend/Dockerfile`, `frontend/Dockerfile`). Use the repo root as the build context only if the image needs files outside its directory. Every image follows the same rules:
- **Multi-stage**: a dependency stage, a build stage if there's a build step, and a minimal runtime stage. Only runtime artifacts reach the last stage.
- **Layer caching**: copy only the manifest and lockfile first, install with a frozen lockfile, then copy the source. A source edit must not reinstall dependencies.
- **Non-root**: create a user and group with a fixed uid/gid, `COPY --chown` everything the app reads, and set `USER` before `CMD`.
- **Healthcheck**: `HEALTHCHECK` hitting the app's health endpoint on its port. Prefer a check that uses the runtime already in the image (a one-line Python or bun fetch) over installing curl just for this.
- **Config from env**: the port and every setting come from environment variables. No secrets in the image or in build args. Build args are for public build-time values only (for example a `VITE_PUBLIC_*` key baked into a static bundle).
- **Signals**: exec-form `CMD` so the process is PID 1 and receives SIGTERM. The server shuts down gracefully.
- **.dockerignore** next to each Dockerfile (or at the context root): exclude `.git`, `.env*`, `node_modules`, virtualenvs, caches, test output, and build output.

**Per stack.**
- *Python API*: base on the official slim Python image matching `.python-version`. Copy the uv binary from uv's official image in the build stage, `uv sync --locked --no-dev --no-install-project` before copying source, then sync again with the project. Copy the virtualenv to the runtime stage at the same path so script shebangs still resolve, put its `bin` on `PATH`, set `PYTHONUNBUFFERED=1` and `PYTHONDONTWRITEBYTECODE=1`, and run uvicorn bound to `0.0.0.0` on the configured port with proxy headers enabled.
- *React SPA*: build with bun in the build stage (public build args for any `VITE_PUBLIC_*` values), then serve `build/client` from an unprivileged static server image (nginx's unprivileged variant, or Caddy). Configure the SPA fallback to `index.html`, long-lived immutable caching for hashed assets, `no-cache` for `index.html`, and a `/healthz` location for the healthcheck. If the API shares the origin, proxy `/api` to it in this server's config.
- *Go*: build with `CGO_ENABLED=0` and version ldflags in the official Go image, then copy the static binary into a distroless or scratch-style runtime running as nonroot.

**Migrations** (if the postgres fragment is present): run them as a separate one-shot command using the same image (`docker run <image> <migrate command>`), not on container start. Two replicas starting together must not race on migrations.

**Makefile targets**:
- `docker-build`: build every image locally, tagged `<project-slug>-<part>:local`. Verify calls this.
- `docker-run`: run the images together for a local production-like check (a `compose.prod.yaml` is fine for multi-image projects), using `.env` for settings.

**Publish workflow** `.github/workflows/docker-publish.yml`:
- Trigger per the decision: `workflow_run` on the CI workflow for the default branch (proceed only when `github.event.workflow_run.conclusion == 'success'` and check out that run's `head_sha`), plus `push` of `v*` tags.
- `permissions: { contents: read, packages: write }` at job level.
- A matrix with one entry per image (name, Dockerfile, context). Set up Buildx, log in to `ghcr.io` with `GITHUB_TOKEN`, generate tags with Docker's metadata action (short SHA always, semver tags on version tags, `latest` only on the default branch), and build and push with the GitHub Actions cache backend scoped per image.
- Image names: `ghcr.io/<owner>/<repo>/<part>`, lowercased (GHCR rejects uppercase).
- Pin every action by full commit SHA with a version comment, and look SHAs up when writing the file.
- `concurrency` group per ref with `cancel-in-progress: false`. A half-pushed release is worse than a queued one.

## Verify

`image-build` runs `make docker-build`. It's tagged `prod`, so `--sandbox` skips it. Docker must be running.

## AGENTS.md

Add a **Deploy** section: which images exist and their Dockerfiles, `make docker-build` / `make docker-run`, where images are published and when, how migrations run in production, and the rule that images never contain secrets. Under Pending user actions, list anything the user must do on GitHub (package visibility, and the deploy target and its secrets once chosen).
