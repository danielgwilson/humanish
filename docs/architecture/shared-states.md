# Shared states and their readers

Some state in humanish is shown on several surfaces: `humanish runs`, `review`, `verify`, `stats`,
the TUI, the Observer and `--json` output all say whether a run is alive and whether it passed.
[Decision 0005](../decisions/0005-a-shared-state-has-one-reader.md) gives each such state one
reader. This page lists the readers, so a new surface calls one and does not work the state out
again, and it lists the shapes to copy when a state has one owner.

`pnpm docs:check` fails when a file named beside a function here no longer declares it.

## Call the reader for a state another surface also shows

| State                                          | Reader                                                                          | What it returns                                                                                                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whether a run is alive                         | `runLiveness` (`src/run/liveness.ts`)                                           | `running`, `interrupted` or `finished`, and the basis: `outcome` (run.json records the end), `status` (status.json records it), `heartbeat` (fresh), `stale-heartbeat` (stopped) or `bundle` (the participants decide) |
| A status record on its own                     | `readRunStatus` (`src/run/status.ts`)                                           | The same liveness and basis for one `status.json` record, for a caller that has no bundle                                                                                                                              |
| Whether a run passed                           | `runDisplay` (`src/run/display.ts`), with its facts from `bundleDisplayFacts`   | One of nine display states with a label, a tone and the first failure                                                                                                                                                  |
| How a run ended as an execution                | `judgeExecution` (`src/run/judge.ts`)                                           | Whether the execution succeeded, its failures and its warnings, under the route's policy                                                                                                                               |
| What a participant's session counts as         | `judgedStatus` (`src/run/judge.ts`)                                             | The status the run tallies: a pass with no engagement is `incomplete`, a pass that reports a blocker is `blocked`                                                                                                      |
| A session's status from how it ended           | `statusForCompletionReason` (`src/actors/computer-use/loop/trace.ts`)           | The `ActorStatus` for each completion reason, by an exhaustive `switch`                                                                                                                                                |
| Automatic analysis as the run's process saw it | `runAnalysisPhase` (`src/run/status.ts`), in words through `analysisPhaseLabel` | `running`, `stopped` or `ended`, from the status record and its heartbeat                                                                                                                                              |
| A run's findings, or why it has none           | `analysisFindings` (`src/cli/findings.ts`)                                      | A state, a reason code, a message and `next`, the command that gets the findings                                                                                                                                       |
| Whether a run's evidence may be shared         | `buildShareSafety` (`src/verify/verify.ts`)                                     | `share_ready`, `local_only` or `blocked`, with its reasons                                                                                                                                                             |
| Where a run executes                           | `placeRun` (`src/cli/commands/study-remote.ts`)                                 | `local`, `remote` with its plan, or `refused` with the message                                                                                                                                                         |
| What a person can do with a run in the TUI     | `runActions` (`tui/src/screens/run-screen.tsx`)                                 | The actions that work for the run's state, in the order shown                                                                                                                                                          |

A surface that needs a different word for one basis maps it where it reads the state and says why
in a comment. The served Observer does this once: `withLocalRunStatus` in
`src/observer/run-routes.ts` shows a `stale-heartbeat` as `unknown`, because the page may be
serving a run directory copied from another machine.

`runs prune` keeps a run that something may still be writing by a rule wider than liveness
(`runIsLive` in `src/run/prune.ts`): any record touched in the last five minutes, or a `running`
record whose pid a process on this host holds. Deleting a live run loses evidence and keeping a
dead one costs disk, so that rule errs toward keeping.

## Add a reader before the second surface

When a second surface is about to show a state, move the rule into one function first.

1. Put it beside the state's owner: `src/run/` for anything read from a run directory.
2. Make it pure. Pass the clock in, as `runLiveness` takes `nowMs`, so a reading is reproducible
   in a test.
3. Return a closed union, and the basis when the same state can rest on different facts.
4. Return `next` when one command moves the state on.
5. Add the state to a table test that checks every surface against it.
   `tests/run/outcome-surfaces.test.ts` is that test for a run's state.

## Copy one of these shapes for a state with one owner

A state that one module writes and reads needs no reader. These modules already declare their
states and transitions in one place, each in a different shape.

- A fold: `advanceBackstop` (`src/actors/computer-use/loop/backstop.ts`) takes the record and one
  turn's facts and returns the next record, the hints and an optional reason to stop.
- A reducer: `navigate` (`tui/src/navigation.ts`) takes the TUI's screen state and an event and
  returns the next state.
- A plan as data with one interpreter: `planX11Action` (`src/substrates/x11/translator.ts`) turns
  an action into steps, and `executeX11Action` (`src/substrates/x11/desktop.ts`) runs them for
  every desktop.
- A closure with one string state and named events: `pipelineGate`
  (`src/routes/computer-use/participant-execution.ts`).
- A union the caller must narrow: `planDebrief` (`src/actors/computer-use/loop/debrief.ts`)
  returns a plan to send the closing request or the reason to skip it.
- Open once, close once: `ownDesktopAllocation` (`src/substrates/desktop-session.ts`) refuses a
  second open and makes a second close a no-op.
- An armed confirmation: `useArming` (`tui/src/arming.ts`) holds which destructive action waits
  for a second key and disarms when the cursor leaves it.

A closure with two or three flags and a guard on each method is fine when its module is its only
reader and its tests sit at the module's interface. `beginRunStatus` (`src/run/status.ts`) is
written that way.
