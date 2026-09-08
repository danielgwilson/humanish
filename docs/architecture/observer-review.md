# Watching and reviewing evidence

Observer shows a study's participants, their recorded screens, and the events
that explain those screens. The grid, player and exported HTML use the same
current renderer. Screens fit their actual aspect ratio; a portrait capture is
never cropped to fill a landscape tile.

## Choose the right entry point

`humanish watch <lab>` starts a study and keeps its viewer attached. The process
that owns a hosted desktop can offer its live stream while it runs. `--no-open`
keeps that attachment without launching a browser. `--json` is the machine-result
path and does not keep an interactive stream server attached.

`humanish observe --run <id>` opens an existing study without starting another.
The TUI's **Open Observer** action does the same through its session-owned
loopback library. These entry points follow saved captures; they cannot recover
live desktop credentials owned by another process. Keep the owning CLI or TUI
open while using its viewer. Exported HTML is an independent offline recording.

## Read status without guessing

The top band separates the run's current status from evidence freshness. A
finished study never uses its execution mode (`live`, as opposed to `dry-run`)
as a claim that it is still running. When updates fail, the last usable evidence
stays visible, the band reports the failure, and **Retry** requests another
snapshot. A stale process heartbeat does not prove that the process died.

A player's **Live desktop** label identifies what it displays. An iframe loading
is not a connection-health signal: the provider owns that connection. **Reload
stream** reloads the desktop viewer without restarting a participant. **Latest capture**
follows the latest saved screenshot without a desktop stream. **Replay** means
the researcher has chosen a recorded moment. Offline exports say so explicitly.

Freshness uses recorded activity and capture timestamps, not the time the server
reserialized the same data. Browser tabs poll less frequently while hidden and
refresh when visible again. Requests are serialized, bounded by a timeout and
cancelled when the viewer closes.

## Work through a study

Previews share a height and wrap into rows; desktop cards are wider and portrait
cards narrower. Complete screens remain contained when the available width is
smaller than a preview. Sparse rows keep their chosen size. Open **View and filter
participants** in the top right to search, change **Preview size**, or enter
**Monitor** for a larger evidence area. **Exit monitor** stays beside the run status.
The card's **Pin** icon keeps selected participants at the beginning. Ordering changes only
when the researcher changes it. Large studies have reachable participant pages.
At most four desktop previews attach in the grid; allocation prioritizes screens
that are actually visible, with the hovered or keyboard-focused participant taking
priority. Other cards show their latest saved capture.

Each card keeps one compact participant/outcome caption. Pin, Compare and details
icons appear on hover or keyboard focus and remain visible on touch devices.
The details popover contains final messages, notices, duration and dimensions.
Notice indicators and exceptional outcomes stay visible without opening it.
The bookmark icon in the top bar opens **Saved moments**.

Opening a participant provides elapsed-time seeking, the original frame number,
playback speed, **Fit**, **Actual size**, zoom/pan and fullscreen. The inspector can
be hidden or resized. Click markers use the recorded desktop coordinate system
and the image's rendered rectangle, including at zoomed sizes.

Arrow keys, mouse controls, same-participant links, browser navigation and reload
agree about the selected moment. Seeking leaves live mode. Pausing on the newest
frame stays paused when new evidence arrives; **Go live** explicitly resumes
following. A missing addressed moment is reported instead of silently replaced.

Screenshot playback is sparse evidence, not a video recording. Capture gaps stay
visible. **Skip waits** compresses intervals associated with recorded waits and
reports the skipped duration. **Next action**, **Next finding**, activity filters
and grouped waits make long traces easier to inspect without deleting events.
Older unstamped recordings use labeled estimated pacing. Long feeds, filmstrips,
terminal output and event lists stay bounded while earlier/later content remains
reachable.

**Copy moment link** creates a frame address; denied clipboard access exposes a
selectable link. **Original frame** opens/downloads the captured raster. **Saved
moments** keeps bounded run/participant/frame identifiers in this browser. It does
not save credentials, publish annotations or change the evidence bundle. Storage
failure leaves the controls usable for the current visit.

## Compare recorded evidence

Select participants and open **Compare selected**. Capture-time alignment chooses
the latest frame at or before the cursor, never a future frame. Before/after
coverage and each frame's age are explicit. Clock differences between desktops
remain an uncertainty; matching timestamps alone do not establish causality.

Elapsed-time alignment starts each participant at its first capture and compares
progress rather than simultaneous events. Missing or descending timestamps cannot
be used as a shared clock. Another run can be loaded from the available library
as recorded evidence. The address retains the chosen runs, participants, clock
and cursor so reopening it restores the comparison.

## Boundaries and checks

Only the attached process can grant a desktop iframe its own origin for provider
module loading. Stored grants are removed, exports contain no runtime grants,
and every local viewer response refuses to be framed. Generic imported embeds
retain an opaque sandbox. Artifact and history links cannot introduce arbitrary
URL schemes or traverse outside their evidence roots.

`pnpm observer:browser:proof` exercises generated synthetic evidence in the
production artifact. `pnpm observer:iframe:proof`, after `pnpm build`, checks the
actual serving boundary against direct, redirected and scripted iframe attacks.
CI retains their screenshots and JSON receipts. These Chromium checks do not
claim physical-device or non-Chromium coverage. Actual provider checks and their
resource-cleanup receipts are separate acceptance evidence.

Interaction references rechecked September 8, 2026:
[Base UI popover](https://base-ui.com/react/components/popover),
[React state structure](https://react.dev/learn/choosing-the-state-structure),
[WAI-ARIA tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/),
[iframe sandboxing](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe),
[Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer), and
[PostHog recording controls](https://posthog.com/docs/session-replay/how-to-watch-recordings).
