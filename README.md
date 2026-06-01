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

The current CLI shell intentionally registers planned commands and fails closed
for unsupported behavior. Real `init`, dry-run bundles, observer rendering, and
feedback issue drafts are tracked in the roadmap and GitHub issue queue.

## Current Design Notes

- [Sim systems context dump](docs/ramp/2026-05-31-sim-systems-context-dump.md)
- [Self-driving feedback ramp](docs/ramp/2026-06-01-self-driving-feedback-ramp.md)
- [GitHub control plane setup](docs/ramp/2026-06-01-github-control-plane-setup.md)
- [Self-driving harness principles](docs/principles/self-driving-harness.md)
- [GitHub feedback loop architecture](docs/architecture/github-feedback-loop.md)
- [Feedback contract](docs/contracts/feedback.md)
- [Open-source install experience](docs/product/open-source-install-experience.md)
- [Project layout contract](docs/architecture/project-layout.md)
- [World-class open-source v0 roadmap](docs/roadmap/world-class-open-source-v0.md)
- [Mimetic CLI open-source v0 goal](docs/goals/mimetic-cli-open-source-v0/goal.md)

## Status

Package scaffold, safe `mimetic init` layout work, and a minimal synthetic
target app fixture are in progress. Implementation should start from source
comparison and contract design, not a from-scratch rewrite.
