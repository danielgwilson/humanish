# A declared observation window, live (#510)

**2026-09-04, TodoMVC (`tastejs/todomvc`, `examples/javascript-es6/dist`, served by python3), one
newcomer participant on `gpt-5.6-sol`, two runs, $0.14 in all.** The lab is
`humanish/labs/dwell-window-todomvc.yaml` (committed dry-run; run live with `scenario.mode: live`).
The actor declares:

```yaml
dwell:
  when:
    any:
      - id: one-left
        textIncludes: "1 item left"
  ms: 60000
  everyMs: 10000
  then: continue
```

and the mission says the study will hold the page after the first task and asks the participant
to add a second task when it is asked to continue.

## The run that counts: `cua-2026-09-04T20-32-24-175Z-97c4493e` ($0.04)

| what | evidence in the bundle |
|---|---|
| the window opened when its condition matched | notice `dwell window started` at 20:32:52.600Z: "its condition matched at turn 2: holding 60000ms, a frame every 10000ms, no actions, no model turns" |
| the harness held for the declared time | notice `dwell window complete` at 20:33:53.187Z: "6 frame(s) over 60587ms; no model turn was requested during the window" |
| frames on the cadence | `screenshots/dwell-01.png` through `dwell-06.png`, then `turn-02-after-dwell.png` |
| no model turn inside the window | between the two notices the trace holds 6 screenshot items and nothing else: no reasoning, message, tool call or action |
| control handed back | the next turn carried the hint that the page had been held under observation; the participant added the second task; `task completed: second-task` |
| the participant's own account | "Added “water the plants,” waited through the study hold, then added “call the bank.” Both tasks are visible and active. The interface was clear; I had no confusion or hesitation." |

Four model turns in the whole session, 11 screenshots (4 turns + 6 dwell frames + 1 after the
window), both declared tasks measured complete. The dwell's cost is the desktop's minute, which
the bundle's rate table prices; the model billed nothing for it.

## The run before it: `cua-2026-09-04T20-25-46-367Z-6e8bd735` ($0.10)

Same lab, first build of the branch. The window never opened: `lab inspect` showed `dwell`
parsed and the lane spec carried it, but `runCuaActorSession` did not forward it to the loop.
The object spread that carried the option through the lane passed the type checker, because an
excess property in a spread is never an error. The participant, told the study would hold,
"waited with the page open" on its own and spent seven turns on a two-turn job. A plumbing test
now asserts the option reaches the session for an actor-level default and a lane-level override.

## What the verifier had to learn

A lane that only observes (`dwell` with no `when` and `then: stop`) ends `goal_satisfied` with
zero actions and zero messages, which the engagement check reads as a hollow run. A completed
dwell window that ended the session now counts as structured completion evidence, in the same
clause as a matched `stopWhen`, when frames were captured.

## Three participants present together: `concurrent-shared-world-2026-09-04T21-13-53-078Z-4791ebe3`

The flow #510 came from, on the concurrent shared-world route after #645 forwarded the option
there: the committed concurrent lab (one subject sandbox serving the synthetic task board, three
actor desktops on its getHost URL) with `dwell: { ms: 45000, everyMs: 15000, then: continue }` on
the actor and no `when`, so every seat holds from its first observation.

| seat | window | frames | model turns inside | afterwards |
|---|---|---|---|---|
| stream-001 | 21:14:21 to 21:15:06 (45,467 ms) | 3 | 0 | added one task, REACHED |
| stream-002 | 21:14:20 to 21:15:05 (45,429 ms) | 3 | 0 | added one task, REACHED |
| stream-003 | 21:14:20 to 21:15:06 (45,462 ms) | 3 | 0 | added one task, REACHED |

The board's checkpoint prober took 57 readings between 21:14:04 and 21:15:20. Its digest was one
value from the first reading through all three overlapping windows and changed for the first time
at 21:15:15, nine seconds after the last window closed, then again at 21:15:17: the shared world
stood still while everyone was present and moved once they acted. Three turns per seat in all;
four sandboxes reclaimed by id.

## A two-minute window: `cua-2026-09-04T21-31-51-126Z-16145475` ($0.05)

Same TodoMVC lab with `ms: 120000, everyMs: 20000`: "6 frame(s) over 120535ms; no model turn was
requested during the window", six screenshot items and nothing else between the notices, both
declared tasks measured complete afterwards, four turns in the whole session. The participant:
"waited for the study to continue, then added “call the bank”."

## Not verified

- The sequential shared-world route live (its plumbing test passes), and the scripted-browser route
  (the option is not wired there; it has no model loop to hold).
