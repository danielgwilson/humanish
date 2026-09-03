# A third axis: the phone-sized newcomer met defects neither desktop participant met

Date: 2026-09-03, humanish main at #605 (0.75.0 candidate). Two apps, three participants each,
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

## What this does and does not show

- The device preset is enforced by the harness, so the difference is not a matter of the
  participant following an instruction; the affordance record and the viewport in each bundle
  are the evidence of what it actually used and saw.
- n=2 per cell per app. The drawDB phone finding replicated across both runs (popover
  interception) while the outcome varied (reached, blocked), which is the within-arm variance the
  2026-08-26 handoff warned about; on TodoMVC the phone participants finished both times.
- 500 px is not a phone. A 414 px CSS viewport (#221) may hide more, or less.
