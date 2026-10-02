# Find the right doc

To make a first change, start with [CONTRIBUTING.md](../CONTRIBUTING.md#make-your-first-change). This page
sorts everything under `docs/` by what it is for. Nothing here moves files; a folder that holds more
than one kind is split file by file.

## Follow a guide to do a task

- [ramp/README.md](ramp/README.md): current state, how to pick work and the quality bar.
- [architecture/local-browser-runtime.md](architecture/local-browser-runtime.md): run a study in a
  local Firecracker browser.
- [architecture/real-email-receiving.md](architecture/real-email-receiving.md) and
  [architecture/comms-inbox.md](architecture/comms-inbox.md): give participants real or captured
  inboxes.
- [architecture/participant-media.md](architecture/participant-media.md) and
  [architecture/desktop-recording.md](architecture/desktop-recording.md): add a camera, speech or
  a desktop video.
- [architecture/observer-review.md](architecture/observer-review.md): watch and review a study.
- [architecture/project-layout.md](architecture/project-layout.md): the `humanish/` and
  `.humanish/` folders `init` creates.
- [product/lobby-trivia-3player-external-public.md](product/lobby-trivia-3player-external-public.md):
  a worked example of the external-public shared-world lab.
- [release/open-source-readiness.md](release/open-source-readiness.md): the release gates and the
  publish procedure. Its opening audit is a dated snapshot.

## Look up what the code does now

- [contracts/](contracts/schemas.md): bundle, lab, policy, feedback, analysis and cost contracts.
  Documented fields are API. [contracts/schemas.md](contracts/schemas.md) indexes every schema.
- [architecture/observer.md](architecture/observer.md), [architecture/serve.md](architecture/serve.md):
  the Observer and the run library server.
- [architecture/desktop-sessions.md](architecture/desktop-sessions.md),
  [architecture/browser-control.md](architecture/browser-control.md),
  [architecture/guest-desktop.md](architecture/guest-desktop.md): hosted desktops, the browser
  control protocol and the guest runtime.
- [architecture/state-driven-executor.md](architecture/state-driven-executor.md): the `CuaExecutor`
  library path.
- [architecture/task-protocol-support.md](architecture/task-protocol-support.md): which routes
  accept `actors[0].tasks`.
- [architecture/external-public-shared-world.md](architecture/external-public-shared-world.md) and
  [architecture/terminal-product-route.md](architecture/terminal-product-route.md): two routes in
  depth. Both keep dated slice notes beside the current rules.
- [architecture/restricted-codex-analysis.md](architecture/restricted-codex-analysis.md) and
  [product/automatic-analysis.md](product/automatic-analysis.md): study analysis.
- [release/public-readiness-standard.md](release/public-readiness-standard.md): what may appear in
  the public repository and the npm package.

## Read why the code is shaped this way

- [principles/](principles/engineering.md): engineering, invariants and defaults, actor fidelity,
  the three roles and the self-driving harness.
- [decisions/](decisions/README.md): one record per decision, each naming the code or test that
  enforces it.
- [architecture/actor-contract.md](architecture/actor-contract.md) and
  [architecture/github-feedback-loop.md](architecture/github-feedback-loop.md): design records with
  their context and open items.
- [product/open-source-install-experience.md](product/open-source-install-experience.md): the
  product target for install and first run.

## Treat these folders as history

`goals/`, `plans/` and `roadmap/` hold dated plans, status logs and receipts. They may name files
that have since moved, so `docs:check` skips them (`HISTORY_DIRECTORIES` in
[scripts/lib/doc-paths.ts](../scripts/lib/doc-paths.ts)). One file there is current:
[goals/current.md](goals/current.md), the live status page.

`assets/` holds images that ship in the npm package, such as the README hero.
