# Observer watching and recorded review, September 8, 2026

Portrait captures previously filled a landscape tile by cropping their lower
portion. Finished real studies could still say “live”, and keyboard seeking,
reload and incoming frames could disagree about the selected moment. The
correction preserves native screen geometry, separates run activity from the
viewed source, and makes live/replay transitions explicit.

## Actual hosted desktop checks

Five studies used two actual computer-use participants each against the public
TodoMVC example: one 500×896 portrait desktop and one 1440×950 desktop. Each
participant added a task, remained on the page while periodic captures were
recorded, then added another task. All ten participants completed the task;
140 screenshots were retained. These are synthetic participants in a controlled
application exercise, not ten organic users or an adoption result.

| Retained run | What it establishes |
| --- | --- |
| `observer-qol-n2-20260908` | Two real actors and recorded evidence. The machine-result watch path does not retain an interactive stream server. |
| `observer-qol-attached-n2-20260908` | Exposed a black desktop preview: opaque iframe origins prevented the provider's module loading. Both actor tasks still completed. |
| `observer-qol-final-n2-20260908` | Verified real stream traffic, replay during capture growth, reconnect, reload, phone layout and transition to recorded completion. Also exposed missing in-progress viewport metadata. |
| `observer-qol-geometry-n2-20260908` | Verified native portrait proportions in the live grid and player. A later harness check timed out waiting 35 seconds for the first actor response; this is not counted as a fully passing browser walk. |
| `observer-qol-accepted-n2-20260908` | Repeated the complete walk with actual raster dimensions and a capture wait that accommodates provider latency. All seven browser checks passed, including both rendered desktops, stable paused replay, stream reload, page reload, 390px containment and recorded completion. |

The final walk observed nine provider WebSocket connections and 586 received
messages, with no page errors. Those counts demonstrate exercised transport;
they are not a connection-health signal available to the parent Observer UI.
The provider owns that signal. The UI therefore distinguishes **Live desktop**
from recorded captures without claiming that iframe loading proves a healthy
stream. Before the first capture supplies geometry, the view reports that its
screen proportions are not yet known.

All ten exact owned sandboxes were independently confirmed absent through
read-only provider inspection after cleanup. The five studies total an
estimated **$0.521569**, including 26.000232 observed desktop minutes. This is a
rate-table estimate, not a provider invoice; pre-handle startup, plan fees,
negotiated pricing and the coding operator's usage are excluded. No simulation
reservation remains unresolved for these studies.

## Entrypoints and durable evidence

A separate browser walk opened every screenshot in a 28-frame recording through
`observe`, the built headed TUI and HTML export: **84 of 84 frame opens passed**.
All three used the same current renderer. The TUI reused its session-owned
loopback server and closed it on exit. Served views reported the finished run
state. The offline export contained all 28 raster images, no runtime desktop
grant and no observed running-state overlay; it made no external requests.

Opening an existing study follows saved evidence and never launches a new
participant or recovers another process's desktop credentials. The source
checkout's pre-existing TUI loader path was not repaired by this change; the
built CLI was used for the actual TUI acceptance walk.

Raw study files, screenshots, browser recordings and provider identifiers remain
outside committed source. Generated synthetic browser fixtures and their
reproducible proof harness are committed. Failed probes remain distinguishable
from successful acceptance evidence.

## Regression coverage and limits

`pnpm observer:browser:proof` exercises the production single-file artifact with
synthetic evidence. Its 30 cases cover native geometry, live/replay state,
paused capture growth, URL navigation, failed and slow updates, missing images,
mobile controls, keyboard interaction, comparison, saved moments and bounded
large-study rendering. `pnpm observer:iframe:proof` exercises the actual serving
boundary with synthetic cross-origin modules and adversarial documents. These
commands run in CI and retain their proof artifacts.

The full repository release gate, Observer tests, TUI tests, site build,
registry checks and public-surface scan are separate from the real provider
exercise. Browser checks use Chromium on Linux. They do not establish physical
phone behavior, WebKit/Firefox coverage, or operating-system delivery of the
Escape key out of fullscreen.

Time-scrubber previews show actual captured frames. Frame-associated action and
finding navigation does not imply a screenshot exists immediately before and
after every action. There is no dedicated before/action/after triad, magnified
filmstrip hover viewer, or removal of setup overlays already present in saved
pixels. Sparse captures remain sparse; comparison exposes missing coverage and
clock uncertainty instead of inventing intermediate evidence.

The [Observer review guide](../../../architecture/observer-review.md) describes
controls and capabilities. Its interaction and browser-boundary references were
rechecked against current primary documentation on September 8, 2026.
