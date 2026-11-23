# 0005: A state that several surfaces show has one reader

Accepted.

## Context

Much of humanish is state that changes over time: a run starts, its participants work, it ends
or is stopped, its analysis runs. An audit of `src/`, `observer/` and `tui/` listed 247 such state
machines across nine areas of the code, a handful of them counted in two areas, and sorted them
three ways.

- 38 declare their states and transitions in one place, such as the fold in `advanceBackstop`
  (`src/actors/computer-use/loop/backstop.ts`) and the reducer in `navigate`
  (`tui/src/navigation.ts`).
- 162 are implicit and have one owner. A closure holds two or three flags, each method guards
  itself, and the module that writes the state is the only one that reads it. The status writer
  `beginRunStatus` (`src/run/status.ts`) is one. Their tests sit at the module's interface, and
  few fixes have touched them.
- 47 had a history of fixes. In nearly all of them no module owned the state: each surface that
  showed it worked it out again from files, timestamps and process ids.

A run's liveness was the widest case, with 16 rules. One `status.json` whose heartbeat had stopped
read as interrupted in `humanish runs`, the TUI, `stats` and `verify`, as unknown in the served
Observer, as unconfirmed or ended in `analyze` depending on a pid probe, and as running for five
minutes in `runs prune`. `humanish runs` printed `unreadable` for a run that had started and not
yet written `run.json`, on the first line after the CLI told the operator to look there.

When two surfaces disagree, a person cannot tell which one to trust. A coding agent that reads
`--json` acts on whichever command it asked. A contributor who adds a state has to find every
reader, and the one they miss becomes the next fix.

## Decision

A state that more than one surface shows is read by one function. That function returns:

1. The state, from a closed union.
2. The basis: which recorded fact the reading rests on. A surface that must presume less maps the
   basis to its own words, and an agent can tell a recorded interruption from a presumed one.
3. The command that moves the state on, as `next`, when one command can. `analysisFindings`
   (`src/cli/findings.ts`) does this for a run's findings.

A surface chooses its words and never its rule. A surface that needs a different answer for one
basis writes that mapping where it reads the state, with the reason in a comment.

A state with one owner stays as it is. Rewriting a working closure as a transition table changes
nothing a person or an agent reads and carries the risk of any rewrite, so it happens only when a
fix needs it. humanish adds no state machine library: a union, one function and an exhaustive
`switch` are enough.

[Shared states and their readers](../architecture/shared-states.md) lists each reader and the
shapes to copy for a state with one owner.

## Consequences

- A new surface calls the reader. It does not read `status.json`'s `state`, compare a heartbeat
  to a threshold or probe a pid itself.
- When a reader gains a basis, `--json` gains a field for it (`livenessBasis` on `humanish runs`,
  `unfinished.basis` on `humanish verify`). The field is additive.
- One surface keeps a different word for one basis. The served Observer shows a stopped heartbeat
  as `unknown`, where the CLI reads interrupted, because the page may be serving a run directory
  copied from another machine. The mapping is in `src/observer/run-routes.ts`.
- Shared states that still have several readers are tracked as issues. The audit's count of 47
  included them.

## Enforced by

- `runLiveness` (`src/run/liveness.ts`) and `readRunStatus` (`src/run/status.ts`), which every
  surface that says whether a run is alive calls.
- `tests/run/liveness.test.ts`, which fails when a file under `src/`, `tui/src/` or `observer/`
  other than `src/run/status.ts` reads the stale window `RUN_STATUS_STALE_MS`.
- `tests/run/outcome-surfaces.test.ts`, which writes one run per recorded state and checks that
  `runs`, `review`, `stats`, `verify`, the Observer data, the served Observer and the run library
  show the same state, and that `runs` and `verify` give the same basis.
