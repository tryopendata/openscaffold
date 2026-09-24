---
schema_version: 1
id: astro-blog
kind: stack
name: Astro blog
description: A static Astro blog with MDX posts in a zod-validated content collection (draft/published/unlisted status), React islands, Tailwind with typography, sitemap and RSS, optional generated OG images, and vitest plus astro check.
tags: [typescript, astro, react, web, static, blog, content, mdx]
deps:
  site: [astro, "@astrojs/mdx", "@astrojs/react", "@astrojs/sitemap", "@astrojs/rss", react, react-dom, tailwindcss, "@tailwindcss/vite", "@tailwindcss/typography", clsx, tailwind-merge]
  site-dev: ["@astrojs/check", typescript, "@types/react", "@types/react-dom", vitest, "@vitest/coverage-v8", happy-dom, "@testing-library/react", "@testing-library/jest-dom", yaml, prettier, prettier-plugin-astro]
  og-images: [satori, "@resvg/resvg-js"]
tools: [bun, make, git]
decisions:
  - "Production site URL for canonical links, sitemap, and RSS (default: https://example.com)."
  - "Generated Open Graph images per post with satori (default: off; a static image in public/)."
  - "Trailing slash: never, with file-style build output (default), or always."
  - "Drafts: hidden from production pages, sitemap, and RSS; visible in dev at their URL (default)."
  - "Authors: one author in site config (default), or an authors data file."
env:
  PORT_WEB: "4321"
fragments:
  default: [agent-ops, git-hooks, ci-github, posthog]
  optional: [cloudflare-pages, ce-plugin]
verify:
  - { name: install, phase: setup, run: make install }
  - { name: check, run: make check }
  - { name: test, run: make test }
  - { name: build, run: make build, tags: [prod] }
  - name: web
    phase: serve
    run: make dev
    expect: { http: "http://localhost:${PORT_WEB}/", within: 60s }
  - name: readme-filled
    run: "test -s README.md && ! grep -n 'openscaffold:fill' README.md"
---

# Astro blog

A static blog: MDX posts validated by a zod schema (a bad post fails the build), thin `.astro` pages, React components and islands.

## Layout

```
astro.config.mjs, tsconfig.json, vitest.config.ts, Makefile
scripts/new-article.mjs      scaffolds a draft post
public/                      favicon, default OG image, robots.txt
src/content.config.ts        blog collection: glob loader + schema
src/content/schema.ts        zod frontmatter schema (importable by tests)
src/content/blog/*.mdx       posts; filename is the slug
src/config.ts                site title, description, author, nav
src/layouts/BaseLayout.astro HTML shell: meta, OG tags, theme script
src/pages/                   index.astro, [slug].astro, 404.astro, rss.xml.ts, og/[slug].png.ts (if OG on)
src/components/              React .tsx only, each with a colocated .test.tsx
src/lib/posts.ts             getPublishedPosts(), getRoutablePosts(), slugFor(), reading time
src/styles/global.css        Tailwind entry, typography plugin, theme tokens
```

## Setup

1. Run create-astro (`bun create astro`) non-interactively into a temp directory (for example `.astro-init/`) with the minimal template and without its AI/agent files, git init, or install. Skipping the AI files (a `--no-ai`-style flag in current versions) avoids an `AGENTS.md`/`CLAUDE.md` collision with the ones already here. Move its files to the root without overwriting: merge its `.gitignore` entries, discard its README, set `package.json` `name` to the project slug, then delete the temp dir.
2. `bun install`, then `astro add` mdx, react, sitemap non-interactively. Add Tailwind the way `astro add` currently does (its Vite plugin) and enable the typography plugin the way the installed Tailwind expects.
3. Add `@astrojs/rss`, `@astrojs/check`, and the test deps. Set `packageManager` in `package.json` to the installed bun version.
4. Write the config, schema, `lib/posts.ts`, layout, pages, components, and two sample posts (one `published`, one `draft`).
5. Write `scripts/new-article.mjs`, `vitest.config.ts`, and the tests; fill the README's `openscaffold:fill` markers.
6. Run `openscaffold verify` until it passes.

## Conventions

- **Minimal Astro.** The only `.astro` files are `BaseLayout.astro` and page routes, which load content and render React components. Every reusable component is `.tsx`. Add `client:*` only where interactivity is needed.
- **Schema.** `schema.ts` exports the zod object (import `z` from Astro's re-export); `content.config.ts` wraps it with the `glob` loader over `src/content/blog/**/*.{md,mdx}`. Fields: `title`, `description`, `date` (coerced), `updated?`, `author`, `tags` (default `[]`), `status` (`draft` | `published` | `unlisted`, default `published`), `cover?`, `ogImage?`. `unlisted` renders at its URL but stays out of the index, sitemap, and RSS.
- **One place decides visibility.** `lib/posts.ts`: `getPublishedPosts()` (published, newest first), `getRoutablePosts()` (published + unlisted, plus drafts when `import.meta.env.DEV`), `slugFor(entry)` (filename minus extension; strip it defensively, since the loader's id may keep it). Pages, RSS, OG, and sitemap all use these.
- **Sitemap** filters drafts, unlisted, and `og/` routes. The config can't import `astro:content`, so read status from the MDX frontmatter directly.
- **RSS** lists published posts newest first. With `trailingSlash: "never"`, pass `trailingSlash: false` to `@astrojs/rss` so item links match.
- **OG images (if on)**: 1200x630 card via satori + resvg, fonts loaded from `src/assets/fonts/` (never fetched at build), published and unlisted posts only.
- **Styling.** Tailwind; post bodies use `prose` with dark variants; an inline head script prevents a theme flash.
- **New posts.** `make new-article SLUG=my-post TITLE="My post"` exports both as env vars; `new-article.mjs` reads `process.env.SLUG`/`TITLE`, validates the slug (lowercase, digits, hyphens), refuses to overwrite, and writes a schema-valid `status: "draft"` post. Env vars avoid shell-quoting bugs with titles that contain quotes.

## Tool configuration

- **astro.config.mjs**: `output: "static"`, `site`, `trailingSlash` and `build.format` per the decision, integrations mdx, react, sitemap (filtered), Tailwind in `vite.plugins`, Shiki with light and dark themes.
- **tsconfig.json**: Astro's strict preset, `jsx: "react-jsx"`, `jsxImportSource: "react"`, `@/*` -> `src/*`.
- **vitest.config.ts**: built with Astro's `getViteConfig()`; `happy-dom`, `globals: true`, a setup file importing jest-dom's vitest matchers, include `src/**/*.test.{ts,tsx}`, v8 coverage, and every vendor key (`PUBLIC_POSTHOG_KEY`) set to `""` in `test.env`.
- **Prettier** with the Astro plugin (`make format`, not in verify).

## Testing

- `make check` (astro check) type-checks and validates content.
- vitest: `lib/posts.ts` logic against in-memory entries; the schema (valid passes, missing title and unknown status fail); and a test that parses every post's frontmatter with a real YAML parser (the `yaml` package, not a regex: Prettier rewrites quotes) and validates it with the schema.
- Testing Library per component (post list omits drafts, post layout renders heading and metadata).
- `make build` is the integration test (every route, RSS, sitemap, OG).

## Commands

The shipped Makefile (`make help`): install, dev, check, test, coverage (vitest with coverage), build, preview, new-article, format, clean. Adapt recipes, keep names, mirror in AGENTS.md.

## Gotchas

- If `astro dev` returns immediately with exit 0 when an agent runs it, Astro detected the agent and backgrounded itself. The Makefile's `dev` passes `--ignore-lock`, which keeps it in the foreground in current versions. Stop a stray background server with `bunx astro dev stop`.
- `@astrojs/check` can lag the newest TypeScript major. If `astro check` rejects the installed TypeScript, install the previous major and record it under Build workarounds.
- Bare `vitest` is watch mode in a TTY; scripts use `vitest run`.
- `astro.config.mjs` runs before the content layer, so it can't use `getCollection`.
- If content types look stale after a schema change, delete `.astro/`.
- Only `PUBLIC_` env vars reach client code, baked in at build time. Draft visibility keys off `import.meta.env.DEV`, never a custom env var.
- satori supports flexbox, not grid, and needs TTF/OTF/WOFF fonts, not WOFF2.
