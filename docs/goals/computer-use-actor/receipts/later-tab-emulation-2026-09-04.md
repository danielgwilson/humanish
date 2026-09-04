# Mobile emulation on a tab the participant opens later (#623), live

**2026-09-04, four live runs on E2B desktops, $0.21 in all.** The lab is
`humanish/labs/later-tab-emulation.yaml` (committed dry-run; run live with `scenario.mode: live`)
over the two-page fixture in `bench/later-tab/`: a landing page whose only link opens a guide with
`target=_blank`, each page printing its own `window.innerWidth`, `navigator.maxTouchPoints` and
`devicePixelRatio`. One phone lane (`device: mobile`, `execution.desktop.fidelity.mobileEmulation:
true`), the newcomer persona, the mission "open the guide and tell me the numbers it shows".

## What the four runs showed

| run | build | first tap | guide's own numbers (participant's words) | bundle |
|---|---|---|---|---|
| `cua-2026-09-04T19-18-28-943Z-b65789a2` ($0.16) | main at #629: attach every later target PAUSED (`waitForDebuggerOnStart`), wait for each override's reply | "a normal tap opened a blank, endlessly loading tab"; reached the guide only through "Open link in new tab" | width **500**, touch **0**, DPR **1** | no `laterTargets`, no warning (the lab declared no task, so no observation ran) |
| `cua-2026-09-04T19-31-42-250Z-1b892268` ($0.02) | no pause; overrides and a reload sent without waiting for replies | opened at once, "nothing confused me" | width **414**, touch **0**, DPR **3** | `laterTargets: [{ innerWidth: 414 }]` |
| `cua-2026-09-04T19-35-25-899Z-d98f9fbe` ($0.01) | plus one reload after the first navigation commits (`Page.frameNavigated`) | opened at once | width **414**, touch **0**, DPR **3** | `laterTargets` 414 / DPR 3 / touch 5 (the live read, after the load script ran); holder log `reloadAfterNavigation: true` but no reload: the commit beat `Page.enable` |
| `cua-2026-09-04T19-38-06-794Z-b79e2eaa` ($0.01) | plus the page's own `location.href` as the second way to learn the commit happened | opened at once | width **414**, touch **5**, DPR **3** | `laterTargets` 414 / DPR 3 / touch 5; holder log: attached, then `reloaded ... by: href` |

## What the first run taught

The #629 design paused every new target before its first navigation and applied the overrides
before resuming it, and the applier waited for each override's reply. On a real desktop a popup a
participant taps open shares its opener's renderer and answers Emulation commands only once it
runs, so the applier blocked on a reply that could not come, never resumed the tab (it loaded
forever) and never reached the next one (which came up at the window's 500 px). The test that
had passed opened its later tab through `PUT /json/new`, a browser-initiated target with its own
renderer, which answers while paused; the participant's path was never in the test.

The holder now never pauses a target and never waits for a reply: overrides go out the moment the
target is attached, replies (errors included) are logged as they arrive, and each later tab is
reloaded exactly once after its first real navigation commits, learned from `Page.frameNavigated`
or from the page's own `location.href`, whichever answers first, because touch emulation reaches a
document only when it loads under the override (run 2 and 3: width and DPR followed, the load-time
touch read did not).

The holder's log now travels with the bundle (`desktopGeometry.fidelity.holderLog`), which is how
run 3 could say the reload had not fired. `laterTargets` carries the later tab's width, DPR and
touch points from the observer's own read; a later tab at the phone width but with no touch points
is a lane warning.

## Caveats

- One fixture, one participant per run. The popup here is same-site (shares the opener's renderer);
  a cross-site popup gets its own renderer and was covered by the `/json/new` test, not by a
  participant.
- The reload happens once per later tab; a page with state entered before the reload (a form the
  participant started filling in the first second) would lose it. Not observed.
