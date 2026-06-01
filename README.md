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

## Target App Quickstart

The package is still marked `private: true` until Daniel chooses the public
license and approves publication. Once released, target repos should use:

```bash
npm i -D mimetic-cli
npx mimetic init --dry-run --json
npx mimetic init --yes --json
npx mimetic run --dry-run --json
npx mimetic verify --run latest --json
npx mimetic watch --run latest --no-open --json
npx mimetic feedback issue --run latest --repo example/app --format markdown
```

The current CLI implements safe `init`, synthetic dry-run bundles, verification,
static observer rendering, and public-safe feedback issue drafts. Live browser
execution, provider-backed actors, and GitHub mutation remain intentionally
unimplemented.

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
- [World-class open-source v0 roadmap](docs/roadmap/world-class-open-source-v0.md)
- [Open-source release readiness](docs/release/open-source-readiness.md)
- [Mimetic CLI open-source v0 goal](docs/goals/mimetic-cli-open-source-v0/goal.md)

## Status

Package scaffold, safe `mimetic init` layout work, a minimal synthetic target
app fixture, synthetic dry-run bundle verification, static observer rendering,
and public-safe feedback issue drafts are implemented for the dry-run v0 slice.
Implementation should continue from source comparison and contract design, not a
from-scratch rewrite.
