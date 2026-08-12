# Vendored component provenance

This workspace consumes the `@humanish` registry the way any adopter would —
`shadcn add` against the live endpoints — so the adopter flow stays dogfooded.
Vendored files are registry output: do not hand-edit them; re-vendor with
`pnpm exec shadcn add <item> --overwrite` and record the refresh here.

| Registry item | Files | Source |
| --- | --- | --- |
| `@humanish/humanish-tokens` | `styles/humanish/humanish-tokens.css` | https://humanish.dev/r/humanish-tokens.json |
| `@humanish/persona-lane` | `components/persona-lane.tsx`, `components/cover-canvas.tsx`, `lib/humanish/covers.ts`, `lib/humanish/theme.ts`, `styles/humanish/persona-lane.css` | https://humanish.dev/r/persona-lane.json |
| `@humanish/terminal-cast` | `components/terminal-cast.tsx`, `styles/humanish/terminal-cast.css` | https://humanish.dev/r/terminal-cast.json |

Last vendored: 2026-08-12, registry as published from site commit `c7a3c07`
(the registry serves built output of `site/registry.json`; regenerate there
with `pnpm --filter humanish-site registry:build`).

Adopter-flow findings from vendoring (kept honest, good or bad):

- `shadcn add @humanish/<item> --yes` worked first try against the live
  registry from a bare Vite workspace: 8 files, correct targets, install docs
  printed. No Next-specific imports leaked into any vendored file; `"use
  client"` directives are inert no-ops under Vite.
- The registry's install docs assume a `app/globals.css`-relative import path
  (`../styles/humanish/...`); a consumer whose global CSS lives at
  `styles/globals.css` imports `./humanish/...` instead. Cosmetic, but a
  literal copy-paste of the printed instruction would fail.

Hand-copied (not registry-served) with source references:

- `components/wordmark.tsx` — copied from `site/components/wordmark.tsx`
  (classes styled per `site/app/globals.css` `.wm`/`.ish` rules). Promoting the
  wordmark lockup to a registry item is filed as a follow-up so consumers can
  stop hand-copying it.
