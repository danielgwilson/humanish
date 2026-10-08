# site/: humanish.dev

The humanish.dev site is a Next.js 16 app (App Router, Turbopack). Its marketing routes are the
homepage, `/failure-modes` (the cited limits page, built from the same band vocabulary) and
`/demo` (a saved eight-participant run replayed in the Observer). Fumadocs 16 serves `/docs`.
`robots.txt`, `sitemap.xml`, an OG image route, `public/llms.txt` and its markdown twin `/llms.md`
sit alongside.

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
  A page links a repository file as `repo:<path>` (a folder ends in `/`), which
  `components/docs/mdx.tsx` opens at the release tag of the root `package.json` version.
  docs:check fails on a GitHub link to main, except for `docs/evidence/` records and
  `SECURITY.md`, and on a `repo:` path missing here or at that tag.
- `app/`: root layout (fonts via next/font, theme-init inline script, JSON-LD), `page.tsx` (the
  homepage), `failure-modes/page.tsx`, `docs/`, `api/search/`, `robots.ts`, `sitemap.ts`,
  `opengraph-image.tsx`, `icon.svg`.
- `app/demo/`: the saved-run replay page, with its own OG image.
- `app/llms.md/route.ts`: serves `public/llms.txt` as `text/markdown`.
- `app/fonts/`: three display-face subsets that `app/layout.tsx` preloads ahead of the full
  faces. Regenerate them with `scripts/subset-display-fonts.py`.
- `components/`: server-rendered sections plus client islands: hero crowd canvas, resolve
  covers, pinned replay, theme toggle, copy buttons, scroll reveals.
- `lib/`: theme plumbing shared by the canvas islands (`theme.ts`), the cover engine
  (`covers.ts`), the homepage's run facts (`site-data.ts`) and the replay tours (`tour/`).
  `pnpm site:tour --project <dir> --run <runId> --slug try-live`, from the repo root, rebuilds a
  tour and its published bundle under `public/runs/<slug>/` from a kept run, with JPEG captures,
  redacted sandbox ids and a refreshed `public/runs/ASSETS.sha256.json`. Review every frame and
  run `pnpm public-surface:scan` before committing.
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
- `lib/og-image.tsx`: the Open Graph image both `opengraph-image.tsx` routes render; each route
  passes its alt text and line. It reads the TrueType subsets in `lib/og-fonts/` (with their OFL
  texts), so the build needs no network. After a line gains a character, refetch them with
  `node site/scripts/fetch-og-fonts.mjs` and update their sha256 pins.
- `pnpm docs:generate` / `pnpm docs:check` (repo root) generate and check the CLI reference and
  llms command coverage. CI rejects drift.

## Serve the homepage and its analytics

- `proxy.ts` runs on `/` only. A request with `Accept: text/markdown` is rewritten to `/llms.md`;
  every other request passes through to `app/page.tsx`.
- `components/analytics/posthog-client.tsx` loads `posthog-js` once the page is idle. Session
  recording and surveys stay off. Without `NEXT_PUBLIC_POSTHOG_KEY` it renders nothing and
  captures nothing.

## Rules

- Existing marketing design and copy are fixtures. Preserve the approved hero and section
  vocabulary. Documentation must match the current CLI and runnable examples. Design tokens live
  once in `app/globals.css` (`:root` plus the two dark blocks), and both themes must stay in
  sync. The footer, dark in both themes, sets its own `--foot-*` colors on `.site-foot`, which
  keeps them out of the registry's token export. Rules read colors from tokens, and font sizes,
  spacing and radii from the scale in `:root` (`--text-*`, `--space-*`, `--radius-*`), which the
  registry's tokens item carries to the Observer. `pnpm site-css:check` counts the hex colors and
  px sizes still written into rules, and `pnpm site:hero:proof` fails when a hero line ends with
  one word alone at 390, 768 or 1440 px.
- Keep dependencies minimal: Next, React, Tailwind, Vercel Analytics, Fumadocs UI/Core/MDX (docs
  only) with its `zod` schema peer, `posthog-js`, and `shadcn` as a dev dependency. No motion
  libraries. The only committed font binaries are the three subsets in `app/fonts/` and the
  four OG image subsets in `lib/og-fonts/`.
- `app/globals.css` stays the single source of truth for all styling. The registry's per-item
  stylesheets are extracted from it by `scripts/extract-registry-css.mjs`; if a style change
  touches registry classes, run `registry:build` and commit the regenerated output, or CI fails.
- Progressive enhancement is load-bearing: the page must stay readable with JS disabled and
  show finished states under `prefers-reduced-motion`.
- Binary assets are gated: any new image under `public/` must be reviewed and pinned by sha256
  in `scripts/public-surface-scan.mjs` at the repo root.
- Before pushing, run `pnpm public-surface:scan` from the repo root.
