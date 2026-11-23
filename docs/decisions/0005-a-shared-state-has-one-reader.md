# 0005: A state that several surfaces show has one reader

Accepted.

## Context

A read-through of `src/`, `observer/` and `tui/` listed 247 state machines and graded each one
([the inventory](https://github.com/danielgwilson/humanish/blob/main/docs/evidence/architecture/2026-11-23-state-machines-5980c353.md)). 38 declare
their states and transitions in one place. 162 are implicit, small and safe to leave: most are a
closure or a class with a few flags that only its own module reads, such as `UsageLedger`
(`src/actors/computer-use/loop/usage.ts`). 47 are implicit and costly: each had a history of fix
commits or readers that disagreed.

The widest of the 47 was a run's liveness. No module owned it. At least 16 places worked out
whether a run was alive from `status.json`, `run.json`, a heartbeat's age and sometimes a pid, and
they disagreed. One `status.json` whose heartbeat had stopped read as interrupted in
`humanish runs`, the TUI, `stats` and `verify`, as unknown in the served Observer, and as
unconfirmed or ended in `analyze` depending on a pid probe. `humanish run` names its run on its
first line of output, and `humanish runs` printed that run as `unreadable` until it wrote
`run.json`. A participant's status had the same shape: about ten recorded fields, several rules, and
a CLI line that said `passed` for a participant the Observer showed as blocked.

When two surfaces disagree, a person cannot tell which one to trust, and a coding agent that
reads `--json` acts on whichever command it asked. A contributor who adds a state has to find
every reader.

## Decision

A state that more than one surface shows is read by one function. That function returns:

1. The state, from a closed union.
2. The basis: which recorded fact the reading rests on. A surface that must presume less maps the
   basis to its own words, and an agent can tell a recorded interruption from a presumed one.
3. The command that moves the state on, as `next`, when one command can. `analysisFindings`
   (`src/cli/findings.ts`) does this for a run's findings.

A surface chooses its words. When it needs a different answer for one basis, it maps that basis
in a `switch` where it reads the state, with the reason in a comment.

A state that one module writes and reads stays as it is. Rewriting a working closure as a
transition table changes nothing a person or an agent reads and carries the risk of any rewrite,
so it happens only when a fix needs it. humanish adds no state machine library: a union, one
function and an exhaustive `switch` are enough.

[Shared states and their readers](../architecture/shared-states.md) lists each reader, the
readers of a run's liveness that still apply a rule of their own, and the shapes to copy for a
state with one owner.

## Consequences

- A new surface calls the reader. It does not read `status.json`'s `state`, compare a heartbeat
  to the stale window or probe a pid itself.
- When a reader gains a basis, `--json` gains a field for it (`livenessBasis` on `humanish runs`,
  `unfinished.basis` on `humanish verify`). The field is additive.
- Three surfaces map the `stale-heartbeat` basis on purpose, each in one place. The served
  Observer shows it as `unknown`, because the page may be serving a run directory copied from
  another machine. `analyze` probes the recorded pid and refuses when a process holds it.
  `runs prune` keeps the run while a process holds its pid. `humanish runs`, `review`, `stats`,
  `verify` and the TUI read it as interrupted.
- The readers not yet moved are listed on the shared-states page, so the list can be checked
  against the code.

## Enforced by

- `runLiveness` (`src/run/liveness.ts`) and `readRunStatus` (`src/run/status.ts`).
- `tests/run/liveness.test.ts`, which fails when production code under `src/`, `tui/src/` or
  `observer/` other than `src/run/status.ts` names the stale window `RUN_STATUS_STALE_MS`.
- `tests/run/outcome-surfaces.test.ts`, which writes one run per recorded state and checks that
  `runs`, `review`, `stats`, `verify`, the Observer data, the served Observer and the run library
  show the same state, and that `runs` and `verify` give the same basis.
