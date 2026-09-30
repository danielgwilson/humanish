# Find your way around the humanish code

This file describes the code on `main` and names real functions and files. `pnpm docs:check`
fails when a path in it no longer exists. [CONTEXT.md](CONTEXT.md) defines the domain terms.
[docs/decisions/](docs/decisions/README.md) records the decisions behind the rules below.

## Follow one `humanish run <lab>` from manifest to findings

The steps use a live computer-use lab on a hosted E2B desktop. The scripted, terminal and
shared-world routes share steps 1, 2, 8 and 9, and each does steps 3 to 7 in its own route file.
The synthetic route writes a fixture bundle with `runDryRun` (`src/run/dry-run.ts`) and skips
steps 3 to 7 and 9.

1. `runLabCommand` (`src/cli/commands/lab-run.ts`) calls `resolveLabManifest`
   (`src/lab/discover.ts`). It reads the YAML and calls `parseLabConfig` (`src/lab/config.ts`),
   which rejects unknown keys and every refused composition in the support matrix below. A
   refusal exits with code 2 before a run id exists.
2. `routeOf` (`src/lab/plan.ts`) picks one of five routes from `subject.source`,
   `subject.topology`, `execution.target` and the registry lane of `actors[0].type`. The
   predicates live in `src/lab/routing.ts`, and `selectLabBackend` (`src/lab/engine.ts`) maps the
   route to its backend name. `runLab` in `src/lab/engine.ts` dispatches to
   `runCuaActorLab`, `runScriptedBrowserLab`, `runTerminalProductLab`,
   `runConcurrentSharedWorld` or `runDryRun`. A run is live only when the lab declares
   `scenario.mode: live`. The `--dry-run` flag forces a dry run.
3. `cuaLabRejection` (`src/routes/computer-use/preflight.ts`) repeats the parse checks for
   library callers. On a live run, `liveCuaRejection` in the same file checks provider keys, the
   local agent login and subject env vars, and refuses a dollar cap it cannot price. Both run
   before any sandbox or provider call.
4. `createE2BCuaDesktopLane` (`src/substrates/e2b/cua-desktop.ts`) calls
   `acquireE2BDesktopSandbox` (`src/substrates/e2b/sandbox.ts`). It creates the sandbox, retries
   once on a transient provider error, and appends the id with `"provider": "e2b"` to
   `sandbox-receipts.ndjson` before it returns the handle. The lane then provisions a `clone` or
   `local-tree` subject with `provisionCloneSubject` or `provisionLocalTreeSubject`
   (`src/subject/`), which reach the sandbox only through the `Shell` that `e2bShell`
   (`src/substrates/e2b/shell.ts`) builds from it. An `app-url` lab with
   `execution.target: local` goes to `runLocalFirecrackerStudy`
   (`src/substrates/local/firecracker-study.ts`) instead.
5. `runAllCuaLanes` (`src/routes/computer-use/lanes.ts`) runs `runCuaLane` for each
   participant, at most `execution.concurrency` at a time. Each lane calls the actor's `runSession`. For
   `openai-computer-use` and `local-agent` that is `runCuaActorSession`
   (`src/actors/computer-use/actor.ts`), which drives `runComputerUseLoop`
   (`src/actors/computer-use/loop.ts`).
6. The loop saves screenshots through `makeLaneWriteScreenshot` (`src/routes/computer-use/lanes.ts`),
   which checks each image with `assertScreenshotEvidence` (`src/evidence/image.ts`). Lane errors
   pass through `redactText` (`src/evidence/redaction.ts`) before they are recorded. Screenshots
   are blurred only when the lab sets `policies.redactScreenshots: true`.
7. `buildCuaRunBundle` (`src/routes/computer-use/assemble.ts`) builds `run.json`.
   `writeCuaRunArtifacts` (`src/routes/computer-use/bundle.ts`) writes it with `review.json`,
   `events.ndjson`, `observer/observer-data.json` and the `.humanish/runs/latest.json` pointer.
   The route writes one bundle before the lanes start and the final one after they finish. The
   terminal and scripted routes instead start their run with `runScope` and `startRun` and
   publish it with `Run.finish` (`src/run/run.ts`). `Run.finish` writes `run.json`, then the
   `status.json` outcome, then `review.json`, `review.md`, `events.ndjson` and
   `observer/observer-data.json`, and the pointer last. The computer-use and shared-world routes
   move onto it next.
8. `renderObserver` (`src/observer/render.ts`) verifies the bundle with `verifyRunPrepared`
   (`src/run/verify.ts`), builds the page data with `buildObserverData` (`src/observer/data.ts`)
   and writes `observer/index.html` with `renderObserverHtml`. `humanish verify --run latest` runs
   `verifyRun` from the same file on demand.
9. After the route returns, `completeAutomaticAnalysis` (`src/analysis/automatic-completion.ts`)
   calls `runAutomaticStudyAnalysis` (`src/analysis/automatic.ts`). It takes the `FinishedRun`
   that `Run.finish` issued (`src/run/run.ts`) and reads the run id and paths from it, so a
   refusal that echoes an older run's id never analyzes that run. Routes not yet on the run scope
   pass `legacyFinishedRun(result)`. Dry runs skip analysis. A lab turns it off with
   `review.analysis: false`.

[docs/architecture/project-layout.md](docs/architecture/project-layout.md) describes the
`humanish/` and `.humanish/` folders in a project that runs studies.

## Find the code for each part of the system

| Folder                 | What it holds                                                                | Read first                          |
| ---------------------- | ---------------------------------------------------------------------------- | ----------------------------------- |
| `src/cli/`             | The commander program, with one file per command family in `commands/`       | `src/cli/program.ts`                |
| `src/lab/`             | Lab manifest types, parsing, validation, routing and dispatch                | `src/lab/engine.ts`                 |
| `src/routes/`          | One folder or file per route, each with its own bundle assembly              | `src/routes/computer-use/lab.ts`    |
| `src/actors/`          | The actor contract, the registry and each actor's session code               | `src/actors/registry.ts`            |
| `src/subject/`         | Subject provisioning over a `Shell`: clone, local tree, desktop CLI, serve   | `src/subject/serve.ts`              |
| `src/substrates/`      | E2B desktops in `e2b/`, Firecracker and Lima VMs in `local/`, the `Shell`    | `src/substrates/e2b/cua-desktop.ts` |
| `src/run/`             | Run lifecycle, bundle types, verification, paths, status, receipts, reclaim  | `src/run/run.ts`                    |
| `src/evidence/`        | Redaction, screenshot checks and desktop recordings                          | `src/evidence/redaction.ts`         |
| `src/analysis/`        | Automatic and on-demand study analysis                                       | `src/analysis/automatic.ts`         |
| `src/observer/`        | Observer data, the HTML render and the local server                          | `src/observer/render.ts`            |
| `src/comms/`           | Captured and received email for participant inboxes                          | `src/comms/types.ts`                |
| `src/feedback/`        | Feedback drafts and export bundles                                           | `src/feedback/feedback.ts`          |
| `src/tui/`             | The CLI side of `humanish tui`                                               | `src/tui/launch.ts`                 |
| `src/browser-control/` | The host-guest browser control protocol                                      | `src/browser-control/protocol.ts`   |
| `src/guest-*.ts`       | The guest runtime, which the desktop image launches by path                  | `src/guest-runtime-main.ts`         |
| `observer/`            | The Observer page, a single-file Vite build                                  | `observer/AGENTS.md`                |
| `tui/`                 | The Ink terminal app                                                         | `tui/AGENTS.md`                     |
| `site/`                | humanish.dev and its user docs in `site/content/docs/`                       | `site/AGENTS.md`                    |
| `humanish/`            | This repo's own labs, personas, scenarios, fixtures and coverage notes       | `humanish/labs/first-run.yaml`      |
| `runtime/`             | Desktop and browser image recipes                                            | `runtime/browser-guest/README.md`   |
| `scripts/`             | Proof, release and check scripts that `package.json` runs                    | `scripts/check-doc-paths.ts`        |
| `docs/contracts/`      | Bundle and schema contracts, whose documented fields are API                 | `docs/contracts/run-bundle.md`      |
| `tests/`               | Vitest suites that mirror `src/`, plus `tests/fixtures/` and `tests/golden/` | `tests/helpers/run-golden.ts`       |

## Check which compositions a lab can declare

`parseLabConfig` (`src/lab/config.ts`) enforces this matrix through `compositionReason`
(`src/lab/composition-rules.ts`), which uses the predicates in `src/lab/routing.ts` and the reasons
in `src/lab/validation.ts`. The route entries check it again
for library callers. `tests/fixtures/task-route-preflight/labs.json` holds one lab for each
accepted row except the local browser row. `tests/lab/task-route-preflight.test.ts` checks that
each of those labs routes as shown. `tests/lab/engine-local-substrate.test.ts` covers the local
browser row. Accepted rows have further required fields, such as `subject.serve` on `clone`, and
the parse error names the missing one. The computer-use actors are `openai-computer-use` and
`local-agent`.

| Route                     | `subject.source`                                 | `execution.target`       | `actors[0].type`                       | Result                                                                         |
| ------------------------- | ------------------------------------------------ | ------------------------ | -------------------------------------- | ------------------------------------------------------------------------------ |
| `cua`                     | `app-url`                                        | `e2b-desktop`            | a computer-use actor                   | Supported                                                                      |
| `cua`                     | `app-url`                                        | `local`                  | a computer-use actor                   | Supported on a local Firecracker desktop, inside Lima on macOS                 |
| `cua`                     | `clone`, `local-tree`                            | `e2b-desktop`            | a computer-use actor                   | Supported                                                                      |
| `cua`                     | `desktop-cli`                                    | `e2b-desktop` or absent  | a computer-use actor                   | Supported                                                                      |
| `cua`                     | `local-app`                                      | `local` or absent        | a computer-use actor                   | Library only; the CLI refuses it with `HUMANISH_CUA_LAB_LOCAL_APP_NO_EXECUTOR` |
| `concurrent-shared-world` | `clone`, `local-tree` + `topology: shared-world` | `e2b-desktop`            | a computer-use actor                   | Supported                                                                      |
| `concurrent-shared-world` | `app-url` + `topology: shared-world`             | `e2b-desktop`            | a computer-use actor                   | Supported with `policies.allowPublicTargets: true`                             |
| `scripted`                | `app-url` with a loopback URL                    | `local` or absent        | `scripted-browser`                     | Supported                                                                      |
| `scripted`                | `clone`                                          | `e2b-desktop`            | `scripted-browser`                     | Supported                                                                      |
| `terminal`                | `terminal-product`                               | `e2b-terminal` or absent | `codex-exec`                           | Supported                                                                      |
| `synthetic`               | `this-repo`                                      | absent                   | not `scripted-browser` or `codex-exec` | Dry run only                                                                   |
| none                      | any other pairing, except the one below          | any                      | any                                    | Refused at parse with `HUMANISH_LAB_INVALID`                                   |

One accepted shape fails at run time. A `clone` lab on `e2b-desktop` with `codex-app-server`,
which was the removed meta-lab's shape, passes parse. `runCuaActorLab` then refuses it with
`HUMANISH_CUA_LAB_ACTOR_UNSUPPORTED`. The fixture's `supported` field records which routes
accept declared `actors[0].tasks`. The `cua` labs in the fixture accept them. The other routes
refuse them at parse.

## Keep these invariants when you change code

| Invariant                                                               | Enforced by                                                                                                                                                                                                                                                                                         | Pinned by                                                                                                                                                                                                  |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The run bundle is the source of truth, and the Observer derives from it | `verifyRun` reads only `run.json` and its artifacts (`src/run/verify.ts`); `buildObserverData` takes the bundle (`src/observer/data.ts`)                                                                                                                                                            | `tests/observer/data-contract.test.ts`, `docs/decisions/0001-run-bundle-is-the-source-of-truth.md`                                                                                                         |
| Unsupported execution is refused before side effects                    | `parseLabConfig`, `taskProtocolValidationReason` (`src/lab/validation.ts`), `cuaLabRejection`                                                                                                                                                                                                       | `tests/lab/task-route-preflight.test.ts`; `pnpm cli:preflight:test` runs `scripts/task-route-preflight-proof.mjs` with `tests/fixtures/task-route-preflight/deny-side-effects.mjs` preloaded               |
| A sandbox id is recorded before any work runs in it                     | `acquireE2BDesktopSandbox` and `acquireE2BShellSandbox` (`src/substrates/e2b/sandbox.ts`) write the receipt before they return the handle, and every route that creates a sandbox calls them; `reclaimRunSandboxes` (`src/run/reclaim.ts`) switches on the receipt's provider and kills by exact id | `tests/substrates/e2b/sandbox.test.ts`, `tests/routes/terminal/acquisition-boundary.test.ts`, `tests/run/reclaim.test.ts`; `tests/routes/scripted-browser.test.ts` checks create, receipt, then first work |
| Bundles carry no secrets                                                | `redactText` and `scrubLiterals` (`src/evidence/redaction.ts`); `scanRunPublicSafetyArtifacts` (`src/run/verify-artifacts.ts`); `buildShareSafety` grades `share_ready`, `local_only` or `blocked`                                                                                                  | `tests/evidence/redaction-hooks.test.ts`, `tests/run/narration-secrets.test.ts`, `tests/verify-evidence-refs.test.ts`                                                                                      |
| Goldens pin route output                                                | `runDirSnapshot` (`tests/helpers/run-golden.ts`) snapshots a whole run folder                                                                                                                                                                                                                       | `tests/golden/routes/`, `tests/golden/observer-data/`, `tests/golden/labs/`                                                                                                                                |
| A run is closed on every exit, and only a published run is analyzed     | `runScope` and `FinishedRun` (`src/run/run.ts`); `completeAutomaticAnalysis` requires an issued `FinishedRun` for the result's run                                                                                                                                                                  | `tests/run/run-lifecycle.test.ts`, `tests/analysis/automatic-analysis.test.ts`                                                                                                                             |

The receipt write is best-effort. A failed append is ignored. The sandbox's server-side timeout
then ends a sandbox that has no receipt. Any other failure after create kills the sandbox before
the error reaches the caller. The lab preflight probe has no run directory, so it writes no
receipt and relies on that timeout alone.

## Make your first change

This walkthrough changes the persona a computer-use lane gets when neither the lane nor the actor
names one. It runs offline and spends nothing.

1. Change the `"cua-operator"` fallback in `composeLaneInstructions`
   (`src/routes/computer-use/lane-plan.ts`).
2. Run `pnpm vitest run tests/lane-persona-fallback.test.ts`. It fails because it asserts the old
   id. Update the assertion once the new id is what you want.
3. Copy `humanish/labs/dwell-window-todomvc.yaml` to `.humanish/local/labs/walkthrough.yaml`.
   Change its `id` to `walkthrough` and delete its `persona:` line.
4. Run `pnpm humanish run walkthrough --dry-run --no-open`. Read `.humanish/runs/latest.json` for
   the run id, then check `persona.id` in `.humanish/runs/<runId>/run.json`.
5. Run `pnpm humanish verify --run latest`, then `pnpm format` and `pnpm check`.

Common changes touch these tests and contracts:

| Change                    | Tests                                                                        | Contract or doc to update                                          |
| ------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| A lab manifest field      | `tests/lab/config.test.ts`, the route's tests                                | `docs/contracts/schemas.md`, `site/content/docs/lab-manifests.mdx` |
| A CLI option              | the command's tests under `tests/cli/`                                       | Run `pnpm docs:generate` to update `site/content/docs/cli.mdx`     |
| A `run.json` field        | the route's tests; rerun them with `-u` to update `tests/golden/routes/`     | `docs/contracts/run-bundle.md`                                     |
| Observer data             | `tests/observer/data-contract.test.ts` with `UPDATE_OBSERVER_DATA_GOLDENS=1` | `docs/architecture/observer.md`                                    |
| Observer UI               | `observer/tests/` and the four `observer:*:proof` scripts                    | `observer/AGENTS.md`                                               |
| A route's behavior        | `tests/routes/<route>/`, `tests/lab/task-route-preflight.test.ts`            | the support matrix above                                           |
| An actor                  | `tests/actors/`, `tests/actors/conformance.test.ts`                          | `docs/architecture/actor-contract.md`                              |
| Redaction or share safety | `tests/evidence/`, `tests/run/narration-secrets.test.ts`                     | `docs/contracts/policy.md`                                         |
| Study analysis            | `tests/analysis/`                                                            | `docs/contracts/study-analysis.md`                                 |
