# Find your way around the humanish code

This file describes the code on `main` and names real functions and files. `pnpm docs:check`
fails when a path in it no longer exists, or when a file named beside a function or type no
longer declares that name. [CONTEXT.md](CONTEXT.md) defines the domain terms, and
[docs/decisions/](docs/decisions/README.md) records the decisions behind the rules below.

## Follow one `humanish run <lab>` from manifest to findings

The steps follow a live computer-use lab on a hosted E2B desktop. Every route shares steps 1, 2, 7
and 8 and does steps 3 to 6 in its own run function: `runComputerUsePlan` here, and
`runScriptedPlan` (`src/routes/scripted/route.ts`), `runTerminalPlan`
(`src/routes/terminal/route.ts`) and `runSharedWorldPlan` (`src/routes/shared-world/route.ts`).
`runPreviewPlan` (`src/routes/preview.ts`) writes a fixture bundle with `runDryRun`
(`src/run/dry-run.ts`) and publishes it as in step 6. The scripted route's participant is its
actor: `runScriptedBrowserSessionInPreparedRoot` (`src/actors/scripted-browser/actor.ts`) runs one
surface's steps through `executeBrowserPersonaStep` (`src/actors/scripted-browser/steps.ts`) and
reports the first failed step.

1. **Parse.** `runLabCommand` (`src/cli/commands/lab-run.ts`) calls `resolveLabManifest`
   (`src/lab/discover.ts`), which reads the YAML and calls `parseLabConfig` (`src/lab/config.ts`).
   It rejects unknown keys and every refused composition in the
   [support matrix](docs/ramp/README.md#check-which-compositions-a-lab-can-declare). A refusal
   exits with code 2 before a run id exists.
2. **Plan.** `runLabCommand` runs the route's CLI setup, here `computerUseRouteRun`
   (`src/cli/commands/lab-route-computer-use.ts`). `runRoute` (`src/cli/commands/lab-route-run.ts`)
   then calls `prepareLab` (`src/run-lab.ts`). `prepareLab` picks one of five routes with
   `routeOf` (`src/lab/plan.ts`) from `subject.source`, `subject.topology`, `execution.target` and
   the capabilities `actorRegistry` (`src/actors/registry.ts`) lists for `actors[0].type`. It maps
   library options with `normalizeRunLabOptions` (`src/lab/run-lab-options.ts`) and plans once with
   `planLab` (`src/lab/plan.ts`), which calls the route's planner, here `planComputerUseLab`
   (`src/routes/computer-use/plan.ts`). The planner runs on every run, CLI or library. A refusal
   comes back before the CLI loads a declared review scorer. So does a terminal lab's refusal for a
   missing runtime key or `E2B_API_KEY`, from `admitTerminalPlan` (`src/routes/terminal/route.ts`).
   A plan comes back with a `run()` that takes the scorer and calls the route's run function, here
   `runComputerUsePlan` (`src/routes/computer-use/route.ts`). `runLab` is `prepareLab` followed by
   that `run()`. A run is live only when the lab declares `scenario.mode: live`; `--dry-run` forces
   a dry run.
3. **Preflight.** `runComputerUsePlan` opens the run's lifetime with `runScope` (`src/run/run.ts`).
   `prepareCuaRun` (`src/routes/computer-use/setup.ts`) plans the lanes and, on a live run, calls
   `liveCuaRejection` (`src/routes/computer-use/preflight.ts`). That checks provider keys, the local
   agent login and subject env vars, and refuses a dollar cap it cannot price. Only then does
   `prepareCuaRun` start the run with `startRun` (`src/run/run.ts`), still before any sandbox or
   provider call.
4. **Desktop.** Each participant runs on a `ParticipantDesktop`
   (`src/routes/computer-use/participant-desktop.ts`), which its lane prepares, opens and finalizes.
   On a hosted desktop that is `createE2BParticipantDesktop`
   (`src/routes/computer-use/e2b-desktop/desktop.ts`), which runs the steps in the files beside it. `acquireE2BDesktopSandbox`
   (`src/substrates/e2b/sandbox.ts`) appends the sandbox id to `sandbox-receipts.ndjson` before it
   returns the handle. A `clone` or `local-tree` subject is provisioned through `src/subject/`,
   which reaches the sandbox only through the `Shell` that `e2bShell` (`src/substrates/e2b/shell.ts`)
   returns. A local browser study (`execution.target: local`) runs on a local VM, which
   `prepareLocalVmStudy` (`src/routes/computer-use/local-vm.ts`) sets up while `prepareLab` plans. An
   in-process run uses `createInProcessDesktop` (`src/routes/computer-use/in-process-desktop.ts`).
5. **Participants.** `runLabParticipants` (`src/routes/computer-use/run-lanes.ts`) publishes an
   in-progress bundle with `Run.writeSnapshot`, rewrites it from the lanes' live traces through
   `startLiveTraceFlush` (`src/routes/computer-use/live-flush.ts`), and calls `runAllCuaParticipants`
   (`src/routes/computer-use/lanes.ts`). That runs `runCuaParticipant` for each participant, at most
   `execution.concurrency` at a time. A lane prepares its desktop, runs `runCuaActorSession`
   (`src/actors/computer-use/actor.ts`), which drives `runComputerUseLoop`
   (`src/actors/computer-use/loop.ts`), and finalizes the desktop. The loop saves screenshots through
   `makeParticipantWriteScreenshot`, which checks each image with `assertScreenshotEvidence`
   (`src/evidence/image.ts`). Screenshots are blurred only when a lab sets
   `policies.redactScreenshots: true`.
6. **Judge and publish.** `finishCuaRun` (`src/routes/computer-use/result.ts`) judges the run once
   with `judgeComputerUseRun` (`src/routes/computer-use/bundle.ts`), whose rules are in
   `src/run/judge.ts`, and builds the bundle from that judgment with `buildCuaRunBundle`
   (`src/routes/computer-use/bundle.ts`). A declared scorer then scores the bundle through
   `applyBrowserAdapterHooks` (`src/lab/adapter-extension.ts`), and `foldScorerFailures`
   (`src/run/judge.ts`) folds its failures into the verdict, so a scorer can fail a run but never
   pass one. `Run.finish` publishes `run.json`, then the `status.json` outcome, then `review.json`,
   `review.md`, `events.ndjson` and `observer/observer-data.json`, and the
   `.humanish/runs/latest.json` pointer last. Every route judges with `src/run/judge.ts` and
   publishes the same way.
7. **Observer.** `renderObserver` (`src/observer/render.ts`) verifies the bundle with
   `verifyRunPrepared` (`src/verify/verify.ts`), builds the page data with `buildObserverData`
   (`src/observer/data.ts`) and writes `observer/index.html` with `renderObserverHtml`
   (`src/observer/artifact.ts`). `humanish verify --run latest` runs `verifyRun` on demand.
8. **Analysis.** After the route returns, `completeAutomaticAnalysis`
   (`src/analysis/automatic-completion.ts`) calls `runAutomaticStudyAnalysis`
   (`src/analysis/automatic.ts`) with the `FinishedRun` that `Run.finish` issued, so a refusal
   that echoes an older run's id never analyzes that run. Dry runs skip analysis, and a lab turns
   it off with `review.analysis: false`.

## Find the code for each part of the system

| Folder                     | What it holds                                                                          | Read first                          |
| -------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------- |
| `src/cli/`                 | The commander program, with one file per command family in `commands/`                 | `src/cli/program.ts`                |
| `src/keys/`                | Provider key discovery: env files, the user key store and key-source probes            | `src/keys/key-resolution.ts`        |
| `src/run-lab.ts`           | `runLab`: plan the lab once, then run the plan on its route                            | `src/run-lab.ts`                    |
| `src/lab/`                 | Lab manifest types, parsing, validation, routing and planning                          | `src/lab/plan.ts`                   |
| `src/routes/`              | One folder per route; `routeOf` in `src/lab/plan.ts` picks it                          | `src/lab/plan.ts`                   |
| `src/routes/computer-use/` | Computer-use participants and the desktops composing `src/substrates/` with route code | `src/routes/computer-use/route.ts`  |
| `src/routes/scripted/`     | Committed scenario steps replayed on a loopback app or a provisioned clone             | `src/routes/scripted/route.ts`      |
| `src/routes/shared-world/` | Several seats on one shared plane, provisioned or external-public                      | `src/routes/shared-world/route.ts`  |
| `src/routes/terminal/`     | A Codex agent in an E2B shell against a terminal product, with its ledgers             | `src/routes/terminal/route.ts`      |
| `src/actors/`              | The actor contract, the registry and each actor's session code                         | `src/actors/registry.ts`            |
| `src/subject/`             | Subject provisioning over a `Shell`: clone, local tree, desktop CLI, serve             | `src/subject/serve.ts`              |
| `src/substrates/`          | Provider primitives: E2B in `e2b/`, Firecracker and Lima VMs in `local/`, the `Shell`  | `src/substrates/desktop-session.ts` |
| `src/run/`                 | Run lifecycle, bundle types, bundle guards, paths, status, receipts, reclaim           | `src/run/run.ts`                    |
| `src/verify/`              | `humanish verify`: evidence checks, share-safety grades, cost and rerun checks         | `src/verify/verify.ts`              |
| `src/evidence/`            | Redaction, screenshot checks and desktop recordings                                    | `src/evidence/redaction.ts`         |
| `src/analysis/`            | Automatic and on-demand study analysis                                                 | `src/analysis/automatic.ts`         |
| `src/observer/`            | Observer data, the HTML render and the local server                                    | `src/observer/render.ts`            |
| `src/comms/`               | Captured and received email for participant inboxes                                    | `src/comms/types.ts`                |
| `src/feedback/`            | Feedback drafts and export bundles                                                     | `src/feedback/feedback.ts`          |
| `src/tui/`                 | The CLI side of `humanish tui`                                                         | `src/tui/launch.ts`                 |
| `src/browser-control/`     | The host-guest browser control protocol                                                | `src/browser-control/protocol.ts`   |
| `src/guest/`               | The guest runtime that the local VM image runs: bootstrap, desktop, input and media    | `src/guest/runtime.ts`              |
| `observer/`                | The Observer page, a single-file Vite build                                            | `observer/AGENTS.md`                |
| `tui/`                     | The Ink terminal app                                                                   | `tui/AGENTS.md`                     |
| `site/`                    | humanish.dev and its user docs in `site/content/docs/`                                 | `site/AGENTS.md`                    |
| `humanish/`                | This repo's own labs, personas, scenarios, fixtures and coverage notes                 | `humanish/labs/first-run.yaml`      |
| `examples/`                | Library examples shipped in the npm package: a participant and a scorer                | `examples/README.md`                |
| `adapters/`                | Adapter fixture sets that `tests/lab/adapter-fixtures.test.ts` checks                  | `adapters/fixtures/README.md`       |
| `bench/`                   | Benchmark apps with planted defects and their dated results                            | `bench/DEFECTS.md`                  |
| `fixtures/`                | Synthetic apps and cases that tests and scripts copy                                   | `fixtures/minimal-app/README.md`    |
| `skills/`                  | The companion agent skill that `npx skills add` installs                               | `skills/humanish/SKILL.md`          |
| `runtime/`                 | Desktop and browser image recipes                                                      | `runtime/browser-guest/README.md`   |
| `scripts/`                 | Proof, release and check scripts that `package.json` runs                              | `scripts/check-doc-paths.ts`        |
| `docs/contracts/`          | Bundle and schema contracts, whose documented fields are API                           | `docs/contracts/run-bundle.md`      |
| `tests/`                   | Vitest suites that mirror `src/`, plus the folders named below the table               | `tests/helpers/run-golden.ts`       |

`pnpm docs:check` fails when a folder directly under `src/` or `src/routes/` has no row here, or
when a row names a folder that is gone. Add the row in the change that adds the folder.

Three guest files stay at the `src/` root because the guest image and its packager name their
`dist/` paths. The guest's `vsock.py` launches `guest-runtime-main.js`, and
`scripts/guest-runtime-package.mjs` walks the payload from it. The packager also regenerates
`guest-runtime-revision.js` by name. The packager and the `runtime/browser-media/` recipes copy
`guest-media-worker.js` by name.

Participant desktops stay in `src/routes/computer-use/`, by decision. The `ParticipantDesktop`
interface and its three implementations (hosted E2B, local VM, in-process) each combine provider
primitives from `src/substrates/` (the E2B sandbox, local VMs, the `Shell`) with route concerns:
subject provisioning, comms and the participant plan. Moving only the interface to
`src/substrates/` would split one concept across two folders, so `src/substrates/` holds only the
primitives.

Six folders in `tests/` sit outside that mirror. `tests/admission/` pins what the CLI and the
library do when they refuse a lab before a run starts, and `tests/scripts/` tests `scripts/`.
`tests/surface/` checks the README, the site, `site/public/llms.txt`, the agent skill and the package
against the shipped CLI. `tests/helpers/`, `tests/fixtures/` and `tests/golden/` hold shared test
code, inputs and goldens.

## Keep these invariants when you change code

| Invariant                                                               | Enforced by                                                                                                                                                                                                                                                                                         | Pinned by                                                                                                                                                                                                |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The run bundle is the source of truth, and the Observer derives from it | `verifyRun` reads only `run.json` and its artifacts (`src/verify/verify.ts`); `buildObserverData` takes the bundle (`src/observer/data.ts`)                                                                                                                                                         | `tests/observer/data-contract.test.ts`, `docs/decisions/0001-run-bundle-is-the-source-of-truth.md`                                                                                                       |
| Unsupported execution is refused before side effects                    | `parseLabConfig` (`src/lab/config.ts`), `taskProtocolValidationReason` (`src/lab/validation.ts`), `planComputerUseLab` (`src/routes/computer-use/plan.ts`)                                                                                                                                          | `tests/lab/task-route-preflight.test.ts`; `pnpm cli:preflight:test` runs `scripts/task-route-preflight-proof.mjs` with `tests/fixtures/task-route-preflight/deny-side-effects.mjs` preloaded             |
| A sandbox id is recorded before any work runs in it                     | `acquireE2BDesktopSandbox` and `acquireE2BShellSandbox` (`src/substrates/e2b/sandbox.ts`) write the receipt before they return the handle, and every route that creates a sandbox calls them; `reclaimRunSandboxes` (`src/run/reclaim.ts`) switches on the receipt's provider and kills by exact id | `tests/substrates/e2b/sandbox.test.ts`, `tests/routes/terminal/acquisition-boundary.test.ts`, `tests/run/reclaim.test.ts`; `tests/routes/scripted/route.test.ts` checks create, receipt, then first work |
| Bundles carry no secrets                                                | `redactText` and `scrubLiterals` (`src/evidence/redaction.ts`); `scanRunPublicSafetyArtifacts` (`src/verify/artifacts.ts`); `buildShareSafety` (`src/verify/verify.ts`) grades `share_ready`, `local_only` or `blocked`                                                                             | `tests/evidence/redaction-hooks.test.ts`, `tests/run/transient-comms-secrets.test.ts`, `tests/verify/evidence-refs.test.ts`                                                                              |
| Goldens pin route output                                                | `runDirSnapshot` (`tests/helpers/run-golden.ts`) snapshots a whole run folder                                                                                                                                                                                                                       | `tests/golden/routes/`, `tests/golden/observer-data/`, `tests/golden/labs/`                                                                                                                              |
| A run is closed on every exit, and only a published run is analyzed     | `runScope` and `FinishedRun` (`src/run/run.ts`); `completeAutomaticAnalysis` requires an issued `FinishedRun` for the result's run                                                                                                                                                                  | `tests/run/run-lifecycle.test.ts`, `tests/analysis/automatic-analysis.test.ts`                                                                                                                           |

The receipt write is best-effort; the sandbox's server-side timeout ends a sandbox with no
receipt. A lab preflight probe journals its receipt with `withPreflightSandbox`
(`src/lab/preflight-probes.ts`), and `humanish reclaim --preflight` (`src/run/reclaim.ts`) kills
what a failed probe left. [Trust boundaries](https://github.com/danielgwilson/humanish/blob/main/site/content/docs/trust-boundaries.mdx) gives the
probe timeouts.

## Read next

- [docs/architecture/project-layout.md](docs/architecture/project-layout.md): the `humanish/`
  and `.humanish/` folders in a project that runs studies.
- [docs/ramp/README.md](docs/ramp/README.md#check-which-compositions-a-lab-can-declare): the
  support matrix, which compositions a lab can declare and which tests pin each row.
- [CONTRIBUTING.md](CONTRIBUTING.md#make-your-first-change): a first change, offline, and the
  tests and contracts that common changes touch.
