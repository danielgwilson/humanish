# observer/: the Observer page

The Observer is a Vite + React + TypeScript workspace that renders
`humanish.observer-data.v1` as a durable single-file artifact using the
`@humanish` registry tokens. It includes the participant grid, live/recorded
player, evidence inspector, local saved moments and comparison views.

## Commands

From the repo root (pnpm workspace):

- `pnpm --filter humanish-observer dev` runs a dev server that renders the committed contract
  goldens (`?fixture=first-run`, `?fixture=oss` or `?fixture=live`).
- `pnpm --filter humanish-observer build` writes the single-file artifact to
  `observer/dist/index.html`.
- `pnpm --filter humanish-observer typecheck`
- `pnpm --filter humanish-observer test` runs the contract lock, the artifact smoke and the jsdom
  render tests. The artifact smoke reads the built file, so build first.
- `pnpm build` (repo root) builds the CLI and copies the artifact to `dist/observer-app.html`.
  The browser proofs below need it.
- `pnpm observer:iframe:proof`, `pnpm observer:browser:proof`, `pnpm observer:chrome:proof` and
  `pnpm observer:reliability:proof` are the browser proofs CI's observer job runs after the root
  build. They drive a local Chrome or Chromium; CI installs one with
  `pnpm exec playwright-core install --with-deps chromium`. The iframe proof checks the live
  iframe trust boundary, and the chrome proof checks appearance, pin visibility, library motion
  and card geometry. None of them needs a provider or credentials.

## Layout

- `index.html`: app shell, pre-paint register init, and the `observer-data` slot the CLI fills
  per run.
- `main.tsx` / `app.tsx`: boot (validated inline snapshot → polling → dev fixtures) and the
  frame.
- `components/`: chrome, grid cards, review player and comparison, plus vendored registry
  components (see `PROVENANCE.md`).
- `lib/`: type-only bridge to `src/observer/data.ts`, slot reading, dev fixtures.
- `styles/globals.css` holds the chrome styles; `styles/humanish/` holds the vendored registry
  CSS.
- `scripts/inject.ts`: the reference slot-injection helper. Since the 2026-08-16 cutover,
  `src/observer/artifact.ts` mirrors it.
- `tests/`: the architecture constraints as executable tests.

## Rules

- The artifact stays self-contained: one HTML file, zero network references,
  fonts inlined from devDependencies (never committed font binaries), within
  the pre-data size budget. `tests/artifact-smoke.test.ts` enforces all of it.
- `humanish.observer-data.v1` is frozen (#429). Consume it verbatim and type it
  through `lib/observer-data.ts` (type-only import of the producer). Contract
  changes are additive and go through the root golden flow
  (`UPDATE_OBSERVER_DATA_GOLDENS=1`) with the reason in the commit message.
- Import CLI code into app code as types only, never as a value. The
  contract-lock test pins the schema id without runtime coupling.
- Vendored registry files are `shadcn add` output: re-vendor with
  `--overwrite`, never hand-edit, and record refreshes in `PROVENANCE.md`.
- Register behavior is the site's three-state contract: system scheme by
  default, `data-theme` override on `<html>`, `humanish-theme` storage key.
  No new colors: every color reads a humanish token, and every font size, spacing
  and radius reads a scale token (`--text-*`, `--space-*`, `--radius-*`).
- The CLI consumes the built artifact as its only renderer (cutover 2026-08-16,
  #439): the root build copies `observer/dist/index.html` to
  `dist/observer-app.html`, and `src/observer/artifact.ts` injects each run's snapshot
  into the slot (mirroring `scripts/inject.ts`). In a repo checkout the
  artifact auto-builds (production-forced, cross-process locked). There is no
  flag and no legacy fallback; rollback is a version pin.
- Mobile is a first-class requirement (2026-08-16): every surface must be
  usable at phone width. The pattern: one breakpoint (880px), the static
  sidebar yields to the Base UI drawer, the player stacks stage-over-inspector
  with the page owning scroll and the feed keeping its own bounded scroller,
  and wide content scrolls inside its own container, so the page never scrolls
  sideways. Verify changes at 390px with real bundle data as well as on desktop.
- Interactive primitives start from Base UI (D6): anything needing focus
  management, dismissal, or overlay behavior wraps a `@base-ui/react`
  primitive (vendored under `components/ui/`, styled only by humanish tokens),
  never a hand-rolled portal. Static idioms (cards, chips, labels) stay
  token-styled CSS. Wrapped primitives are registry-promotion candidates once a
  second surface consumes them.
