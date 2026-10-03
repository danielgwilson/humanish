# Find the right doc

User guides live at [humanish.dev/docs](https://humanish.dev/docs). This page sorts the contributor
reference under `docs/` by what it is for. To make a first change, start with
[CONTRIBUTING.md](https://github.com/danielgwilson/humanish/blob/main/CONTRIBUTING.md#make-your-first-change).

## Follow a guide to do a task

- [ramp/README.md](https://github.com/danielgwilson/humanish/blob/main/docs/ramp/README.md): current state, how to pick work and the quality bar.
- [release/publish.md](https://github.com/danielgwilson/humanish/blob/main/docs/release/publish.md): check a release candidate, tag it and publish it.

## Look up what the code does now

- [contracts/](contracts/README.md): bundle, study, policy, feedback, analysis and cost contracts.
  Documented fields are API. [contracts/schemas.md](contracts/schemas.md) indexes every schema.
- [architecture/observer.md](architecture/observer.md), [architecture/serve.md](architecture/serve.md):
  the Observer and the run library server.
- [architecture/desktop-sessions.md](architecture/desktop-sessions.md),
  [architecture/browser-control.md](architecture/browser-control.md),
  [architecture/guest-desktop.md](architecture/guest-desktop.md): hosted desktops, the browser
  control protocol and the guest runtime.
- [architecture/state-driven-executor.md](architecture/state-driven-executor.md): the `ComputerUseExecutor`
  library path.
- [architecture/task-protocol-support.md](architecture/task-protocol-support.md): which routes
  accept `actor.tasks`.
- [architecture/external-public-shared-world.md](architecture/external-public-shared-world.md) and
  [architecture/terminal-product-route.md](architecture/terminal-product-route.md): two routes in
  depth.
- [architecture/restricted-codex-analysis.md](architecture/restricted-codex-analysis.md) and
  [product/automatic-analysis.md](product/automatic-analysis.md): study analysis.
- [release/public-readiness-standard.md](https://github.com/danielgwilson/humanish/blob/main/docs/release/public-readiness-standard.md): what may appear in
  the public repository and the npm package.

## Read why the code is shaped this way

- [principles/engineering.md](principles/engineering.md),
  [principles/invariants-and-defaults.md](principles/invariants-and-defaults.md),
  [principles/actor-fidelity.md](principles/actor-fidelity.md),
  [principles/three-roles.md](principles/three-roles.md) and
  [principles/self-driving-harness.md](principles/self-driving-harness.md): engineering,
  invariants and defaults, actor fidelity, the three roles and the self-driving harness.
- [decisions/](decisions/README.md): one record per decision, each naming the code or test that
  enforces it.
- [architecture/actor-contract.md](architecture/actor-contract.md) and
  [architecture/github-feedback-loop.md](architecture/github-feedback-loop.md): design records with
  their context and open items.

## Check the current state and the evidence behind it

- [status.md](https://github.com/danielgwilson/humanish/blob/main/docs/status.md): what ships today, by surface, and the work that is gated.
- [evidence/](https://github.com/danielgwilson/humanish/blob/main/docs/evidence/README.md): dated study records that the README, the site and these pages
  cite. `docs:check` covers them.

## Treat history as history

[history/](https://github.com/danielgwilson/humanish/blob/main/docs/history/README.md) holds dated goal packets, plans and the roadmap. They may name files
that have since moved, so `docs:check` skips them (`HISTORY_DIRECTORIES` in
[scripts/lib/doc-paths.ts](https://github.com/danielgwilson/humanish/blob/main/scripts/lib/doc-paths.ts)).

`assets/` holds images that ship in the npm package, such as the README hero.
