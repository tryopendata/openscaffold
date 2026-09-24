---
schema_version: 1
id: cloudflare-pages
kind: fragment
category: deploy
name: Cloudflare Pages
description: Deploy a static site's build output to Cloudflare Pages with wrangler (installed as a dev dependency, run through bunx), covering production deploys from the default branch, preview deploys for pull requests, and headers and redirects config.
tags: [deploy, cloudflare, static]
applies_to: [astro-blog, static]
deps:
  deploy-dev: [wrangler]
decisions:
  - "Deploy mode: direct upload from GitHub Actions after CI passes (default), or Cloudflare's git integration building on their side."
  - "Pages project name: the project slug (default)."
  - "Preview deploys for pull requests: on (default)."
---

# Cloudflare Pages

Deploy the static build output (`dist/` for astro-blog) to Cloudflare Pages. Wrangler is a dev dependency, so its version is locked with the project and it runs through `bunx wrangler`. Nothing needs installing globally, and no Cloudflare account is needed to scaffold or verify.

## What to add

**Wrangler config** (`wrangler.jsonc` at the root). Write it for the installed wrangler and point `$schema` at the schema file inside `node_modules/wrangler` so editors validate it. Set:
- `name`: the Pages project name
- the Pages build output directory: `dist`
- any other fields the current wrangler requires for a Pages project (check the docs; a compatibility date is usually needed)
- `vars`: public build-time values only (for example `PUBLIC_POSTHOG_KEY`). Never secrets.

Once a wrangler config file exists, Cloudflare treats it as the source of truth for the project's settings. With git-integration builds, environment variables set in the dashboard are ignored, so public build-time vars must live in `vars`. Secrets go in with `bunx wrangler pages secret put`, or as GitHub Actions secrets in direct-upload mode.

**Headers and redirects** in `public/_headers` and `public/_redirects` (copied into `dist/` by the build):
- Long-lived immutable caching for hashed assets (Astro emits them under `/_astro/`).
- Short caching for HTML, `rss.xml`, and `sitemap*.xml`.
- Basic security headers: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and a frame policy.
- Redirects for any trailing-slash normalization that matches the site's `trailingSlash` setting, so there's one canonical URL per page.

**Makefile targets**:
- `deploy-preview`: build, then `bunx wrangler pages deploy dist --project-name <name> --branch preview`.
- `deploy`: build, then deploy to the production branch.

Both need `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment. Say so in the target's help text, and fail with a clear message when they're missing.

**Deploy workflow** `.github/workflows/deploy.yml` (direct-upload mode):
- Trigger on `workflow_run` of the CI workflow for the default branch (only when it concluded `success`, checking out that run's `head_sha`), plus `pull_request` for previews if on.
- Permissions: `contents: read`, plus `deployments: write` if it reports a GitHub deployment, and `pull-requests: write` only if it comments the preview URL.
- Build with the same `make build` CI uses, then deploy `dist/` with wrangler through Cloudflare's wrangler action or `bunx wrangler pages deploy`. Use `--branch` set to the PR's head branch for previews and the default branch for production.
- Secrets: `CLOUDFLARE_API_TOKEN` (scoped to Pages edit on this account only) and `CLOUDFLARE_ACCOUNT_ID`. Pull-request previews from forks won't have secrets, so skip the deploy step when the token is empty instead of failing.
- `concurrency` per branch with `cancel-in-progress: true` for previews and `false` for production.
- Pin every action by full commit SHA with a version comment.

In git-integration mode, skip the workflow and document the dashboard settings (build command `make build` or the package build script, output `dist`, bun as the package manager) in AGENTS.md instead.

## Verify

No verify step: deploying needs credentials, and the stack's `build` step already proves `dist/` builds.

## AGENTS.md

Add a **Deploy** section: the Pages project name, deploy mode, the `make deploy` / `make deploy-preview` targets and the env vars they need, where public build-time vars live (`wrangler.jsonc` `vars`) and why dashboard vars are ignored, and where headers and redirects are configured. Under Pending user actions: create the Pages project once (`bunx wrangler pages project create <name>`), create a scoped API token, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repository secrets, and attach the custom domain.
