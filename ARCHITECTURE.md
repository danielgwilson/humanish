# Find your way around the humanish code

This file describes the code on `main` and names real functions and files. `pnpm docs:check`
fails when a path in it no longer exists, or when a file named beside a function or type no
longer declares that name. [CONTEXT.md](CONTEXT.md) defines the domain terms, and
[docs/decisions/](docs/decisions/README.md) records the decisions behind the rules below.

## Follow one `humanish run <lab>` from manifest to findings

The steps follow a live computer-use lab on a hosted E2B desktop. The scripted, terminal and
shared-world routes share steps 1, 2, 7 and 8 and do steps 3 to 6 in their own route files. The
preview route writes a fixture bundle with `runDryRun` (`src/run/dry-run.ts`), publishes it as in
step 6, and renders it as in step 7 when `RunOptions.observer` asks, as every CLI caller does.

1. **Parse.** `runLabCommand` (`src/cli/commands/lab-run.ts`) calls `resolveLabManifest`
   (`src/lab/discover.ts`), which reads the YAML and calls `parseLabConfig` (`src/lab/config.ts`).
   It rejects unknown keys and every refused composition in the
   [support matrix](docs/ramp/README.md#check-which-compositions-a-lab-can-declare). A refusal
   exits with code 2 before a run id exists.
2. **Route.** `routeOf` (`src/lab/plan.ts`) picks one of five routes from `subject.source`,
   `subject.topology`, `execution.target` and the registry lane of `actors[0].type`. `runLabCommand`
   runs that route's CLI setup, here `cuaBackendRun` (`src/cli/commands/lab-backend-cua.ts`), and
   `runBackend` (`src/cli/commands/lab-backend-run.ts`) calls `runLab` (`src/lab/engine.ts`). `runLab`
   maps library options with `normalizeRunLabOptions` (`src/lab/run-lab-options.ts`) and calls the
   route, here `runCuaActorLab`. Each route folder under `src/routes/` takes its refusals and plan
   from its `plan.ts`. A run is live only when the lab declares `scenario.mode: live`; `--dry-run`
   forces a dry run.
3. **Preflight.** `planComputerUseLab` (`src/routes/computer-use/plan.ts`) repeats the parse
   checks for library callers. On a live run, `liveCuaRejection`
   (`src/routes/computer-use/preflight.ts`) checks provider keys, the local agent login and
   subject env vars, and refuses a dollar cap it cannot price. Both run before any sandbox or
   provider call.
4. **Desktop.** `createE2BParticipantDesktop` (`src/routes/computer-use/e2b-desktop.ts`) runs the
   lane's steps from the `e2b-desktop-*.ts` files beside it. `acquireE2BDesktopSandbox`
   (`src/substrates/e2b/sandbox.ts`) appends the sandbox id to `sandbox-receipts.ndjson` before it
   returns the handle. A `clone` or `local-tree` subject is provisioned through `src/subject/`,
   which reaches the sandbox only through the `Shell` that `e2bShell` (`src/substrates/e2b/shell.ts`)
   returns. An `app-url` lab with `execution.target: local` runs `runLocalFirecrackerStudy`
   (`src/routes/computer-use/local-vm.ts`) instead.
5. **Participants.** `runAllCuaLanes` (`src/routes/computer-use/lanes.ts`) runs `runCuaLane` for
   each participant, at most `execution.concurrency` at a time. A lane's session is
   `runCuaActorSession` (`src/actors/computer-use/actor.ts`), which drives `runComputerUseLoop`
   (`src/actors/computer-use/loop.ts`). The loop saves screenshots through
   `makeLaneWriteScreenshot`, which checks each image with `assertScreenshotEvidence`
   (`src/evidence/image.ts`). Screenshots are blurred only when a lab sets
   `policies.redactScreenshots: true`.
6. **Bundle.** The route started its run with `runScope` and `startRun` (`src/run/run.ts`) before
   any sandbox. It publishes an in-progress bundle with `Run.writeSnapshot`, rewrites it from the
   lanes' live traces through `startLiveTraceFlush` (`src/routes/computer-use/live-flush.ts`), and
   publishes the final bundle from `buildCuaRunBundle` (`src/routes/computer-use/assemble.ts`)
   with `Run.finish`. That writes `run.json`, then the `status.json` outcome, then `review.json`,
   `review.md`, `events.ndjson` and `observer/observer-data.json`, and the
   `.humanish/runs/latest.json` pointer last. Every route publishes the same way.
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

| Folder                         | What it holds                                                                          | Read first                           |
| ------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------ |
| `src/cli/`                     | The commander program, with one file per command family in `commands/`                 | `src/cli/program.ts`                 |
| `src/keys/`                    | Provider key discovery: env files, the user key store and key-source probes            | `src/keys/key-resolution.ts`         |
| `src/lab/`                     | Lab manifest types, parsing, validation, routing and dispatch                          | `src/lab/engine.ts`                  |
| `src/routes/`                  | One folder per route; `routeOf` in `src/lab/plan.ts` picks it                          | `src/lab/plan.ts`                    |
| `src/routes/computer-use/`     | Computer-use participants and the desktops composing `src/substrates/` with route code | `src/routes/computer-use/lab.ts`     |
| `src/routes/scripted-browser/` | Committed scenario steps replayed on a loopback app or a provisioned clone             | `src/routes/scripted-browser/lab.ts` |
| `src/routes/shared-world/`     | Several seats on one shared plane, provisioned or external-public                      | `src/routes/shared-world/lab.ts`     |
| `src/routes/terminal/`         | A Codex agent in an E2B shell against a terminal product, with its ledgers             | `src/routes/terminal/lab.ts`         |
| `src/actors/`                  | The actor contract, the registry and each actor's session code                         | `src/actors/registry.ts`             |
| `src/subject/`                 | Subject provisioning over a `Shell`: clone, local tree, desktop CLI, serve             | `src/subject/serve.ts`               |
| `src/substrates/`              | Provider primitives: E2B in `e2b/`, Firecracker and Lima VMs in `local/`, the `Shell`  | `src/substrates/desktop-session.ts`  |
| `src/run/`                     | Run lifecycle, bundle types, bundle guards, paths, status, receipts, reclaim           | `src/run/run.ts`                     |
| `src/verify/`                  | `humanish verify`: evidence checks, share-safety grades, cost and rerun checks         | `src/verify/verify.ts`               |
| `src/evidence/`                | Redaction, screenshot checks and desktop recordings                                    | `src/evidence/redaction.ts`          |
| `src/analysis/`                | Automatic and on-demand study analysis                                                 | `src/analysis/automatic.ts`          |
| `src/observer/`                | Observer data, the HTML render and the local server                                    | `src/observer/render.ts`             |
| `src/comms/`                   | Captured and received email for participant inboxes                                    | `src/comms/types.ts`                 |
| `src/feedback/`                | Feedback drafts and export bundles                                                     | `src/feedback/feedback.ts`           |
| `src/tui/`                     | The CLI side of `humanish tui`                                                         | `src/tui/launch.ts`                  |
| `src/browser-control/`         | The host-guest browser control protocol                                                | `src/browser-control/protocol.ts`    |
| `src/guest-*.ts`               | The guest runtime, which the desktop image launches by path                            | `src/guest-runtime-main.ts`          |
| `observer/`                    | The Observer page, a single-file Vite build                                            | `observer/AGENTS.md`                 |
| `tui/`                         | The Ink terminal app                                                                   | `tui/AGENTS.md`                      |
| `site/`                        | humanish.dev and its user docs in `site/content/docs/`                                 | `site/AGENTS.md`                     |
| `humanish/`                    | This repo's own labs, personas, scenarios, fixtures and coverage notes                 | `humanish/labs/first-run.yaml`       |
| `examples/`                    | Library examples shipped in the npm package: a participant and a scorer                | `examples/README.md`                 |
| `adapters/`                    | Adapter fixture sets that `tests/lab/adapter-fixtures.test.ts` checks                  | `adapters/fixtures/README.md`        |
| `bench/`                       | Benchmark apps with planted defects and their dated results                            | `bench/DEFECTS.md`                   |
| `fixtures/`                    | Synthetic apps and cases that tests and scripts copy                                   | `fixtures/minimal-app/README.md`     |
| `skills/`                      | The companion agent skill that `npx skills add` installs                               | `skills/humanish/SKILL.md`           |
| `runtime/`                     | Desktop and browser image recipes                                                      | `runtime/browser-guest/README.md`    |
| `scripts/`                     | Proof, release and check scripts that `package.json` runs                              | `scripts/check-doc-paths.ts`         |
| `docs/contracts/`              | Bundle and schema contracts, whose documented fields are API                           | `docs/contracts/run-bundle.md`       |
| `tests/`                       | Vitest suites that mirror `src/`, plus the folders named below the table               | `tests/helpers/run-golden.ts`        |

`pnpm docs:check` fails when a folder directly under `src/` or `src/routes/` has no row here, or
when a row names a folder that is gone. Add the row in the change that adds the folder.

Six folders in `tests/` sit outside that mirror. `tests/admission/` pins what the CLI and the
library do when they refuse a lab before a run starts, and `tests/scripts/` tests `scripts/`.
`tests/surface/` checks the README, the site, `site/public/llms.txt`, the agent skill and the package
against the shipped CLI. `tests/helpers/`, `tests/fixtures/` and `tests/golden/` hold shared test
code, inputs and goldens.

## Keep these invariants when you change code

| Invariant                                                               | Enforced by                                                                                                                                                                                                                                                                                         | Pinned by                                                                                                                                                                                                  |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The run bundle is the source of truth, and the Observer derives from it | `verifyRun` reads only `run.json` and its artifacts (`src/verify/verify.ts`); `buildObserverData` takes the bundle (`src/observer/data.ts`)                                                                                                                                                         | `tests/observer/data-contract.test.ts`, `docs/decisions/0001-run-bundle-is-the-source-of-truth.md`                                                                                                         |
| Unsupported execution is refused before side effects                    | `parseLabConfig` (`src/lab/config.ts`), `taskProtocolValidationReason` (`src/lab/validation.ts`), `planComputerUseLab` (`src/routes/computer-use/plan.ts`)                                                                                                                                          | `tests/lab/task-route-preflight.test.ts`; `pnpm cli:preflight:test` runs `scripts/task-route-preflight-proof.mjs` with `tests/fixtures/task-route-preflight/deny-side-effects.mjs` preloaded               |
| A sandbox id is recorded before any work runs in it                     | `acquireE2BDesktopSandbox` and `acquireE2BShellSandbox` (`src/substrates/e2b/sandbox.ts`) write the receipt before they return the handle, and every route that creates a sandbox calls them; `reclaimRunSandboxes` (`src/run/reclaim.ts`) switches on the receipt's provider and kills by exact id | `tests/substrates/e2b/sandbox.test.ts`, `tests/routes/terminal/acquisition-boundary.test.ts`, `tests/run/reclaim.test.ts`; `tests/routes/scripted-browser.test.ts` checks create, receipt, then first work |
| Bundles carry no secrets                                                | `redactText` and `scrubLiterals` (`src/evidence/redaction.ts`); `scanRunPublicSafetyArtifacts` (`src/verify/artifacts.ts`); `buildShareSafety` (`src/verify/verify.ts`) grades `share_ready`, `local_only` or `blocked`                                                                             | `tests/evidence/redaction-hooks.test.ts`, `tests/run/transient-comms-secrets.test.ts`, `tests/verify/evidence-refs.test.ts`                                                                                |
| Goldens pin route output                                                | `runDirSnapshot` (`tests/helpers/run-golden.ts`) snapshots a whole run folder                                                                                                                                                                                                                       | `tests/golden/routes/`, `tests/golden/observer-data/`, `tests/golden/labs/`                                                                                                                                |
| A run is closed on every exit, and only a published run is analyzed     | `runScope` and `FinishedRun` (`src/run/run.ts`); `completeAutomaticAnalysis` requires an issued `FinishedRun` for the result's run                                                                                                                                                                  | `tests/run/run-lifecycle.test.ts`, `tests/analysis/automatic-analysis.test.ts`                                                                                                                             |

The receipt write is best-effort; the sandbox's server-side timeout ends a sandbox with no
receipt. A lab preflight probe journals its receipt with `withPreflightSandbox`
(`src/lab/preflight-probes.ts`), and `humanish reclaim --preflight` (`src/run/reclaim.ts`) kills
what a failed probe left. [Trust boundaries](site/content/docs/trust-boundaries.mdx) gives the
probe timeouts.

## Read next

- [docs/architecture/project-layout.md](docs/architecture/project-layout.md): the `humanish/`
  and `.humanish/` folders in a project that runs studies.
- [docs/ramp/README.md](docs/ramp/README.md#check-which-compositions-a-lab-can-declare): the
  support matrix, which compositions a lab can declare and which tests pin each row.
- [CONTRIBUTING.md](CONTRIBUTING.md#make-your-first-change): a first change, offline, and the
  tests and contracts that common changes touch.
