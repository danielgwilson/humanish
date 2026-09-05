# site/ — humanish.dev

The humanish.dev landing page: a Next.js 16 (App Router, Turbopack) port of the approved
single-page design. Two marketing routes — `/` and `/failure-modes` (the
cited limits page, built from the same band vocabulary) — plus Fumadocs 16 at
`/docs`, with `robots.txt`,
`sitemap.xml`, an OG image route, and `public/llms.txt` alongside.

## Commands

From the repo root (pnpm workspace):

- `pnpm install` — installs the site workspace too
- `pnpm --filter humanish-site dev` — dev server on http://localhost:3000
- `pnpm --filter humanish-site build` — production build
- `pnpm --filter humanish-site start` — serve the production build
- `pnpm --filter humanish-site typecheck` — TypeScript only
- `pnpm --filter humanish-site registry:build` — regenerate the component registry
  (extract per-item CSS from `app/globals.css`, then `shadcn build` → `public/r/`)
- `pnpm --filter humanish-site registry:check` — rebuild and fail on any diff
  (CI runs this; regenerate and commit after touching registry files or their CSS)

Or run `pnpm dev` / `pnpm build` / `pnpm start` from `site/` directly.

## Layout

- `content/docs/` — the focused user guides in MDX; `cli.mdx` is generated from Commander metadata.
- `app/` — root layout (fonts via next/font, theme-init inline script, JSON-LD),
  the homepage, `failure-modes/page.tsx`, `docs/`, `api/search/`, `robots.ts`, `sitemap.ts`,
  `opengraph-image.tsx`, `icon.svg`
- `components/` — server-rendered sections plus client islands: hero crowd canvas,
  resolve covers, pinned replay, theme toggle, copy buttons, scroll reveals
- `lib/` — theme plumbing shared by the canvas islands, the cover engine, and `cn()`
- `components.json` — shadcn CLI config (Base UI-era CLI, Tailwind v4 CSS-first);
  the `@humanish` namespace points at this site's own registry
- `registry.json` + `registry/css/` + `public/r/` — the @humanish component registry:
  manifest, generated per-item stylesheets, and built JSON artifacts served at
  `https://humanish.dev/r/<name>.json`. `registry/css/` and `public/r/` are committed
  build outputs — regenerate with `registry:build`, never edit by hand
- `public/study/` — the four Excalidraw study keyframes
- `public/llms.txt` — agent briefing with a generated command index
- `lib/docs-source.ts` — Fumadocs MDX source shared by pages, navigation, sitemap, and search
- `pnpm docs:generate` / `pnpm docs:check` (repo root) — generate/check CLI reference and llms command coverage; CI rejects drift

## Rules

- Existing marketing design and copy are fixtures. Preserve the approved hero and
  section vocabulary. Documentation must match the current CLI and runnable examples.
  Design tokens live once in `app/globals.css` (`:root` plus the
  two dark blocks) — both themes must stay in sync.
- Keep dependencies minimal: Next, React, Tailwind, Vercel Analytics, Fumadocs UI/Core/MDX
  (docs only), its schema peer, and the shadcn
  toolchain (`clsx`, `tailwind-merge`, `shadcn` as a dev dependency). No motion
  libraries, no committed font binaries.
- `app/globals.css` stays the single source of truth for all styling. The registry's
  per-item stylesheets are extracted from it by `scripts/extract-registry-css.mjs`;
  if a style change touches registry classes, run `registry:build` and commit the
  regenerated output, or CI fails.
- Progressive enhancement is load-bearing: the page must stay readable with JS disabled
  and show finished states under `prefers-reduced-motion`.
- Binary assets are gated: any new image under `public/` must be reviewed and pinned by
  sha256 in `scripts/public-surface-scan.mjs` at the repo root.
- Before pushing, run `pnpm public-surface:scan` from the repo root.
