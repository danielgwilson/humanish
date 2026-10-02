# Engineering principles

These are the judgment calls behind the rules in [AGENTS.md](https://github.com/danielgwilson/humanish/blob/main/AGENTS.md). Read them
before adding a service, mode, dependency or new boundary.

## Engineering Judgment

Public OSS quality includes clear, idiomatic code, straightforward setup and
low maintenance cost, alongside correctness, privacy and security.

- **KISS:** use familiar patterns, existing repo code and maintained upstream
  components. Judge total complexity: dependencies, services, configuration,
  deployment and failure handling as well as source lines.
- **YAGNI:** implement the requested behavior. Explicit near-term requirements
  constrain today's design: defer their implementation, not compatibility. Avoid
  choices that force an overhaul to deliver an already-required follow-up.
  Speculative future uses do not justify frameworks.
- **DRY:** share policy and behavior that must stay consistent. Similar-looking
  code alone does not justify an abstraction; modest duplication can be clearer.
- Deliver one working end-to-end path early, then harden it. An experiment is
  not a release, and its qualification fixture need not become the architecture.
- Before adding a service, protocol, mode or framework, explain the concrete
  need and why an existing approach is insufficient. A sentence in the current
  plan or PR is enough; routine changes need no separate design document.
- Apply security controls at the relevant trust boundary for a credible failure
  mode. Reuse established controls; public visibility alone does not justify
  new runtime restrictions. Simplicity does not waive isolation or authorization.
- Prefer removing an unnecessary mechanism to adding more documentation and
  tests around it. Existing work is not a reason to retain a poor design.
- If prerequisites keep expanding without an end-to-end result, reassess and
  narrow the approach. Surface material scope or architecture changes promptly;
  do not repeatedly ask permission for ordinary work already authorized.
- Keep code, comments and updates concise. Explain surprising decisions and
  tradeoffs; avoid redundant narration, invented jargon and repeated history.

## Architecture

- Product-specific routes, ports, scenarios and vocabulary belong in adapters.
  Core owns shared execution, lifecycle, evidence and review behavior. Preserve
  common interfaces across providers; avoid parallel copies of the study loop.
- CLI results must be truthful. Reject unsupported execution before side effects;
  preserve useful evidence and explain recoverable interruptions.
- Documented bundle schemas and supported artifact paths are contracts.
  Experimental receipts and internal diagnostics are not automatically APIs.
- Tests establish observed behavior, not necessarily intended behavior. Resolve
  code/test/doc conflicts against the current requirement and report the mismatch;
  neither stale prose nor a passing test makes a bug correct.

## Working And Resuming

- Read the [ramp](https://github.com/danielgwilson/humanish/blob/main/docs/ramp/README.md), current task and relevant component
  instructions. Read detailed contracts for the boundary being changed, not every
  historical roadmap. Consult the invariants for security/evidence changes and the
  release procedure before publishing.
- Keep `main` clean; use a scoped worktree/branch. Make reviewable commits.
- Existing explicit authority governs directly assigned work. Machine-readiness
  metadata gates automated queue pickup, not every interactive task. Do not
  treat an old plan as authorization to resume paused or rejected work.
- When granted autonomous shipping authority, push, open the PR, address reviews
  and required checks, merge when green, fast-forward main and clean up the task
  worktree/branch. Follow [the release procedure](https://github.com/danielgwilson/humanish/blob/main/docs/release/publish.md)
  when a release is authorized; do not add new approval steps on your own.
- Stay on `0.x` until the maintainer explicitly chooses 1.0. The next minor
  after `0.99.0` is `0.100.0`; routine shipping authority does not authorize 1.0.
- Keep one current task handoff: requested outcome, what actually works, next
  complete user-visible result, explicit constraints and rejected/deferred paths.
  Link detailed evidence; mark superseded plans historical.

## Verification

- Use evidence appropriate to the changed behavior and material risk. Docs may
  need link/command review; runtime changes need meaningful execution checks.
  Required CI and release gates remain mandatory.
- Test behavior and real failure modes, not incidental implementation structure
  unless that structure enforces a required boundary. Provider-API fixtures must
  derive from captured live wire shapes, never guesses that merely mirror code.
- Once applicable checks pass, broaden or repeat them only for a new change,
  failure or unresolved material risk. Do not rebuild upstream validation suites
  when a focused integration check answers the question.
- Claims of live execution need retained evidence; dry runs do not establish live
  behavior. State what changed, what was checked and any material uncertainty.
