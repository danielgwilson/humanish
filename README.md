# mimetic-cli

Private incubator for a generalizable product simulation CLI and proof harness.

Important: this repository is expected to become public. Do not commit PII,
PHI, secrets, keys, tokens, raw private transcripts, private screenshots, or
private product artifacts. Use synthetic or redacted examples only.

`mimetic-cli` is intended to extract the reusable substrate behind:

- Northstar `ui-sim`
- NoBG `ui-sim`
- Image Skill simulation / self-driving product harness work

The intended shape is adapter-first: core packages provide the durable simulation machinery, while product adapters define app topology, routes, personas, scenarios, milestones, runtime commands, and review vocabulary.

This repo dogfoods Mimetic through committed [`mimetic/`](mimetic/) source
files. The local operator path is one command:

```bash
pnpm mimetic:watch
```

That starts a 4-sim synthetic self-run, renders Observer, opens it in the
browser through a localhost watch server, and keeps the shell attached. Current
self-runs are still contract proof only; real Codex TUI actors, browser
execution, and app-server adapters are the next capability ladder.

## Local Layout

```text
~/local_git/mimetic-cli-repo/
  mimetic-cli/   # canonical checkout
  worktrees/     # sibling feature worktrees
```

## Initial Scope

- Define the adapter contract.
- Extract shared artifact, manifest, observer, actor, and run-review primitives.
- Port NoBG as the first adapter proof.
- Port Image Skill or Northstar as a second adapter proof before treating the abstraction as stable.

## Development

```bash
pnpm install
pnpm check
pnpm mimetic -- --help
```

## OSS Lab POC

The disposable outside-world proof loop is:

```bash
pnpm mimetic:lab:oss
```

That shallow clones a small set of public GitHub JavaScript repos into ignored
`.mimetic/tmp`, applies Mimetic setup inside the throwaway clones, runs the
four-lane synthetic Observer proof, verifies it, writes an ignored report under
`.mimetic/lab/oss`, and removes the clones by default. Use
`pnpm mimetic -- lab oss --limit 1 --keep` when debugging a single clone.

## Target App Quickstart

The package is still marked `private: true` until Daniel chooses the public
license and approves publication. Once released, target repos should use:

```bash
npm i -D mimetic-cli
npx mimetic init --dry-run --json
npx mimetic init --yes --json
npx mimetic watch
npx mimetic watch --json --no-open
npx mimetic feedback issue --run latest --repo example/app --format markdown
```

The current CLI implements safe `init`, synthetic dry-run bundles, verification,
a mission-control Observer with stream contracts, localhost watch mode with
browser open, terminal/TUI panes, and public-safe feedback issue
drafts. Live browser execution, provider-backed actors, native Codex app-server
adapters, and GitHub mutation remain intentionally unimplemented.

## Observer

`mimetic watch` starts a fresh four-lane synthetic run, opens the localhost
Observer, and keeps the shell attached. `mimetic watch --json --no-open` is the
agent/CI-safe equivalent: same fresh run and Observer artifacts, no browser
open, no long-running shell.

Observer writes:

```text
.mimetic/runs/<run-id>/
  run.json
  review.json
  review.md
  events.ndjson
  observer/
    index.html
    observer-data.json
```

The Observer serves `observer/index.html` over localhost in follow mode and
polls `observer-data.json`. Stream lanes are first-class: UI, CLI, TUI, and
Codex UI are rendered as distinct watchable sims. See
[Observer architecture](docs/architecture/observer.md).

## Current Design Notes

- [Sim systems context dump](docs/ramp/2026-05-31-sim-systems-context-dump.md)
- [Self-driving feedback ramp](docs/ramp/2026-06-01-self-driving-feedback-ramp.md)
- [GitHub control plane setup](docs/ramp/2026-06-01-github-control-plane-setup.md)
- [Self-driving harness principles](docs/principles/self-driving-harness.md)
- [GitHub feedback loop architecture](docs/architecture/github-feedback-loop.md)
- [Feedback contract](docs/contracts/feedback.md)
- [Open-source install experience](docs/product/open-source-install-experience.md)
- [Agent skill entrypoint](docs/skill/mimetic-cli/SKILL.md)
- [Project layout contract](docs/architecture/project-layout.md)
- [OSS lab POC](docs/architecture/oss-lab-poc.md)
- [World-class open-source v0 roadmap](docs/roadmap/world-class-open-source-v0.md)
- [Open-source release readiness](docs/release/open-source-readiness.md)
- [Mimetic CLI open-source v0 goal](docs/goals/mimetic-cli-open-source-v0/goal.md)

## Status

Package scaffold, safe `mimetic init` layout work, a minimal synthetic target
app fixture, synthetic dry-run bundle verification, static observer rendering,
browser-open watch mode, public-safe feedback issue drafts, and repo
self-dogfood config are implemented for the dry-run v0 slice. Implementation
should continue from source comparison and contract design, not a from-scratch
rewrite.
