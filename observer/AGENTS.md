# observer/ — the rebuilt Observer (#426)

Stage-2 scaffold of the Observer v2 rebuild: a Vite + React + TypeScript-strict
workspace that renders `humanish.observer-data.v1` as a durable single-file
artifact, built on `@humanish` registry components reskinned from
`humanish-tokens`. The interaction model is the review-player spec in #426
(study grid → participant player); this workspace currently ships the chrome,
the study grid, and an honest player stub — the player itself is stage 3.

## Commands

From the repo root (pnpm workspace):

- `pnpm --filter humanish-observer dev` — dev server rendering the committed
  contract goldens (`?fixture=first-run` | `?fixture=oss`)
- `pnpm --filter humanish-observer build` — the single-file artifact at
  `observer/dist/index.html`
- `pnpm --filter humanish-observer typecheck`
- `pnpm --filter humanish-observer test` — contract lock, artifact smoke
  (build first; CI does), jsdom render tests

## Layout

- `index.html` — app shell, pre-paint register init, and the `observer-data`
  slot the CLI fills per run
- `main.tsx` / `app.tsx` — boot (inline snapshot → dev fixtures) and the frame
- `components/` — chrome, grid cards, player stub; plus vendored registry
  components (see `PROVENANCE.md`)
- `lib/` — type-only bridge to `src/observer-data.ts`, slot reading, dev fixtures
- `styles/globals.css` — chrome styles; `styles/humanish/` — vendored registry CSS
- `scripts/inject.ts` — reference slot-injection helper (the CLI adopts it at
  cutover)
- `tests/` — the architecture constraints as executable tests

## Rules

- The artifact stays self-contained: one HTML file, zero network references,
  fonts inlined from devDependencies (never committed font binaries), within
  the pre-data size budget. `tests/artifact-smoke.test.ts` enforces all of it.
- `humanish.observer-data.v1` is frozen (#429). Consume it verbatim and type it
  through `lib/observer-data.ts` (type-only import of the producer). Contract
  changes are additive and go through the root golden flow
  (`UPDATE_OBSERVER_DATA_GOLDENS=1`) with the reason in the commit message.
- Never import CLI code as a value into app code — types only. The
  contract-lock test pins the schema id without runtime coupling.
- Vendored registry files are `shadcn add` output: re-vendor with
  `--overwrite`, never hand-edit, and record refreshes in `PROVENANCE.md`.
- Register behavior is the site's three-state contract: system scheme by
  default, `data-theme` override on `<html>`, `humanish-theme` storage key.
  No new colors — every color reads a humanish token.
- The CLI consumes the built artifact behind `HUMANISH_OBSERVER=next`
  (stage 3): the root build copies `observer/dist/index.html` to
  `dist/observer-app.html`, and `src/observer.ts` injects each run's snapshot
  into the slot (mirroring `scripts/inject.ts`). Default behavior stays the
  legacy renderer (`src/observer-assets.ts`) until the parity sign-off flips
  the default at cutover (#426 stage 5).
