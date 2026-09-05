# Repeated desktop clicks avoid redundant movement

Date: 2026-09-05. Fix for [#681](https://github.com/danielgwilson/humanish/issues/681).
Measured source: `d90ee0f96dc2ac4756d7a1648272d61b421bee8c`.

## Problem and change

The stock desktop's xdotool/libxdo3 revision `1:3.20160805.1-4` waits about
15 seconds when `mousemove --sync` requests the pointer's current position.
The [older implementation](https://github.com/jordansissel/xdotool/blob/v3.20160805.1/cmd_mousemove.c)
waits for movement unconditionally; its [wait loop](https://github.com/jordansissel/xdotool/blob/v3.20160805.1/xdo.c)
allows 500 checks separated by 30 ms. SDK `@e2b/desktop` 2.3.3 moves before
coordinate-bearing clicks, so a repeated click can spend that time without
changing its target.

The executor now reads the current cursor before left and double clicks. An
exact nonnegative safe-integer match uses the SDK's supported coordinate-free
click method. All other cases retain the original coordinate-bearing call:
missing capability, malformed values, read errors, fractional action coordinates,
or a read that does not settle within 500 ms. There is no position cache or
click retry. The getter has no native timeout/signal options in SDK 2.3.3;
the bounded wait observes late rejection but does not cancel the read-only request.

An optional per-action signal reaches the executor from the loop. Cancellation
or a deadline during preparation prevents a late click. Existing one-argument
executors remain supported; wrappers must forward the signal. This does not
cancel an already-dispatched SDK operation.

## Paired hosted confirmation

Two fresh default desktops ran eight calls each, comparing direct SDK calls with
the actual changed executor. Neither called a model. Each used Chrome
150.0.7871.114, SDK 2.3.3 / base SDK 2.46.1, the package revision above, and a
1280×1024 desktop. A neutral local page recorded trusted browser events; SDK
cursor readback and command timing were also retained. Method order reversed in
the second replica. A 650 ms interval between trials avoided carrying click
counts between cases and is excluded from the API duration.

| Action | Direct SDK, replica 1 / 2 | Changed executor, replica 1 / 2 |
| --- | --- | --- |
| Left click at current position | 15,476 / 15,529 ms | 249 / 255 ms |
| Left click at a new position | 245 / 254 ms | 321 / 328 ms |
| Double click at current position | 15,549 / 15,610 ms | 350 / 358 ms |
| Double click at a new position | 345 / 353 ms | 417 / 429 ms |

All 16 calls delivered the expected number of trusted mouse clicks to the
requested screen coordinates on the recorder. Each double-click trial produced
click detail 1, click detail 2, and one `dblclick`. Current-position cases kept
the same before/after cursor position; new-position cases moved to the requested
target. Screenshots confirmed the neutral recorder surface.

The fresh read added 72–76 ms in the new-position comparisons. These API
durations include transport and probe recording overhead; they are not a
general end-to-end study latency estimate. A preceding diagnostic independently
timed xdotool inside two sandboxes: same-position movement took 15,114 / 15,190 ms,
versus 3.55 / 2.83 ms for a new position. A free Xvfb control with the same
package revision and actual SDK methods reproduced the wait.

Both confirmation desktops were killed through their owned handles, then
individually confirmed absent. Recorded acquired-handle desktop estimate:
**$0.004918734**, using the repository's provisional rate. Provider billing and
allocation-before-handle time are not measured. Full diagnostic captures,
screenshots, and resource identifiers remain operator-held.

## Proof and limits

The preceding diagnostic had four allocations: two invalid setups followed by
two valid replicas. The failing setup command's stderr was not retained, so its
exact cause remains unavailable. Both invalid attempts are preserved separately;
all four resources were reclaimed. Corrected scheduling stops after an invalid
setup, and readiness is measured before trials. The confirmation above had two
attempts, both valid, with no replacements.

Focused regressions cover exact/mismatched coordinates, missing and malformed
reads, fractional-coordinate fallback, errors, bounded timeout, late settlement,
no click retry, successive actions and shared-world roles, independent concurrent
desktop seats, and actual installed SDK dispatch. Real-loop tests verify abort
and deadline handling through a transparent executor wrapper, with no late click
or falsely completed action. The focused set passed 135 tests; the full release
gate passed 2,044 core tests and 49 TUI tests.

This is a desktop executor mechanism check, not a participant or app-success
study. Mobile touch conversion was not exercised; [#676](https://github.com/danielgwilson/humanish/issues/676)
remains separate. Right/middle clicks, standalone movement, and scrolling retain
their existing dispatch. Fractional coordinates and unavailable reads can still
take the original movement path. Shared-world roles either act sequentially on
one desktop or concurrently on separate desktops; this does not establish
atomicity against an external cursor mover between the read and click.
