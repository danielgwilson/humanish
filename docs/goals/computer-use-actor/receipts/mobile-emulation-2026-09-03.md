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

- Behaviour on a tab the participant opens later: the user agent and touch flags are browser-wide
  (launch flags), the viewport and DPR override are bound to the launch page's DevTools session.
- Real device or simulator fidelity, which #221 keeps as a later tier.
