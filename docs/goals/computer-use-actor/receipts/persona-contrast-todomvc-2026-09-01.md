# The persona axis on a second app: 4 of 4 keyboard-first participants reported TodoMVC's mouse-only rename

Date: 2026-09-01, humanish 0.68.0 and main at #579. Subject: TodoMVC `javascript-es6` at
`tastejs/todomvc@ff43b02`, served from its committed `dist/`. Lab: the drawDB persona-contrast lab
with the TodoMVC subject and a to-do mission (add three, complete one, rename one, use both
filters, delete one, then report). Two personas, one mission, per-lane worlds, blurred capture.

## Result

| run | build | keyboard-first lane | mouse newcomer lane |
|---|---|---|---|
| `cua-2026-09-01T20-02-11-494Z-b0097631` | 0.68.0 | finished; reported mouse-only rename; **refused by the blocker scan** ("cannot receive focus") | ran out its 300 s budget after 41 turns: incomplete |
| `cua-2026-09-01T20-02-41-473Z-7b67ac5e` | 0.68.0 | finished; reported mouse-only rename; **refused** | finished; hidden delete `×`, "2 items left" under Completed, no visible Add button |
| `cua-2026-09-01T20-11-39-908Z-791937f6` | main (#579) | `REACHED THE GOAL.`; reported mouse-only rename; pass | `REACHED THE GOAL.`; pass |
| `cua-2026-09-01T20-12-09-795Z-3260abba` | main (#579) | `REACHED THE GOAL.`; reported mouse-only rename, delete `×` absent from tab order; pass | `REACHED THE GOAL.`; pass |

Cost: $0.35 to $0.40 per run. Keyboard-first lanes used 21 keyboard actions and 1 to 2 pointer
actions each (the affordance record): the double-click was the pointer action.

## The finding

All four keyboard-first participants, in their own words: "Renaming requires a double-click; I
found no keyboard-accessible edit path, so I had to use the mouse." Confirmed in
`dist/app.bundle.js` at that commit: edit mode opens on `dblclick`, the only key handlers are
Escape and Enter inside the edit field, and there is no `tabindex` anywhere in the bundle, so a
task label cannot receive focus. Two of four also flagged the hover-only delete `×` as absent from
the tab order (same source: `.destroy{display:none}` until hover). None of the four mouse-driving
newcomers mentioned either.

With drawDB's modal earlier in the day, that is two apps where the keyboard-first persona found a
defect the mouse persona had no reason to meet.

## What the harness did with it

On 0.68.0 the two keyboard-first lanes that finished were refused as "not a credible pass" on the
sentence "task labels cannot receive focus". #579 asks every computer-use participant for a fixed
first line; on main all four lanes wrote `REACHED THE GOAL.`, the trace carries
`declaredOutcome: reached`, none was refused, and each run's tally reads `2/2 reached the goal,
2 reported friction` (#578 counts a "Confusion/defects" section as friction).

## Not verified

Whether TodoMVC's other examples (React, Vue, ...) share the double-click-only edit; only
`javascript-es6` was studied. The budget-limited newcomer in run 1 is an honest incomplete, not a
finding about the app.
