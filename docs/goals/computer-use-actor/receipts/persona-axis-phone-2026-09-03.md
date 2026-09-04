# A third axis: the phone-sized newcomer met defects neither desktop participant met

Date: 2026-09-03, humanish main at #605 (0.75.0 candidate); the Excalidraw runs at #615. Three
apps, three participants each,
same mission per app, per-lane worlds, blurred capture. Two participants differ by persona (the
2026-09-01 contrast: `skeptical-power-user`, keyboard-first, and `synthetic-new-user`, a mouse
newcomer). The third is the newcomer persona on `device: mobile`, a harness-enforced axis: the
desktop renders at the preset's floored width (500 px, see `MIN_DESKTOP_RENDER_WIDTH`; true 414 px
emulation is #221), so the participant is not asked to pretend anything.

## drawDB (`drawdb-io/drawdb`, depth-1 clone, mission: two related tables)

| run | keyboard-first | mouse newcomer | phone newcomer (500x805) |
|---|---|---|---|
| `cua-2026-09-03T21-17-11-267Z-bde2251d` | BLOCKED at the database modal: "no keyboard-accessible database options ... Confirm remains disabled"; 18 keyboard, 0 pointer actions | REACHED; tables stacked on top of each other, drag "failed", recovered by importing SQL | REACHED; tables overlapped, "field-detail popovers intercepted relationship dragging", disabled Field details to finish |
| `cua-2026-09-03T21-17-26-488Z-fa1acb70` | REACHED, with the mouse: "several controls and relationship creation required mouse interaction, which is a keyboard-accessibility defect"; 36 keyboard, 16 pointer | REACHED; tables "overlapped exactly and appeared locked", Auto arrange resolved it | BLOCKED: "the mobile layout initially hid most of the canvas, and dragging between fields repeatedly opened detail popovers or a temporary red-minus state without saving a relationship ... Relationships count remained 0" |

Cost: $1.54 and $1.73 per run (three desktops, up to 300 s each).

What each axis found, in the participants' own words:

- Keyboard-first, both runs: the database-picker modal cannot be driven from the keyboard. With
  the three 2026-09-01 runs this is now 5 of 5 keyboard-first participants reporting that modal
  across two days (3 of 5 stopped there, 2 of 5 used the mouse and said so); 0 of 5 mouse
  participants mentioned it.
- Mouse newcomer, both runs: newly created tables land exactly on top of each other and look
  locked; both recovered (Auto arrange, or SQL import). The keyboard-first participant in the
  second run hit the same overlap.
- Phone newcomer, both runs: relationship creation by drag is intercepted by the field-detail
  popover, and at 500 px the canvas is mostly hidden at first. One participant worked around it
  by turning Field details off; the other stopped with zero relationships. Neither desktop
  participant reported the popover interception.

## TodoMVC (`tastejs/todomvc`, `examples/javascript-es6/dist`, served by python3)

Four observable tasks were declared (`3 items left` in the page text, `2 items left`, the
`#/completed` route, the `#/active` route). On 0.74.0 this subject had no DevTools probe at all
(#514), so the funnel would have read "never measured"; here it read 3/3 on every task in both
runs, corroborated from page text and URL, with the participants never shown the criteria.

| run | keyboard-first | mouse newcomer | phone newcomer (500 px) |
|---|---|---|---|
| `cua-2026-09-03T21-25-21-628Z-55219121` | BLOCKED: "could not rename or delete a task using the keyboard ... F2 and Delete had no effect ... Double-click to edit makes editing mouse-only"; 21 keyboard, 0 pointer | REACHED; hesitated at the hover-only delete `×` | REACHED; "double-click ... is not natural on a mobile touchscreen", the `×` "stayed hidden until hover, another desktop-oriented interaction", bottom controls "cramped near the screen edge" |
| `cua-2026-09-03T21-25-33-624Z-b8223332` | BLOCKED: "task labels are absent from the keyboard tab order"; deleted via Clear completed and flagged it has no confirmation or undo; 20 keyboard, 0 pointer | REACHED; hover-only `×` again | REACHED; double-click "not natural on a mobile/touch device", `×` "subtle and lacked a confirmation step" |

Cost: $0.31 and $0.29 per run. Funnel: 4 tasks x 3 participants x 2 runs = 24 of 24 measured
and completed.

Across the two apps: keyboard-first participants are now 6 of 6 blocked at TodoMVC's rename
(4 on 2026-09-01, 2 here) and 5 of 5 reporting drawDB's modal. The phone participants did not
add a new blocker on TodoMVC; what they added is the framing: both read the double-click rename
and the hover-only delete as touch-hostile, which a desktop participant has no reason to say.

## Excalidraw (`excalidraw/excalidraw`, depth-1 clone, `yarn build:app:docker`, served by python3)

A third app, added the same evening: a pointer-first canvas with documented keyboard shortcuts.
Mission: two labelled boxes joined by an arrow.

| run | keyboard-first | mouse newcomer | phone newcomer (500 px) |
|---|---|---|---|
| `cua-2026-09-03T21-55-10-996Z-6cf5b809` | REACHED; "Nothing was confusing; I briefly verified the keyboard tool shortcuts before drawing"; 9 keyboard, 5 pointer (drawing is pointer work and the participant did it without flagging it) | REACHED; "briefly hesitated when the first label did not appear; reselecting the box and pressing Enter resolved it" | REACHED; "the mobile toolbar icons were initially unlabeled, so I hesitated briefly while identifying the rectangle, text, and arrow tools" |
| `cua-2026-09-03T22-03-47-641Z-d3a4de57` | REACHED; "My first rectangle drag collapsed because the path ended incorrectly; the lack of feedback was briefly confusing, so I redrew it"; 17 keyboard, 7 pointer | REACHED; "briefly hesitated over the unlabeled toolbar icons, but their shapes were recognizable" | REACHED; unlabeled toolbar icons again, and "text-entry completion was slightly unclear because the cursor overlapped the labels while editing" |

Cost: $0.22 and $0.20 per run (the build is quick and the sessions were short).

Six of six reached on a well-made app. The observations are hesitations, not blockers: the
unlabelled toolbar icons came up for both phone participants and for one desktop newcomer, so
that one is not phone-specific; the collapsed first drag and the cursor overlapping the label
are each n=1. Both keyboard-first participants drew with the pointer without flagging it, which
is the honest answer for a canvas. The first run's keyboard-first report, "Nothing was confusing",
was tallied as reported friction by the harness on that build; that false positive is what
#614 / #616 removed.

## What this does and does not show

- The device preset is enforced by the harness, so the difference is not a matter of the
  participant following an instruction; the affordance record and the viewport in each bundle
  are the evidence of what it actually used and saw.
- n=2 per cell per app, three apps. The drawDB phone finding replicated across both runs (popover
  interception) while the outcome varied (reached, blocked), which is the within-arm variance the
  2026-08-26 handoff warned about; on TodoMVC and Excalidraw the phone participants finished
  every time. A clean app reads as a clean app: Excalidraw produced no blocker on any axis.
- 500 px is not a phone. The same evening, 0.76.0 shipped mobile emulation (#221): the phone
  participant at a real 414 px viewport with touch and a mobile user agent was blocked on drawDB
  again, and on TodoMVC could not rename at all where these 500 px participants had finished.
  See `mobile-emulation-2026-09-03.md`.
