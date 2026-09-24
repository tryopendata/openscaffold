---
schema_version: 1
id: astro-blog
kind: stack
name: Astro blog
description: A static Astro blog with MDX posts in a zod-validated content collection (draft/published/unlisted status), React islands, Tailwind with typography, sitemap and RSS, optional generated OG images, and vitest plus astro check.
tags: [typescript, astro, react, web, static, blog, content, mdx]
deps:
  site: [astro, "@astrojs/mdx", "@astrojs/react", "@astrojs/sitemap", "@astrojs/rss", react, react-dom, tailwindcss, "@tailwindcss/vite", "@tailwindcss/typography", clsx, tailwind-merge]
  site-dev: ["@astrojs/check", typescript, "@types/react", "@types/react-dom", vitest, happy-dom, "@testing-library/react", "@testing-library/jest-dom", prettier, prettier-plugin-astro]
  og-images: [satori, "@resvg/resvg-js"]
tools: [bun, make, git]
decisions:
  - "Production site URL, used for canonical links, the sitemap, and RSS (default: https://example.com until the user has a domain)."
  - "Generated Open Graph images per post with satori (default: off; a static default image in public/ instead)."
  - "Trailing slash policy: never, with file-style build output (default), or always."
  - "Drafts: hidden from every production page, the sitemap, and RSS, and visible in dev at their URL (default)."
  - "Post authors: a single author in site config (default), or an authors data file keyed by id."
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
---

# Astro blog

A static blog. Posts are MDX files in a content collection whose frontmatter is validated by a zod schema, so a malformed post fails the build instead of rendering wrong. Pages are thin `.astro` wrappers that load content and hand it to React components; interactivity ships as React islands. Output is plain static files, deployable anywhere.

## Layout

```
.
├── Makefile
├── astro.config.mjs          static output, site URL, integrations, Tailwind vite plugin
├── tsconfig.json             Astro's strict preset, "@/*" -> "src/*", react-jsx
├── vitest.config.ts
├── package.json              scripts: dev, build, preview, check, test, new-article
├── scripts/new-article.mjs   scaffolds a draft post
├── public/                   favicon, default OG image, robots.txt
└── src/
    ├── content.config.ts     the blog collection: glob loader + schema
    ├── content/
    │   ├── schema.ts         the zod frontmatter schema (importable by tests)
    │   └── blog/*.mdx        posts; filename is the slug
    ├── config.ts             site title, description, author, nav
    ├── layouts/BaseLayout.astro     HTML shell: meta, OG tags, fonts, theme script
    ├── pages/
    │   ├── index.astro       post list -> <PostList />
    │   ├── [slug].astro      one post -> <PostLayout />
    │   ├── 404.astro
    │   ├── rss.xml.ts
    │   └── og/[slug].png.ts  only if OG images are on
    ├── components/           React (.tsx) only, each with a colocated .test.tsx
    ├── lib/posts.ts          getPublishedPosts(), slugFor(), sorting, reading time
    └── styles/global.css     Tailwind entry, typography plugin, theme tokens
```

## Setup

The root already holds files openscaffold wrote (Makefile, README, .gitignore, .editorconfig, .env.example, agent config), so don't run the generator there.

1. Run the official Astro generator (`bun create astro`) non-interactively into a temporary directory (for example `.astro-init/`) with the minimal/empty template, TypeScript strict, no git init, and no install. Move its files into the root without overwriting existing files: merge its `.gitignore` entries into the existing one, and discard its README. Delete the temporary directory.
2. `bun install`, then add integrations with Astro's own `astro add` command, non-interactively (it accepts a yes flag): mdx, react, sitemap. Add Tailwind the way `astro add` currently does it (through the Vite plugin, not a legacy integration), then enable the typography plugin the way the installed Tailwind expects (CSS-first config in current versions).
3. Add `@astrojs/rss`, `@astrojs/check`, and the test deps.
4. Set `astro.config.mjs` per Tool configuration.
5. Write `src/content/schema.ts`, `src/content.config.ts`, `src/lib/posts.ts`, the layout, the pages, and the React components. Add two sample posts, one `published` and one `draft`, so the draft filtering is exercised from the start.
6. Write `scripts/new-article.mjs` (see Conventions) and the `new-article` package script.
7. Write `vitest.config.ts` and the tests.
8. Run `openscaffold verify` and loop until it passes.

## Conventions

- **Minimal Astro.** Only a handful of `.astro` files exist: `BaseLayout.astro` and the page routes. They do two things: load content (collections, props) and render a React component with it. Everything else, including every reusable component, is React `.tsx`. Don't add `.astro` components. This keeps one component model for the team and makes components testable with Testing Library.
- **Islands.** React components render to static HTML by default. Add a `client:*` directive only where the component needs interactivity (`client:visible` for below-the-fold widgets, `client:load` for anything above the fold that must respond immediately). A post page with no islands ships no JavaScript beyond the layout's inline scripts.
- **Content schema.** `src/content/schema.ts` exports the zod object (import `z` from Astro's zod re-export so versions match) and `src/content.config.ts` wraps it in `defineCollection` with the `glob` loader over `src/content/blog/**/*.{md,mdx}`. Fields: `title`, `description`, `date` (coerced date), `updated` (optional date), `author`, `tags` (string array, default empty), `status` (`draft` | `published` | `unlisted`, default `published`), `cover` and `ogImage` (optional). `unlisted` renders at its URL but stays out of the index, the sitemap, and RSS, which is useful for sharing a post before announcing it.
- **One place decides visibility.** `lib/posts.ts` exports `getPublishedPosts()` (status `published`, newest first), `getRoutablePosts()` (published + unlisted, plus drafts only in dev via `import.meta.env.DEV`), and `slugFor(entry)`. Pages, RSS, OG images, and the sitemap filter all go through these; no page filters on status itself.
- **Slugs.** The filename minus extension is the slug. Derive it in `slugFor()`: depending on the Astro version, the glob loader's entry id may or may not keep the extension, so strip it defensively.
- **Sitemap.** Filter out unlisted and draft slugs and the `og/` routes. Astro config can't import `astro:content`, so read the frontmatter status straight from the MDX files (a small frontmatter parse in the config) to build the exclusion set.
- **RSS.** `rss.xml.ts` lists published posts newest first with title, description, date, and link. Full content in the feed is optional; if included, render it from the Markdown body and strip MDX imports and components.
- **OG images (if on).** `og/[slug].png.ts` renders a 1200x630 card with satori (title, date, site name) and rasterizes it with resvg. Load fonts from files in `src/assets/fonts/` and don't fetch them at build time. Only published and unlisted posts get images.
- **Styling.** Tailwind utilities in components; long-form post content uses the typography plugin's `prose` classes with dark-mode variants. Theme tokens (colors, fonts) live in `global.css`. Avoid a flash of the wrong theme with a tiny inline script in the layout head.
- **New posts.** `make new-article SLUG=my-post TITLE="My post"` runs `scripts/new-article.mjs`, which validates the slug (lowercase letters, digits, hyphens), refuses to overwrite an existing file, and writes `src/content/blog/<slug>.mdx` with frontmatter that passes the schema and `status: "draft"`.
- **Site config.** Title, description, default author, and nav links live in `src/config.ts`. The production URL lives in `astro.config.mjs` as `site` and is read back through `Astro.site`.

## Tool configuration

- **astro.config.mjs**: `output: "static"`, `site` set to the confirmed URL, `trailingSlash` and `build.format` per the trailing-slash decision (`"never"` pairs with file output), integrations mdx, react, sitemap (with the filter above). Tailwind goes in `vite.plugins` through its Vite plugin. Syntax highlighting uses Shiki with a light and a dark theme. Set `server.port` from `PORT_WEB` if the Makefile doesn't pass `--port`.
- **tsconfig.json**: extend Astro's strict preset, `jsx: "react-jsx"` with `jsxImportSource: "react"`, path alias `@/*` to `src/*`, exclude `dist`.
- **vitest.config.ts**: build it with Astro's own `getViteConfig()` helper so tests share Astro's aliases and transforms. Use the `happy-dom` environment, `globals: true`, a setup file importing jest-dom's vitest matchers, include `src/**/*.test.{ts,tsx}`, and set `PUBLIC_POSTHOG_KEY` (and any other vendor key) to an empty string in `test.env`.
- **Prettier**: with the Astro plugin so `.astro` files format too. Optional in the Makefile (`make format`), not part of verify.

## Testing

- **astro check** type-checks `.astro`, `.ts`, and `.tsx` files and validates content against the schema. It's the first gate, `make check`.
- **Unit tests (vitest)**: `lib/posts.ts` logic (status filtering, dev-only drafts, sort order, slug stripping) against in-memory entries; the frontmatter schema (valid post passes, missing title fails, unknown status fails); and a test that reads every file in `src/content/blog/`, parses its frontmatter, and validates it with the exported schema, so a bad post fails `make test` before a build.
- **Component tests**: Testing Library for each React component: post list renders titles and dates and omits drafts, post layout renders the heading and metadata.
- **Build** is the integration test: `make build` renders every route, RSS, the sitemap, and OG images. Verify runs it as a production step.

## Commands

Makefile targets (shipped as a starting point; adapt, but keep the names). `openscaffold verify` calls install, check, test, build, and dev. Mirror this list in AGENTS.md's Commands section.

| Target | What it does |
|---|---|
| `make install` | `bun install` |
| `make dev` | Astro dev server on `${PORT_WEB}` |
| `make check` | `astro check` |
| `make test` | `vitest run` |
| `make build` | `astro build` into `dist/` |
| `make preview` | serve the production build locally |
| `make new-article SLUG=... TITLE="..."` | scaffold a draft post |
| `make format` | Prettier over the project |
| `make clean` | remove `dist/` and `.astro/` |

## Gotchas

- Bare `vitest` starts watch mode in a TTY. Scripts that verify or CI call must use `vitest run`.
- `astro.config.mjs` runs before the content layer exists, so it can't use `getCollection`. Anything the config needs from posts (the sitemap filter) must read files directly.
- The content layer caches in `.astro/`. After schema changes, `astro sync` (which `astro check` and `astro build` run) regenerates types; if types look stale, delete `.astro/`.
- `import.meta.env.DEV` is true under `astro dev` only. Draft visibility must key off it and not off a custom env var that could leak into a production build.
- Only `PUBLIC_`-prefixed env vars reach client code, and they're baked in at build time.
- Integrations and their config keys change across Astro majors (Tailwind moved from an integration to a Vite plugin). Use `astro add` and the current docs rather than copying older config.
- satori supports a subset of CSS (flexbox, no grid) and needs TTF/OTF/WOFF font data, not WOFF2.
- A glob pattern that includes `.md` and `.mdx` will pick up stray README files placed in the content folder. Keep only posts there.
