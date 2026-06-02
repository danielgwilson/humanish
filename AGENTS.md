# AGENTS.md

Agent instructions for `mimetic-cli`.

## Public Boundary

Assume this repository is public.

Hard rule: never commit, paste, preserve, or generate PII, PHI, secrets, keys,
tokens, raw private transcripts, private screenshots, private customer data,
private patient data, or private source snippets.

- Use synthetic personas, synthetic emails, synthetic screenshots, and redacted
  proof examples only.
- Do not copy `.env*`, credential files, hosted logs with identifiers, or
  artifact bundles that may contain sensitive user data.
- Do not let private upstream context leak into docs, examples, issue
  bodies, fixtures, tests, Observer screenshots, or generated run bundles.
- If an artifact might contain PII, PHI, credentials, or private operational
  context, summarize the shape and keep the raw artifact outside this repo.
- Public usefulness beats private convenience. When in doubt, redact,
  synthesize, or stop and ask.

## Mission

- Build a reusable CLI and harness standard for persona simulation.
- Keep reusable substrate in core code and product truth in adapters.
- Make product feedback loops cheap: run manifests, scenario profiles, actor
  traces, Observer views, review packets, and proof artifacts.
- Treat run bundles as the source of truth and Observer as the projection.

## Architecture Principles

- Adapter-first, not config sprawl: product-specific apps, ports, env
  allowlists, routes, scenarios, milestones, and review vocabulary belong in
  adapters.
- Core owns generic primitives: manifests, artifact layout, source packaging,
  actor orchestration, lifecycle events, Observer rendering, run review, and
  history indexing.
- CLI JSON envelopes must be truthful. Unsupported capabilities fail closed
  with structured errors.
- Proof artifacts are API surface. Treat paths, schemas, and review packets as
  durable contracts.
- Prefer fixtures and contract tests over prose claims.

## Development Rules

- Keep `main` clean. Use scoped branches or worktrees for feature work.
- Make small commits with explicit scope.
- Before substantial work, read [`docs/ramp/README.md`](docs/ramp/README.md)
  and [`docs/goals/current.md`](docs/goals/current.md).
- Do not commit generated proof artifacts, local env files, E2B/runtime caches,
  `.npmrc`, packed tarballs, or provider credentials.
- Before extracting from any source project, classify the code as core, CLI
  shell, Observer, adapter contract, or example adapter.
- Before publishing, run the release gates in
  [`docs/release/open-source-readiness.md`](docs/release/open-source-readiness.md).

## Acceptance Bar

- A change is not done until it has command-level proof.
- Harness changes need tests or fixture artifacts that prove the contract.
- Adapter changes need at least one safe dry-run path and one realistic path
  where credentials allow it.
- End substantial work with what changed, what was checked, and what remains
  uncertain.
