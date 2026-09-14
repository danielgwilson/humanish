# Observer component ownership and proof

The Observer uses Humanish registry tokens throughout. Registry output is
checked for source drift in the site workspace; rendering and interaction are
checked in the built Observer. Passing one does not imply the other passed.

| Component or surface | Owner | Behavioral and visual proof |
| --- | --- | --- |
| Tokens, persona lane, terminal cast | Vendored `@humanish` registry output; see `PROVENANCE.md` | Registry adopter checks, artifact smoke, grid/terminal browser cases |
| Icon buttons and tooltips | `components/ui/icon-button.tsx`, Base UI Tooltip | Accessible names, stable icon geometry, focus/dismissal and touch targets in grid cases |
| Popovers and study utilities | `components/ui/popover.tsx`, Base UI Popover | Details, filter, saved-moment and library journeys exercise dismissal, persistence and ordinary buttons |
| Phone study library | `components/ui/drawer.tsx`, Base UI Dialog | Phone library journey checks open/close, usable evidence after dismissal and no page overflow |
| Study navigation | Semantic links in `app.tsx`; study identity remains in `Topbar` | Findings and ordinary review cases check stable outer geometry, active branch, exact return source and reload |
| Finding disclosure | Base UI Accordion in `study-report.tsx` | Collapsed ranked list, keyboard expansion, evidence links, bounded previews, empty/error/stale states and long content |
| Participant inspector | Base UI Tabs in `player.tsx` | Actions, Details and Feedback retain their existing panel/keyboard semantics; recorded evidence remains distinct from analysis |
| Participant statements and analysis | Native disclosures and source links in `participant-feedback.tsx` / `participant-analysis.tsx` | Statement pagination, original evidence navigation, per-speaker attribution, observation basis, stale interpretation and outcome explanation |
| Playback scrubber | Native range input in `player.tsx`; application-owned CSS and marker overlay | Painted thumb/track alignment, endpoints, mouse/touch/keyboard behavior, focus and deliberately broken negative control |
| Other native inputs/selects | Application-owned controls using Humanish tokens | Filter/density persistence, honest empty results, phone containment and keyboard journeys |
| Comparison and saved moments | Application-level composition over the same evidence and primitives | Exact handoff, per-run clock limits, storage contents, re-entry and explicit origin |

A focus-managed interaction starts with Base UI. Static composition and native
controls can stay application-owned when their observable behavior is covered.
Promote a component through the registry source and adopter workflow when
another surface needs the same abstraction. Never edit vendored output by hand.

Run the ordinary build and tests, then the declared browser ledger:

```bash
pnpm --filter humanish-observer build
pnpm --filter humanish-observer test
pnpm observer:browser:proof
```

The browser command retains screenshots, pixel/DOM measurements, network
receipts, failures and the coverage ledger under ignored `.humanish/`. Open the
gallery and assess whether the screenshots establish the stated user outcomes.
Inspect negative-control screenshots as evidence of rejection, not as passing
product captures. Do not replace a failed behavioral assertion with an updated
expected value unless the intended behavior itself changed and is explained.

This ledger targets Chromium and touch emulation. WebKit/Firefox, physical
devices and assistive-technology certification remain separate acceptance work.
Provider operation, real CLI/TUI entrypoints, exports and analysis quality are
also separate from synthetic renderer proof. Their absence must stay visible
in the proof manifest rather than becoming a general release-quality claim.
