# 0003: Managed paths bind to physical identities; cleanup uses create-time receipts

Accepted in 0.15.1, extended in 0.36.0 (`humanish reclaim`) and after 0.110.0 (search by owner
tags).

## Context

Before 0.15.1, run storage and output paths followed whatever the filesystem said at write time,
so a link or a traversal-shaped id could redirect a write outside `.humanish/`. `humanish cleanup`
also read provider ids from `run.json`, a file that can be edited or shared, and acted on them.
Separately, an account-wide provider operation once destroyed unrelated infrastructure.

## Decision

- Managed run, Observer, feedback, study, actor-output, git-metadata and source-archive paths bind
  to validated physical filesystem identities. Traversal-shaped ids, unsafe links, special files
  and root retargeting are rejected before any write.
- Provider ids in `run.json` are evidence. Nothing mutates a provider resource because of them.
- The process that creates a resource cleans it up with the handle it holds. After a crash,
  `humanish reclaim` kills sandboxes by the exact ids journaled at create time in the run's
  `sandbox-receipts.ndjson`, and reports each outcome.
- Nothing lists an account's resources unfiltered. Every sandbox carries its run's owner tags
  (`tool`, `runId`, `runKey`), and reclaim lists only the sandboxes E2B matches to all three,
  checks each tag again before it acts, and stops after three pages. A sandbox whose id never
  reached a receipt, from a create that threw after E2B allocated or a process that died
  mid-create, is otherwise unreachable until its timeout.

## Consequences

- A shared operator key is safe to use: humanish reaches only resources it created. `runKey` keeps
  two projects that reuse a run id from matching each other's sandboxes.
- An exported bundle does not carry cleanup authority; `export` omits the receipt journal.
- Unverified git metadata (arbitrary `gitdir:` redirects) is reported as unavailable instead of
  followed.

## Enforced by

- `src/run/paths.ts` and `src/run/contained-output.ts`, with `tests/run/path-containment.test.ts`.
- `src/run/git-workspace.ts`, with `tests/run/git-state.test.ts`.
- `src/run/reclaim.ts`, with `tests/run/reclaim.test.ts`.
- Reclamation by exact created id, in [invariants and defaults](../principles/invariants-and-defaults.md).
