# mimetic-cli

Incubator for a generalizable product simulation CLI and proof harness.

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

## Status

Repository chassis only. Implementation should start from source comparison and contract design, not a from-scratch rewrite.
