# AGENTS.md

This repository is the incubator for `mimetic-cli`: a generalizable simulation and proof harness extracted from multi-app harness `browser-sim`, web-app harness `browser-sim`, and terminal/product harness simulation work.

Read this before making repo changes.

## Future-Public Boundary

Assume this repository will eventually become public.

Hard rule: never commit, paste, preserve, or generate PII, PHI, secrets, keys,
tokens, raw private transcripts, private customer data, private patient data, or
private source snippets from source products into this repo.

- Use synthetic personas, synthetic emails, synthetic screenshots, and redacted
  proof examples only.
- Do not copy `.env*`, local credential files, hosted logs with identifiers, or
  artifact bundles that may contain sensitive user data.
- Do not let multi-app harness, web-app harness, terminal/product harness, private organization, or private
  context leak into generic docs, examples, issue bodies, fixtures, tests, or
  observer screenshots.
- If an artifact might contain PII, PHI, credentials, or private operational
  context, summarize the shape and keep the raw artifact outside this repo.
- Future public usefulness beats private convenience. When in doubt, redact,
  synthesize, or stop and ask.

## Mission

- Build a reusable CLI and harness standard for self-driving product simulation.
- Keep reusable substrate in core packages and product truth in adapters.
- Make real product feedback loops cheap: run manifests, scenario profiles, actor traces, observer views, review packets, and proof artifacts.
- Preserve the lessons from source systems without copying product-specific cruft.

## Repo Layout

- Canonical checkout: `<workspace>/mimetic-cli-repo/mimetic-cli/`
- Sibling worktrees: `<workspace>/mimetic-cli-repo/worktrees/<worktree-name>/`
- Do not create feature worktrees under the repository root unless the layout is intentionally changed.
- Start coding-agent sessions from the exact checkout or worktree that should be edited.

Suggested worktree pattern:

```sh
git -C <workspace>/mimetic-cli-repo/mimetic-cli worktree add ../worktrees/<name> -b <branch>
```

## Architecture Principles

- Adapter-first, not config-sprawl: product-specific apps, ports, env allowlists, routes, scenarios, milestones, and review vocabulary belong in adapters.
- Core should own generic primitives: manifests, artifact layout, source packaging, actor orchestration, lifecycle events, observer rendering, run review, and history indexing.
- Do not let multi-app harness, web-app harness, or terminal/product harness nouns leak into core. Product nouns belong in fixtures, examples, migration notes, or adapters.
- CLI JSON envelopes must be truthful. Unsupported capabilities fail closed with structured errors.
- Proof artifacts are API surface. Treat paths, schemas, and review packets as durable contracts.
- Prefer fixtures and contract tests over prose claims.

## Development Rules

- Keep `main` clean and use sibling worktrees for feature work.
- Make small commits with explicit scope.
- Do not commit secrets, local env files, generated proof artifacts, or E2B/runtime caches.
- When cleanup is explicitly requested after a PR is confirmed merged, remove the whole trail: worktree, remote branch, and local branch. For squash merges, `git branch -D <branch>` is acceptable after verifying merge and clean local state.
- Before extracting from a source repo, identify which layer the code belongs to: core, CLI shell, observer, adapter contract, or example adapter.

## Acceptance Bar

- A change is not done until it has command-level proof.
- For harness changes, include tests or fixture artifacts that prove the contract.
- For adapter changes, prove at least one dry-run and one realistic run path where credentials allow it.
- End substantial work with: what changed, what was checked, and what remains uncertain.
