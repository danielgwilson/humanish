# site/ — humanish.dev

The humanish.dev landing page: a Next.js 16 (App Router, Turbopack) port of the approved
single-page design. One route (`/`), statically prerendered, with `robots.txt`,
`sitemap.xml`, an OG image route, and `public/llms.txt` alongside.

## Commands

From the repo root (pnpm workspace):

- `pnpm install` — installs the site workspace too
- `pnpm --filter humanish-site dev` — dev server on http://localhost:3000
- `pnpm --filter humanish-site build` — production build
- `pnpm --filter humanish-site start` — serve the production build
- `pnpm --filter humanish-site typecheck` — TypeScript only

Or run `pnpm dev` / `pnpm build` / `pnpm start` from `site/` directly.

## Layout

- `app/` — root layout (fonts via next/font, theme-init inline script, JSON-LD),
  the single page, `robots.ts`, `sitemap.ts`, `opengraph-image.tsx`, `icon.svg`
- `components/` — server-rendered sections plus client islands: hero crowd canvas,
  resolve covers, pinned replay, theme toggle, copy buttons, scroll reveals
- `lib/` — theme plumbing shared by the canvas islands, and the cover engine
- `public/study/` — the four drawDB study keyframes
- `public/llms.txt` — hand-curated agent briefing

## Rules

- Design and copy are locked; treat both as fixtures. Copy must stay verbatim,
  punctuation included. Design tokens live once in `app/globals.css` (`:root` plus the
  two dark blocks) — both themes must stay in sync.
- Keep dependencies minimal: Next, React, Tailwind. No analytics, no motion libraries,
  no committed font binaries.
- Progressive enhancement is load-bearing: the page must stay readable with JS disabled
  and show finished states under `prefers-reduced-motion`.
- Binary assets are gated: any new image under `public/` must be reviewed and pinned by
  sha256 in `scripts/public-surface-scan.mjs` at the repo root.
- Before pushing, run `pnpm public-surface:scan` from the repo root.
