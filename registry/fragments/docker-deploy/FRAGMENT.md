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

A production image per deployable part and a workflow that publishes them, written against current base images and action versions.

## What to add

**Dockerfiles** next to the code (`backend/Dockerfile`, `frontend/Dockerfile`); root context only if an image needs files outside its directory. Every image:
- Multi-stage: deps, build (if any), minimal runtime with only runtime artifacts.
- Manifest and lockfile copied first and installed frozen, then source, so a source edit doesn't reinstall.
- Non-root user with fixed uid/gid, `COPY --chown`, `USER` before `CMD`.
- `HEALTHCHECK` on the health endpoint using the image's own runtime (no curl just for this).
- All config from env; no secrets in the image or build args (build args only for public values like a `VITE_PUBLIC_*` key).
- Exec-form `CMD` so the app gets SIGTERM and shuts down gracefully.
- `.dockerignore`: `.git`, `.env*`, `node_modules`, virtualenvs, caches, test and build output.

<!-- openscaffold:when tag=python -->
**Python API**: slim Python base matching `.python-version`; copy the uv binary from uv's official image; `uv sync --locked --no-dev --no-install-project`, copy source, sync again. Copy the venv to the runtime stage at the same path, put its `bin` on `PATH`, set `PYTHONUNBUFFERED=1` and `PYTHONDONTWRITEBYTECODE=1`, run uvicorn on `0.0.0.0` with proxy headers.
<!-- openscaffold:end -->
<!-- openscaffold:when stack=python-react -->
**React SPA**: build with bun, serve `build/client` from an unprivileged nginx or Caddy image with the `index.html` fallback, immutable caching for hashed assets, `no-cache` for `index.html`, a `/healthz` location, and a `/api` proxy if the API shares the origin.
<!-- openscaffold:end -->
<!-- openscaffold:when tag=go -->
**Go**: `CGO_ENABLED=0` with version ldflags in the official Go image, static binary copied into a distroless nonroot runtime.
<!-- openscaffold:end -->

<!-- openscaffold:when with=postgres -->
**Migrations** run as a one-shot `docker run <image> <migrate command>`, never on container start, so replicas can't race.
<!-- openscaffold:end -->

**Makefile**: `docker-build` builds every image as `<project-slug>-<part>:local` (verify calls it); `docker-run` runs them together with `.env` (a `compose.prod.yaml` for several images).

**`.github/workflows/docker-publish.yml`**:
- Trigger per the decision: `workflow_run` of CI on the default branch, proceeding only on `conclusion == 'success'` and checking out that run's `head_sha`, plus `v*` tag pushes.
- Job permissions `contents: read, packages: write`.
- Matrix per image; Buildx; log in to `ghcr.io` with `GITHUB_TOKEN`; tags from Docker's metadata action (short SHA, semver on tags, `latest` on the default branch only); build and push with the GitHub Actions cache scoped per image.
- Image names `ghcr.io/<owner>/<repo>/<part>`, lowercased.
- Actions pinned by full commit SHA; `concurrency` per ref with `cancel-in-progress: false`.

## AGENTS.md

A **Deploy** section: images and Dockerfiles, `make docker-build`/`docker-run`, where and when images publish, how migrations run, no secrets in images. Pending user actions: package visibility on GitHub, and the deploy target and its secrets once chosen.
