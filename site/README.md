# site/: humanish.dev

The humanish.dev site is a Next.js 16 app (App Router, Turbopack). Its marketing routes are the
homepage, `/failure-modes` (the cited limits page, built from the same band vocabulary), `/demo`
(a saved eight-participant run replayed in the Observer) and `/legacy` (the previous homepage,
not indexed). Fumadocs 16 serves `/docs`. `robots.txt`, `sitemap.xml`, an OG image route,
`public/llms.txt` and its markdown twin `/llms.md` sit alongside.

## Commands

From the repo root (pnpm workspace):

- `pnpm install` installs the site workspace too.
- `pnpm --filter humanish-site dev` runs the dev server on http://localhost:3000.
- `pnpm --filter humanish-site build` makes a production build, then
  `scripts/check-docs-highlighting.mjs` fails it if a docs page lost its syntax colors in one theme.
- `pnpm --filter humanish-site start` serves the production build.
- `pnpm --filter humanish-site typecheck` runs TypeScript only.
- `pnpm --filter humanish-site registry:build` regenerates the component registry: it extracts
  per-item CSS from `app/globals.css`, then runs `shadcn build` into `public/r/`.
- `pnpm --filter humanish-site registry:check` rebuilds and fails on any diff. CI runs this;
  regenerate and commit after touching registry files or their CSS.

Or run `pnpm dev` / `pnpm build` / `pnpm start` from `site/` directly.

## Layout

- `content/docs/`: the focused user guides in MDX. `cli.mdx` is generated from Commander
  metadata. `content/docs/meta.json` sets the sidebar order; a page missing from its `pages`
  list does not appear in the sidebar.
- `app/`: root layout (fonts via next/font, theme-init inline script, JSON-LD), `page.tsx` (the
  fallback homepage when the proxy does not run), `failure-modes/page.tsx`, `docs/`,
  `api/search/`, `robots.ts`, `sitemap.ts`, `opengraph-image.tsx`, `icon.svg`.
- `app/demo/`: the saved-run replay page, with its own OG image.
- `app/legacy/`: the homepage as it shipped before 2026-09-27, marked `noindex`.
- `app/llms.md/route.ts`: serves `public/llms.txt` as `text/markdown`.
- `app/fonts/`: three display-face subsets that `app/layout.tsx` preloads ahead of the full
  faces. Regenerate them with `scripts/subset-display-fonts.py`.
- `components/`: server-rendered sections plus client islands: hero crowd canvas, resolve
  covers, pinned replay, theme toggle, copy buttons, scroll reveals.
- `lib/`: theme plumbing shared by the canvas islands (`theme.ts`), the cover engine
  (`covers.ts`), the homepage's run facts (`site-data.ts`) and the replay tours (`tour/`).
- `components.json`: shadcn CLI config (Base UI-era CLI, Tailwind v4 CSS-first). The
  `@humanish` namespace points at this site's own registry.
- `registry.json` + `registry/css/` + `public/r/`: the @humanish component registry. They hold
  the manifest, generated per-item stylesheets, and built JSON artifacts served at
  `https://humanish.dev/r/<name>.json`. `registry/css/` and `public/r/` are committed build
  outputs; regenerate them with `registry:build` and never edit them by hand.
- `public/study/`: the four Excalidraw study keyframes.
- `public/llms.txt`: agent briefing with a generated command index.
- `lib/docs-source.ts`: the Fumadocs MDX source shared by pages, navigation, sitemap, and
  search.
- `pnpm docs:generate` / `pnpm docs:check` (repo root) generate and check the CLI reference and
  llms command coverage. CI rejects drift.

## Serve the homepage through a flag

Requests for `/` pass through a proxy and a feature flag before a page renders:

- `proxy.ts` runs on `/` only. A request with `Accept: text/markdown` is rewritten to `/llms.md`.
  Every other request gets a one-year visitor cookie (`hm_vid`) and is rewritten to `/<code>`,
  where the code encodes that visitor's flag values.
- `flags.ts` declares the homepage variant flag with the `flags` SDK. The released design is
  the default value. The PostHog adapter (`@flags-sdk/posthog`) decides only when
  `POSTHOG_PROJECT_API_KEY` is set; without it every visitor gets the default, which is how CI
  builds.
- `app/[code]/` prerenders one static homepage per flag permutation. The page renders
  `components/home.tsx` or `components/home-legacy.tsx` for its variant. Codes are signed with
  `FLAGS_SECRET`; a build without it uses a throwaway value, and a path the decoder rejects is a 404.
- `components/analytics/posthog-client.tsx` loads `posthog-js` once the page is idle,
  bootstrapped with the visitor id and the flag values the page rendered, and reports the
  exposure. Session recording and surveys stay off. Without `NEXT_PUBLIC_POSTHOG_KEY` it renders
  nothing and captures nothing.

## Rules

- Existing marketing design and copy are fixtures. Preserve the approved hero and section
  vocabulary. Documentation must match the current CLI and runnable examples. Design tokens live
  once in `app/globals.css` (`:root` plus the two dark blocks), and both themes must stay in
  sync.
- Keep dependencies minimal: Next, React, Tailwind, Vercel Analytics, Fumadocs UI/Core/MDX (docs
  only) with its `zod` schema peer, the homepage flag stack (`flags`, `@flags-sdk/posthog`,
  `posthog-js`), and `shadcn` as a dev dependency. No motion libraries. The only committed font
  binaries are the three subsets in `app/fonts/`.
- `app/globals.css` stays the single source of truth for all styling. The registry's per-item
  stylesheets are extracted from it by `scripts/extract-registry-css.mjs`; if a style change
  touches registry classes, run `registry:build` and commit the regenerated output, or CI fails.
- Progressive enhancement is load-bearing: the page must stay readable with JS disabled and
  show finished states under `prefers-reduced-motion`.
- Binary assets are gated: any new image under `public/` must be reviewed and pinned by sha256
  in `scripts/public-surface-scan.mjs` at the repo root.
- Before pushing, run `pnpm public-surface:scan` from the repo root.
