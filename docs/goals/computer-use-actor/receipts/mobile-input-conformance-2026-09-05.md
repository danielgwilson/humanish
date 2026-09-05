# Mobile context flags do not prove repeated-tap conformance

Date: 2026-09-05. Diagnostic for [#676](https://github.com/danielgwilson/humanish/issues/676).
Two valid hosted desktop probes, zero participants and zero model calls. Humanish source
`cdfb3b266955a58cc4b2d8fe10397f6c54c9ba53`, installed `@e2b/desktop` 2.3.3. Subject: a frozen
rebuilt original of `tastejs/todomvc`'s JavaScript ES6 example at
`ff43b02e59dfa604386bb382034b2cd07c2bcd8a`. The archive's bundle and HTML hashes were checked
against the original subject provenance before upload. No subject behavior was changed.

## Correction to the earlier mobile examples

The [historical 4/4 phone-lane rename failures](mobile-emulation-2026-09-03.md) remain observations
of the then-shipped Humanish input path. They do not establish that TodoMVC rename fails on
touch devices. In the new probes, direct touch opened the same original editor in both desktops
where the SDK double click failed. A separate local native-X control reproduced that click-count
difference by changing only the mouse-to-touch conversion setting.

A correct CSS viewport, DPR, mobile user agent, touch capability and coarse pointer establish
browser context settings. They do not certify that an action reaches the app as an equivalent
touch gesture. Confirm gesture failures with direct or native touch input before attributing
them to the app. Humanish now carries this advisory in run warnings when mobile touch conversion
is applied. The action transport and bundle schema are unchanged.

## Hosted comparison: two replicas

The probes used the production guarded desktop loader, Chrome launch, 8,000 ms settle,
`applyMobileEmulation`, geometry/focus operations and `createE2BDesktopExecutor`. The only local
source seam exported two unchanged helpers for the private driver. Each allocation used the
stock desktop, 500×896 X screen and a 414×896 mobile CSS viewport. A Python server in the
sandbox served the frozen original app. No provider model or actor was instantiated.

| Action | Browser evidence, replica 1 / replica 2 | Original item editor |
| --- | --- | --- |
| Production executor → SDK `doubleClick` | Trusted touch starts 100 / 101 ms apart; click details `[1,1]`; no `dblclick` | Closed 2/2 |
| Two awaited SDK `leftClick` calls, requested 100 ms gap | Actual touch-start gaps 15,540 / 15,498 ms; click details `[1,1]` | Closed 2/2 |
| Two CDP touch start/end pairs, requested 100 ms gap | Actual gaps 107.7 / 117 ms; click details `[1,2]` and trusted `dblclick` | Open 2/2 |
| DOM `dblclick` handler control | Untrusted event with detail 2 | Open 2/2; handler control only |

The first replica tried SDK double click, SDK click pair, direct touch, then the DOM control.
The second tried direct touch, SDK click pair, SDK double click, then the DOM control. The app
was reset between cells and a synthetic task seeded before recording input. Every action
reached the same original `LABEL`, item id `1`, at CSS `(207,225)`.

A disposable full-viewport overlay measured the physical-to-CSS mapping with two known SDK
clicks before the comparison. Physical offsets were `(0,114)` and `(5,143)` in the two desktops,
with scale 1 on each axis. SDK target coordinates were adjusted using each measured mapping.
The failure was not a coordinate miss. DOM editing state and screenshots agreed.

Checkpoints before and after geometry/focus, after each reset, and after each input retained
414×896 CSS pixels, DPR 3, five touch points, coarse pointer, visual viewport scale 1 and the
declared mobile UA. No emulation reset was observed. Hosted Chrome version was not captured.

The SDK source runs `xdotool click --repeat 2 1` after `xdotool mousemove --sync`; Humanish's
`src/chrome-cdp-probe.ts` enables `Emulation.setEmitTouchEventsForMouse`. The 100/101 ms
SDK double-click gaps rule out a slow interval for those cells. Some separate SDK movements
consumed about 15 seconds; their cause was not isolated by this study and is not a claimed fix.

## Separate local native-X conversion control

Chrome 149.0.7827.114 ran headful in a disposable local Xvfb display with the same frozen app.
Native XTest motion/button events, independent of the E2B SDK and Playwright mouse injection,
formed the double clicks. Each cell had a fresh mobile context, reset app and measured
X-to-CSS coordinate mapping. Two repetitions ran for each method/setting: eight cells total.

| `Emulation.setEmitTouchEventsForMouse` | Native X double click | Direct touchscreen tap pair |
| --- | --- | --- |
| Off | `[1,2]` + `dblclick`; editor open 2/2 | `[1,2]` + `dblclick`; editor open 2/2 |
| On | Trusted touch, `[1,1]`, no `dblclick`; editor closed 2/2 | `[1,2]` + `dblclick`; editor open 2/2 |

All eight native-X-control cells completed without timeout. This isolates the conversion setting
in this tested Chrome version and reproduces the hosted click-count signature. It establishes
neither physical-device behavior nor the precise internal Chromium cause.

An earlier, separate local Playwright-mouse comparison gave a different failure: conversion-on
mouse double click timed out after 3 seconds with no click events in both repetitions. Conversion-off
mouse and direct touchscreen taps succeeded. These timeout cells are retained separately and
are not counted as replicas of the hosted `[1,1]` sequence. An initial unbounded local driver
was terminated without usable results before that capped comparison.

## Setup failures, cleanup and limits

- Two initial hosted diagnostic attempts used an insufficient 800 ms launch wait and failed
  before input recording. They are retained as invalid setup attempts, separate from the two
  valid replicas. The corrected pair imported the actual production 8,000 ms settle constant.
- All four exact owned desktops were killed and confirmed absent afterward. The local browser,
  HTTP server and Xvfb processes were closed. No model was called in any diagnostic.
- The summed acquired-handle desktop lifetimes were 126,990 ms, about $0.00584 at the harness's
  dated placeholder rate of $0.00276/minute. Actual provider billing is unknown, and allocation
  startup before a handle was returned is excluded. This is an estimate, not an invoice total.
- Raw event traces, action timing, coordinates, fidelity checkpoints, immutable app archive,
  screenshots, driver source and exact cleanup records are retained privately. This public
  receipt contains no provider identifiers, credentials or private screenshots.
- N=2 hosted replicas support this bounded conformance finding. They do not estimate human
  task success or establish physical iOS/Android, virtual-keyboard, cross-browser, accessibility
  or general gesture fidelity. The DOM handler control is not user-input evidence.
- Direct CDP touch uses CSS coordinates and touch start/end events as specified by the
  [official protocol](https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchTouchEvent).
  It is a control here, not a shipped transport replacement.
