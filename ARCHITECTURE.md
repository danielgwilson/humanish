# Find your way around the humanish code

This file describes the code on `main` and names real functions and files. `pnpm docs:check`
fails when a path in it no longer exists, or when a file named beside a function or type no
longer declares that name. [CONTEXT.md](CONTEXT.md) defines the domain terms, and
[docs/decisions/](docs/decisions/README.md) records the decisions behind the rules below.

## Follow one `humanish run <study>` from manifest to findings

The steps follow a live computer-use study on a hosted E2B desktop. Every route shares steps 1, 2, 7
and 8. Steps 3 to 6 run in the route's admit function and the `run()` it returns, which `runStudyWith`
reaches through `admitPlan` (`src/run-study.ts`). Four of the admit functions hand their checks and
the body they run inside the run scope to `admitRoute` (`src/run/route-shell.ts`). It completes the
automatic analysis of a refusal, and its `run()` opens the run scope, runs the body and completes
the analysis of the run:

- computer-use: `admitComputerUsePlan` (`src/routes/computer-use/route.ts`), with the checks in
  `admitCuaRun` (`src/routes/computer-use/setup.ts`).
- scripted: `admitScriptedPlan` (`src/routes/scripted/route.ts`), whose checks run inside the run.
- terminal: `admitTerminalPlan` (`src/routes/terminal/route.ts`), with a live plan's checks in
  `checkLiveTerminalMachine` (`src/routes/terminal/session.ts`).
- shared-world: `admitSharedWorldPlan` (`src/routes/shared-world/route.ts`).
- preview: `admitPreviewPlan` (`src/routes/preview.ts`); its `run()` calls `runPreviewPlan`
  (`src/routes/preview.ts`), which publishes a fixture bundle.

`runComputerUsePlan` (`src/routes/computer-use/route.ts`), `runTerminalPlan`
(`src/routes/terminal/route.ts`) and `runSharedWorldPlan` (`src/routes/shared-world/route.ts`)
admit and run in one call. Only tests call them, directly or through the route modules'
`runCuaActorStudy`, `runTerminalProductStudy` and `runConcurrentSharedWorld`. `runStudyWith` and the CLI do
not.

1. **Parse.** `runStudyCommand` (`src/cli/commands/study-run.ts`) calls `resolveStudyManifest`
   (`src/study/discover.ts`), which calls `parseStudy` (`src/study/config.ts`). It rejects unknown
   keys and the compositions the
   [support matrix](https://github.com/danielgwilson/humanish/blob/main/docs/ramp/README.md#check-which-compositions-a-lab-can-declare) refuses. A
   refusal exits with code 2 before a run id exists.
2. **Plan.** The route's CLI setup, here `computerUseRouteRun`
   (`src/cli/commands/study-route-computer-use.ts`), hands off to `runRoute`
   (`src/cli/commands/study-route-run.ts`), which calls `prepareStudy` (`src/run-study.ts`). That picks the
   route with `routeOf` (`src/study/plan.ts`) and plans once with `planStudy` (`src/study/plan.ts`), here
   through `planComputerUseStudy` (`src/routes/computer-use/plan.ts`). It then calls the route's admit
   function, here `admitComputerUsePlan` (`src/routes/computer-use/route.ts`), which makes the
   checks in step 3. A refusal from the planner or those checks returns before a declared scorer
   loads. Otherwise a `run()` returns that takes the scorer and continues the run. `runStudyWith` is
   `prepareStudy`, then `run()`.
3. **Preflight.** `admitCuaRun` (`src/routes/computer-use/setup.ts`) calls `liveCuaRejection`
   (`src/routes/computer-use/preflight.ts`) for keys, local-agent sign-in, subject env and caps, and
   packs a `local-tree` subject. The `run()` opens the run's lifetime with `runScope`
   (`src/run/run.ts`), and `startCuaRun` calls `startRun`, all before any sandbox or provider call.
4. **Desktop.** Each participant runs on a `ParticipantDesktop`
   (`src/routes/computer-use/participant-desktop.ts`): a hosted one from
   `createE2BParticipantDesktop` (`src/routes/computer-use/e2b-desktop/desktop.ts`), a local VM
   from `createLocalParticipantDesktop` (`src/routes/computer-use/local-vm.ts`), or
   `createInProcessDesktop` (`src/routes/computer-use/in-process-desktop.ts`).
   `acquireE2BDesktopSandbox` (`src/substrates/e2b/sandbox.ts`) records the sandbox id before it
   returns. `src/subject/`
   provisions a `clone` or `local-tree` subject over a `Shell` (`src/substrates/shell.ts`).
5. **Participants.** `runStudyParticipants` (`src/routes/computer-use/live-phase.ts`) publishes an
   in-progress bundle, then calls `runAllCuaParticipants`
   (`src/routes/computer-use/participant-execution.ts`). That runs `runCuaParticipant` for each
   participant, at most `execution.concurrency` at a time, and each one drives `runComputerUseLoop`
   (`src/actors/computer-use/loop.ts`).
6. **Judge and publish.** `finishCuaRun` (`src/routes/computer-use/result.ts`) judges once with
   `judgeComputerUseRun` (`src/routes/computer-use/bundle.ts`) and builds the bundle with
   `buildCuaRunBundle` (`src/routes/computer-use/bundle.ts`), by the rules in `src/run/judge.ts`. A
   declared scorer's failures fold in through `foldScorerFailures` (`src/run/judge.ts`), so a scorer
   can fail a run and never pass one. `Run.finish` publishes `run.json` with the run's `ok` and
   execution outcome in its `outcome`, then the `status.json` outcome copied from it, the review
   and Observer data, and `.humanish/runs/latest.json` last.
7. **Observer.** `renderObserver` (`src/observer/render.ts`) verifies the bundle with
   `verifyRunPrepared` (`src/verify/verify.ts`) and writes `observer/index.html` from
   `buildObserverData` (`src/observer/data.ts`). When it does not render, `FinishedRun.renderObserver`
   (`src/run/run.ts`) adds the `evidence` failure to `run.json`'s outcome. Every surface that shows
   whether a run passed reads that outcome through `runDisplay` (`src/run/display.ts`).
8. **Analysis.** `completeAutomaticAnalysis` (`src/analysis/automatic-completion.ts`) runs
   `runAutomaticAnalysis` (`src/analysis/automatic.ts`) on the `FinishedRun` that `Run.finish`
   issued. Dry runs and studies with `review.analysis: false` skip it.

## Find the code for each part of the system

| Folder                     | What it holds                                                                                                                   | Read first                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `src/cli/`                 | The commander program, with one file per command family in `commands/`                                                          | `src/cli/program.ts`                |
| `src/keys/`                | Provider key discovery: env files, the user key store and key-source probes                                                     | `src/keys/key-resolution.ts`        |
| `src/run-study.ts`         | `runStudyWith`: plan the study once, then run the plan on its route                                                             | `src/run-study.ts`                  |
| `src/study/`               | Study files: discovery in studies/ (refusing a file found only in labs/), parsing (`config.ts`, `parse/`), routing and planning | `src/study/plan.ts` for planning    |
| `src/routes/`              | One folder per route; `routeOf` in `src/study/plan.ts` picks it                                                                 | `src/study/plan.ts`                 |
| `src/routes/computer-use/` | Computer-use participants and the desktops composing `src/substrates/` with route code                                          | `src/routes/computer-use/route.ts`  |
| `src/routes/scripted/`     | Committed scenario steps replayed on a loopback app or a provisioned clone                                                      | `src/routes/scripted/route.ts`      |
| `src/routes/shared-world/` | Several participants on one shared plane, provisioned or external-public                                                        | `src/routes/shared-world/route.ts`  |
| `src/routes/terminal/`     | A Codex agent in an E2B shell against a terminal product, with its ledgers                                                      | `src/routes/terminal/route.ts`      |
| `src/actors/`              | The actor contract, the registry and each actor's session code                                                                  | `src/actors/registry.ts`            |
| `src/subject/`             | Subject provisioning over a `Shell`: clone, local tree, desktop CLI, serve                                                      | `src/subject/serve.ts`              |
| `src/substrates/`          | Provider primitives: E2B in `e2b/`, Firecracker and Lima VMs in `local/`, the `Shell`                                           | `src/substrates/desktop-session.ts` |
| `src/run/`                 | Run lifecycle, bundle types, bundle guards, paths, status, receipts, reclaim                                                    | `src/run/run.ts`                    |
| `src/verify/`              | `humanish verify`: evidence checks, share-safety grades, cost and rerun checks                                                  | `src/verify/verify.ts`              |
| `src/evidence/`            | Redaction, screenshot checks and desktop recordings                                                                             | `src/evidence/redaction.ts`         |
| `src/analysis/`            | Automatic and on-demand study analysis                                                                                          | `src/analysis/automatic.ts`         |
| `src/observer/`            | Observer data, the HTML render and the local server                                                                             | `src/observer/render.ts`            |
| `src/comms/`               | Captured and received email for participant inboxes                                                                             | `src/comms/types.ts`                |
| `src/feedback/`            | Feedback drafts and export bundles                                                                                              | `src/feedback/feedback.ts`          |
| `src/tui/`                 | The CLI side of `humanish tui`                                                                                                  | `src/tui/launch.ts`                 |
| `src/browser-control/`     | The host-guest browser control protocol                                                                                         | `src/browser-control/protocol.ts`   |
| `src/guest/`               | The guest runtime that the local VM image runs: bootstrap, desktop, input and media                                             | `src/guest/runtime.ts`              |
| `observer/`                | The Observer page, a single-file Vite build                                                                                     | `observer/README.md`                |
| `tui/`                     | The Ink terminal app                                                                                                            | `tui/README.md`                     |
| `site/`                    | humanish.dev and its user docs in `site/content/docs/`                                                                          | `site/README.md`                    |
| `humanish/`                | This repo's own studies, personas, scenarios, fixtures and coverage notes                                                       | `humanish/studies/first-run.yaml`   |
| `examples/`                | Library examples shipped in the npm package: a participant and a scorer                                                         | `examples/README.md`                |
| `adapters/`                | Adapter fixture sets that `tests/study/adapter-fixtures.test.ts` checks                                                         | `adapters/fixtures/README.md`       |
| `bench/`                   | Benchmark apps with planted defects, the scored runner behind `pnpm bench` and the September results                            | `bench/DEFECTS.md`                  |
| `fixtures/`                | Synthetic apps and cases that tests and scripts copy                                                                            | `fixtures/minimal-app/README.md`    |
| `skills/`                  | The companion agent skill that `npx skills add` installs                                                                        | `skills/humanish/SKILL.md`          |
| `runtime/`                 | Desktop and browser image recipes                                                                                               | `runtime/browser-guest/README.md`   |
| `scripts/`                 | Proof, release and check scripts that `package.json` runs                                                                       | `scripts/check-doc-paths.ts`        |
| `docs/contracts/`          | Bundle and schema contracts, whose documented fields are API                                                                    | `docs/contracts/run-bundle.md`      |
| `tests/`                   | Vitest suites that mirror `src/`, plus six folders outside the mirror                                                           | `tests/helpers/run-golden.ts`       |

`pnpm docs:check` fails when a folder directly under `src/` or `src/routes/` has no row here, or
when a row names a folder that is gone; add the row with the folder. Participant desktops stay in
`src/routes/computer-use/` ([decision 0004](docs/decisions/0004-participant-desktops-stay-in-the-route.md)),
three guest entry files stay at the `src/` root
([why](docs/architecture/guest-desktop.md#three-guest-files-stay-at-the-src-root)), and six
`tests/` folders sit outside the mirror
([list](https://github.com/danielgwilson/humanish/blob/main/CONTRIBUTING.md#find-the-test-folders-outside-the-src-mirror)).

## Keep these code guarantees when you change code

Each row names the code that enforces a guarantee and the tests that pin it. The product's
numbered invariants are in [invariants and defaults](docs/principles/invariants-and-defaults.md#invariants);
comments name an invariant by its rule.

| Guarantee                                                                                                                | Enforced by                                                                                                                                                                                                                                                                                                                                                                                                                                              | Pinned by                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The run bundle is the source of truth, and the Observer derives from it                                                  | `verifyRun` grades only `run.json` and its artifacts (`src/verify/verify.ts`). It reads `status.json` and the sandbox and reclaim receipts only for the `RUN_NOT_FINISHED` warning (`runNotFinished` in `src/verify/liveness.ts`), which changes no check and no grade. `buildObserverData` takes the bundle (`src/observer/data.ts`)                                                                                                                    | `tests/observer/data-contract.test.ts`; `tests/verify/run-not-finished.test.ts` checks that the grades are the same when `status.json` contradicts the bundle or is gone; `docs/decisions/0001-run-bundle-is-the-source-of-truth.md`                                                                                                                                                                                                                                             |
| Unsupported execution is refused before side effects                                                                     | `parseStudy` (`src/study/config.ts`), `taskProtocolValidationReason` (`src/study/validation.ts`), `planComputerUseStudy` (`src/routes/computer-use/plan.ts`)                                                                                                                                                                                                                                                                                             | `tests/admission/library.test.ts` checks each library refusal for a run directory, a desktop module load, a caller executor or provider, and a subprocess; `tests/admission/cli.test.ts` checks each CLI refusal for a run directory, a started process and a scorer's host code; `tests/study/task-route-preflight.test.ts`; `pnpm cli:preflight:test` runs `scripts/task-route-preflight-proof.mjs` with `tests/fixtures/task-route-preflight/deny-side-effects.mjs` preloaded |
| A sandbox id is recorded before any work runs in it                                                                      | `acquireE2BDesktopSandbox` and `acquireE2BShellSandbox` (`src/substrates/e2b/sandbox.ts`) tag the sandbox with its run's owner tags, register the create with `beginSandboxCreate` (`src/run/sandbox-creates.ts`) and write the receipt before they return the handle, and every route that creates a sandbox calls them; `reclaimRunSandboxes` (`src/run/reclaim.ts`) switches on the receipt's provider, kills by exact id and by the run's exact tags | `tests/substrates/e2b/sandbox.test.ts`, which also checks that `Sandbox.create` has one call site in `src/`, `tests/routes/terminal/acquisition-boundary.test.ts`, `tests/run/reclaim.test.ts`; `tests/routes/scripted/route.test.ts` checks create, receipt, then first work                                                                                                                                                                                                    |
| Bundles carry no secrets                                                                                                 | `redactText` and `scrubLiterals` (`src/evidence/redaction.ts`); `scanRunPublicSafetyArtifacts` (`src/verify/artifacts.ts`); `buildShareSafety` (`src/verify/verify.ts`) grades `share_ready`, `local_only` or `blocked`                                                                                                                                                                                                                                  | `tests/evidence/redaction-hooks.test.ts`, `tests/run/transient-comms-secrets.test.ts`, `tests/verify/evidence-refs.test.ts`                                                                                                                                                                                                                                                                                                                                                      |
| Goldens pin route output                                                                                                 | `runDirSnapshot` (`tests/helpers/run-golden.ts`) snapshots a whole run folder                                                                                                                                                                                                                                                                                                                                                                            | `tests/golden/routes/`, `tests/golden/observer-data/`, `tests/golden/labs/`; `tests/study/plan-lab.test.ts` checks that every `StudyRoute` has a dry-run golden                                                                                                                                                                                                                                                                                                                  |
| A run is closed on every exit, only a published run is analyzed, and `latest.json` moves only after its run is published | `runScope` and `FinishedRun` (`src/run/run.ts`); `completeAutomaticAnalysis` requires an issued `FinishedRun` for the result's run; `Run.finish` writes `latest.json` last through `writePreparedRunLatestPointer` (`src/run/contained-output.ts`)                                                                                                                                                                                                       | `tests/run/run-lifecycle.test.ts`, which also checks that `src/run/run.ts` is the pointer's one writer, `tests/analysis/automatic-analysis.test.ts`                                                                                                                                                                                                                                                                                                                              |

The receipt write is best-effort; the sandbox's server-side timeout ends a sandbox with no
receipt. A study check probe journals its receipt with `withPreflightSandbox`
(`src/study/preflight-probes.ts`), and `humanish reclaim --preflight` (`src/run/reclaim.ts`) kills
what a failed probe left. [Trust boundaries](https://github.com/danielgwilson/humanish/blob/main/site/content/docs/trust-boundaries.mdx) gives the
probe timeouts.

## Read next

- [Project layout](https://humanish.dev/docs/project-layout): the `humanish/`
  and `.humanish/` folders in a project that runs studies.
- [docs/ramp/README.md](https://github.com/danielgwilson/humanish/blob/main/docs/ramp/README.md#check-which-compositions-a-lab-can-declare): the
  support matrix, which compositions a study can declare and which tests pin each row.
- [CONTRIBUTING.md](https://github.com/danielgwilson/humanish/blob/main/CONTRIBUTING.md#make-your-first-change): a first change, offline, and the
  tests and contracts that common changes touch.
