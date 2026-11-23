# Shared states and their readers

Some state in humanish is shown on several surfaces: `humanish runs`, `review`, `verify`, `stats`,
the TUI, the Observer and `--json` output all say whether a run is alive and whether it passed.
[Decision 0005](../decisions/0005-a-shared-state-has-one-reader.md) gives each such state one
reader. This page lists the readers, so a new surface calls one and does not work the state out
again. It also lists the readers of a run's liveness that still apply a rule of their own, and the
shapes to copy when a state has one owner.

`pnpm docs:check` fails when a file named beside a function here no longer declares it.

## Call the reader for a state another surface also shows

| State                                  | Reader                                                                                            | What it returns                                                                                                                                                                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whether a run is alive                 | `runLiveness` (`src/run/liveness.ts`)                                                             | `running`, `interrupted` or `finished`, keyed by its basis: `outcome` (run.json records the end), `remote` (no run.json here, and the remote record says the run is on its runner), `status` (status.json records it), `heartbeat` (fresh), `stale-heartbeat` (stopped) or `bundle` (the participants decide) |
| Where a remote run's evidence is       | `readRemoteRecord` (`src/run/remote-record.ts`), and `readRunOnRunner` for a run with no run.json | `none`, `pending` with the provider, route, deadline and start it names, or `copied` with `lostInCopy`. `readRunOnRunner` adds whether a reclaim receipt is in the run directory                                                                                                                              |
| A status record on its own             | `readRunStatus` (`src/run/status.ts`)                                                             | The same liveness and basis for one `status.json` record, for a caller that has no bundle                                                                                                                                                                                                                     |
| Whether a participant has ended        | `simulationInProgress` (`src/run/streams.ts`)                                                     | Whether a recorded status is `queued`, `preparing` or `running`, from one table that places every status                                                                                                                                                                                                      |
| Whether a run passed                   | `runDisplay` (`src/run/display.ts`), with its facts from `bundleDisplayFacts`                     | One of nine display states with a label, a tone and the first failure                                                                                                                                                                                                                                         |
| What a participant's session counts as | `judgedStatus` (`src/run/judge.ts`)                                                               | The status the run tallies: a pass with no engagement is `incomplete`, a pass that reports a blocker is `blocked`                                                                                                                                                                                             |
| Automatic analysis in the run's record | `runAnalysisPhase` (`src/run/status.ts`), in words through `analysisPhaseLabel`                   | `running`, `stopped` or `ended`, from the status record and the same freshness check as its liveness. The analysis job file is a second record with its own readers                                                                                                                                           |
| A run's findings, or why it has none   | `analysisFindings` (`src/cli/findings.ts`)                                                        | A state, a reason code, a message and `next`, the command that gets the findings                                                                                                                                                                                                                              |
| Whether a run's evidence may be shared | `buildShareSafety` (`src/verify/verify.ts`)                                                       | `share_ready`, `local_only` or `blocked`, with its reasons                                                                                                                                                                                                                                                    |
| Where a run executes                   | `placeRun` (`src/cli/commands/study-remote.ts`)                                                   | `local`, `remote` with its plan, or `refused` with the message                                                                                                                                                                                                                                                |

`readRunStatus` treats a heartbeat as fresh when it is within the stale window of now, in either
direction. A record dated further ahead was written under another clock, so it reads as a
`stale-heartbeat`.

## Know which surfaces map a stale heartbeat, and why

`humanish runs`, `review`, `stats`, `verify` and the TUI read a `stale-heartbeat` as interrupted.
Three callers do something else with that one basis:

- The served Observer shows it as `unknown` (`servedState` in `src/observer/run-routes.ts`),
  because the page may be serving a run directory copied from another machine. It also shows
  `unknown` for a record whose start is after its last update, which no version writes.
- `analyze` probes the recorded pid (`assertRecordingEnded` in
  `src/analysis/recording-ended.ts`). It analyzes the run when no process on this host holds the
  pid, and refuses with `ANALYSIS_RUN_UNCONFIRMED` when one does.
- The TUI's Stop sends no signal (`stopRun` in `src/tui/actions.ts`), because the pid may belong
  to another process by now.

`runs prune` keeps a run that something may still be writing by a rule wider than liveness
(`runIsLive` in `src/run/prune.ts`): any record touched in the last five minutes, or a `running`
record whose pid a process on this host holds. Deleting a live run loses evidence and keeping a
dead one costs disk, so that rule errs toward keeping.

## Move these readers of a run's liveness next

These still decide whether a run has ended by a rule of their own. Each is a place where a
surface can disagree with `humanish runs`.

- `humanish export --format bundle` refuses unless `status.json` says `finished`
  (`assertExportableSource` in `src/feedback/export-bundle.ts`). It refuses a run that
  `humanish reclaim` marked interrupted and a run whose run.json records its end when the status
  record never caught up.
- `humanish analyze` refuses a run whose `status.json` exists and is not a well-formed record
  that names the run, before it reads run.json's outcome (`readCompletedAnalysisSource` in
  `src/analysis/service.ts`).
- A run directory with neither file and no pending remote record reads as interrupted in the run
  index, which `stats` and the TUI use (`readRunIndex` in `src/run/run-index.ts`), and has no
  display in `humanish runs` (`listRuns` in `src/run/stored-runs.ts`).
- The remote launcher reads the first `"state"` key of the runner's `status.json` with `grep`
  (`waitForRemoteRun` in `src/remote/runner.ts`), which depends on the order `beginRunStatus`
  writes the keys in.
- The Observer page's status band falls back to the participants' statuses when the server
  attached no observation (`RunStatus` in `observer/components/run-status.tsx`), so a run with no
  usable status record can read "Running" there while its `run.display` says interrupted.
- `verify`, `review`, `analyze` and `export` each count the streams that have not ended. `verify`
  uses `simulationInProgress`; `review` and `analyze` also count a stream that still holds live
  items (`src/cli/findings.ts`, `src/analysis/service.ts`); `export` and the analysis evidence
  guard keep lists of their own (`src/feedback/export-bundle.ts`, `src/analysis/evidence.ts`).

## Add a reader before the second surface

When a second surface is about to show a state, move the rule into one function first.

1. Put it beside the state's owner: `src/run/` for anything read from a run directory.
2. Make it pure. Pass the clock in, as `runLiveness` takes `nowMs`, so a reading is reproducible
   in a test.
3. Return a union keyed by the basis, so a caller narrows to the fact it needs and a new basis
   fails to compile where it is not handled.
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
- An exhaustive `switch` with no default: `statusForCompletionReason`
  (`src/actors/computer-use/loop/trace.ts`) maps each way the computer-use loop can end to a
  status, and a new way fails to compile until it is placed.
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
- A table of what works in each state: `runActions` (`tui/src/screens/run-screen.tsx`) lists the
  actions the TUI offers for a run, in the order shown.

A closure with two or three flags and a guard on each method is fine when its module is the only
reader of those flags and its tests sit at the module's interface. The write queue in
`runPublisher` (`src/run/run.ts`) is written that way.
