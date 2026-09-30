# 0003: Managed paths bind to physical identities; cleanup uses create-time receipts

Accepted in 0.15.1 (#280), extended in 0.36.0 (`humanish reclaim`).

## Context

Before 0.15.1, run storage and output paths followed whatever the filesystem said at write time,
so a link or a traversal-shaped id could redirect a write outside `.humanish/`. `humanish cleanup`
also read provider ids from `run.json`, a file that can be edited or shared, and acted on them.
Separately, an account-wide provider operation once destroyed unrelated infrastructure.

## Decision

- Managed run, Observer, feedback, lab, actor-output, git-metadata and source-archive paths bind
  to validated physical filesystem identities. Traversal-shaped ids, unsafe links, special files
  and root retargeting are rejected before any write.
- Provider ids in `run.json` are evidence. Nothing mutates a provider resource because of them.
- The process that creates a resource cleans it up with the handle it holds. After a crash,
  `humanish reclaim` kills sandboxes by the exact ids journaled at create time in the run's
  `sandbox-receipts.ndjson`, and reports each outcome.
- No route lists an account's resources to find or verify its own.

## Consequences

- A shared operator key is safe to use: humanish reaches only resources it created.
- An exported bundle does not carry cleanup authority; `export` omits the receipt journal.
- Unverified git metadata (arbitrary `gitdir:` redirects) is reported as unavailable instead of
  followed.

## Enforced by

- `src/run-paths.ts` and `src/selected-output-paths.ts`, with `tests/run-path-containment.test.ts`.
- `src/run/git-workspace.ts`, with `tests/run/git-state.test.ts`.
- `src/run/reclaim.ts`, with `tests/run/reclaim.test.ts`.
- Invariant 7 in [invariants and defaults](../principles/invariants-and-defaults.md).
