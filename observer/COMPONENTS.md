# Observer component ownership and proof

The Observer uses Humanish registry tokens throughout. Registry output is
checked for source drift in the site workspace; rendering and interaction are
checked in the built Observer. Passing one does not imply the other passed.

| Component or surface | Owner | Behavioral and visual proof |
| --- | --- | --- |
| Tokens, persona lane, terminal cast | Vendored `@humanish` registry output; see `PROVENANCE.md` | Registry adopter checks, artifact smoke, grid/terminal browser cases |
| Icon buttons and tooltips | `components/ui/icon-button.tsx`, Base UI Tooltip | Accessible names, stable icon geometry, focus/dismissal and touch targets in grid cases |
| Popovers and study utilities | `components/ui/popover.tsx`, Base UI Popover | Details, filter, saved-moment and library journeys exercise dismissal, persistence and ordinary buttons |
| Selects and checkboxes | `components/ui/select.tsx` / `checkbox.tsx`, Base UI | Shared token styling, selected indicators, nested Escape/focus, typeahead, long-menu scrolling, phone tap targets and fullscreen portal placement |
| Theme, pin state and chrome motion | `theme-toggle.tsx`, `participant-card.tsx`, `chrome-polish.css` | Single theme glyph, theme/pin persistence, full-image fit at phone widths, inert collapsed library, playback continuity and reduced-motion transitions |
| Phone study library | `components/ui/drawer.tsx`, Base UI Dialog | Phone library journey checks open/close, usable evidence after dismissal and no page overflow |
| Study navigation | Semantic links in `app.tsx`; study identity remains in `Topbar` | Findings and ordinary review cases check stable outer geometry, active branch, exact return source and reload |
| Finding disclosure | Base UI Accordion in `study-report.tsx`; native caveat disclosures | Collapsed ranked list, keyboard expansion, directly cited representative captures, exact evidence links, visible uncertainty, full caveats, bounded previews, empty/error/stale states and long content |
| Findings overview | `study-report-overview.tsx`; structured analysis projection | Compact first viewport, separately labeled analyzed outcomes and capture sampling, original summary and notes, keyboard disclosures, separate automatic-attempt status, stale denominator suppression |
| Participant inspector | Base UI Tabs in `player.tsx` | Actions, Details and Feedback retain their existing panel/keyboard semantics; recorded evidence remains distinct from analysis |
| Participant statements and analysis | Native disclosures and source links in `participant-feedback.tsx` / `participant-analysis.tsx` | Statement pagination, original evidence navigation, per-speaker attribution, observation basis, stale interpretation and outcome explanation |
| Playback scrubber | Native range input in `player.tsx`; application-owned CSS and marker overlay | Painted thumb/track alignment, endpoints, mouse/touch/keyboard behavior, focus and deliberately broken negative control |
| Study playback | `study-playback.tsx`, shared native scrubber CSS, `grid-recording.ts` | One recorded capture clock across the grid; sparse and unavailable coverage, visible capture age, exact frame handoff/return, snapshot replacement, live-preview isolation, desktop/phone thumb alignment |
| Search fields and scrubbers | Application-owned native inputs styled with Humanish tokens | Filter persistence, honest empty results, phone containment, painted geometry and keyboard journeys |
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
pnpm observer:chrome:proof
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
