# mimetic-cli

Incubator for a generalizable product simulation CLI and proof harness.

Important: this repository is expected to become public. Do not commit PII,
PHI, secrets, keys, tokens, raw private transcripts, private screenshots, or
private product artifacts. Use synthetic or redacted examples only.

`mimetic-cli` is intended to extract the reusable substrate behind:

- multi-app harness `browser-sim`
- web-app harness `browser-sim`
- terminal/product harness simulation / self-driving product harness work

The intended shape is adapter-first: core packages provide the durable simulation machinery, while product adapters define app topology, routes, personas, scenarios, milestones, runtime commands, and review vocabulary.

## Local Layout

```text
<workspace>/mimetic-cli-repo/
  mimetic-cli/   # canonical checkout
  worktrees/     # sibling feature worktrees
```

## Initial Scope

- Define the adapter contract.
- Extract shared artifact, manifest, observer, actor, and run-review primitives.
- Port web-app harness as the first adapter proof.
- Port terminal/product harness or multi-app harness as a second adapter proof before treating the abstraction as stable.

## Current Design Notes

- [Sim systems context dump](docs/release/2026-05-31-sim-systems-context-dump.md)
- [Self-driving feedback ramp](docs/release/2026-06-01-self-driving-feedback-ramp.md)
- [GitHub control plane setup](docs/release/2026-06-01-github-control-plane-setup.md)
- [Self-driving harness principles](docs/principles/self-driving-harness.md)
- [GitHub feedback loop architecture](docs/architecture/github-feedback-loop.md)
- [Feedback contract](docs/contracts/feedback.md)

## Status

Repository chassis only. Implementation should start from source comparison and contract design, not a from-scratch rewrite.
