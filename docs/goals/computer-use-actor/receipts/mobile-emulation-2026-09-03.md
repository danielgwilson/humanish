# A phone participant at a real 414 px viewport, with touch and a mobile user agent

Date: 2026-09-03, branch `feat/mobile-emulation-221` (PR #618). Subject: drawDB, depth-1 clone,
the persona-axis mission (two related tables). Two lanes: the mouse newcomer on the desktop preset
and the same persona on `device: mobile`, with `execution.desktop.fidelity.mobileEmulation: true`.

## What the bundle recorded for the phone lane

```
screen:   requested 500x896, declared { 414x896, preset: mobile }, verified 500x896 (xdpyinfo)
viewport: 414x896, deviceScaleFactor 3, source cdp
fidelity: tier mobile-emulated
  applied:  Emulation.setDeviceMetricsOverride, Emulation.setTouchEmulationEnabled,
            Emulation.setEmitTouchEventsForMouse, Emulation.setUserAgentOverride, Page.reload
  resolved: userAgent "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ... Mobile/15E148 Safari/604.1"
            devicePixelRatio 3, innerWidth 414, innerHeight 896, maxTouchPoints 5, coarsePointer true
```

`resolved` is what the page reported about itself after emulation, read through the same
DevTools probe the harness uses for every observation; nothing in it is copied from the request.
Earlier today the same lane rendered a 500 px desktop window with a desktop user agent and no
touch (`persona-axis-phone-2026-09-03.md`), because Chrome will not draw a narrower window.

## Result

| run | desktop newcomer (1440x950) | phone newcomer (414x896, emulated) |
|---|---|---|
| `cua-2026-09-03T22-30-47-356Z-de6c8664` | REACHED; tables landed on top of each other, dragging did not separate them, finished through the DBML view | BLOCKED: "the mobile layout left only a narrow strip of the canvas visible. After hiding the sidebar, the tables appeared overlapped or off-screen, and dragging did not reposition them ... The relationship could not be completed." |
| `cua-2026-09-03T22-43-12-321Z-52eab4c5` (branch at d6bfd75) | REACHED; same overlap, recovered by importing SQL; no `fidelity` block on this lane (desktop preset, untouched) | ran out its 300 s budget after 63 actions and 38 turns without a closing report; `fidelity.resolved` again iPhone UA, DPR 3, 414 px, 5 touch points |

Cost: $1.05 and $1.15 per run (two desktops, up to 300 s each).

The first phone participant met the same defect class the two 500 px phone participants met
earlier today (a canvas mostly hidden at phone width, relationship creation by drag failing), now
on a viewport the app's own responsive rules treat as a phone; the second spent its whole budget
working and did not finish. Both desktop newcomers finished, both by falling back to SQL after
the tables overlapped.

## TodoMVC on the published 0.76.0: touch changes the outcome

Same shape on `tastejs/todomvc` (`examples/javascript-es6/dist`, served by python3), the four
declared tasks from the persona-axis lab, run from a fresh `npm i -D humanish@0.76.0` by path.

| run | desktop newcomer | phone newcomer (414x896, emulated, touch) |
|---|---|---|
| `cua-2026-09-03T23-40-18-531Z-571257e1` | REACHED; hover-only delete noted | BLOCKED: "the app says Double-click to edit, but repeated double-taps on the mobile layout only selected text and never opened an editor ... no touch-friendly edit control" |
| `cua-2026-09-03T23-40-28-532Z-c71acd5f` | REACHED; hover-only delete noted | DID NOT REACH THE GOAL: "repeated double-click/double-tap attempts did not open editing ... the delete control only appeared on hover, a confusing interaction for a mobile/touch layout" |

Cost: $0.17 and $0.19 per run. Task funnel: add-tasks, complete-one, filter-completed,
filter-active each 2/2 in both runs (16 of 16 measured); the rename has no observable criterion
and is where both phone participants stopped.

Earlier the same evening, at 500 px with no touch emulation, both phone participants on TodoMVC
finished and only *called* the double-click rename touch-hostile (`persona-axis-phone-2026-09-03.md`).
With touch events emulated, neither could rename at all: a double-tap selects text and the
`dblclick` editor never opens. The responsive-viewport study reported an opinion; the
mobile-emulated study reported a blocker. That difference is the reason the bundle labels the
tier.

## drawDB again on 2026-09-04, on main at #636 (the 0.77.0 build)

Same emulated drawDB lab, two runs from the primary checkout's build, 40 s apart, after the
later-tab applier landed (`later-tab-emulation-2026-09-04.md`).

| run | desktop newcomer | phone newcomer (414x896, emulated, touch) |
|---|---|---|
| `cua-2026-09-04T19-47-41-731Z-78b6bd67` ($0.81) | REACHED; "new tables initially overlapped exactly ... Auto arrange resolved this" | ran out of the 300 s session after 77 material actions over 43 turns |
| `cua-2026-09-04T19-48-21-733Z-6a3c4fcf` ($1.25) | REACHED; "every new table appeared at the same position ... used the Code view to define the relationship" | REACHED; "the mobile canvas was mostly hidden behind the sidebar, and dragging or repositioning tables did not work clearly ... I used the built-in DBML view to add `Ref: posts.user_id > users.id`" |

Both phone lanes read back 414 px, DPR 3, five touch points from the page; neither participant
opened a second tab, so neither bundle carries `laterTargets`. Across the four emulated drawDB
phone lanes since 09-03: one blocked, one out of budget, two reached, and every one of the three
that reported named the canvas or the drag. Both desktop newcomers this time reached the goal by
way of the Code or Auto-arrange controls after the stacked-tables confusion, which is the same
finding the 09-01 and 09-03 desktop participants reported.

## What the first run taught (fixed on the branch before merge)

- The run-wide flag had also emulated the desktop newcomer (1440x950 with `mobile: true` and an
  iPhone user agent; the bundle recorded it faithfully). Emulation now applies only to lanes on a
  mobile preset; the other lanes carry no `fidelity` block.
- Under emulation the page's `window.outerWidth` reports the emulated 414, so the geometry fill
  check warned "did not reach the requested 500x896". The fill check now reads the X window
  bounds when they were measured; in the second run those read 508x896 against a 500-wide
  screen, which is Chrome's own minimum window overshooting the floored screen, and the warning
  is right to say so.

## Not verified

- A tab the participant opens later was NOT covered by this design: the viewport and DPR override
  were bound to the launch page's DevTools session. Closed on 2026-09-04 (#623, #636) with four
  live runs: `later-tab-emulation-2026-09-04.md`.
- Real device or simulator fidelity, which #221 keeps as a later tier.
