# OSS Lab POC

Date: 2026-06-01

Status: implemented as an experimental meta-lab command plus a retained smoke
harness.

## Decision

`mimetic lab oss` is the public-OSS meta-simulation loop.

The command should feel like `mimetic watch`: it opens the Observer and, for
human output, keeps the shell attached. Its top-level Observer is an
Observer-of-Observers: each lane represents a headed E2B desktop that will run
Codex TUI against a different lightweight public GitHub repository. Inside each
desktop, Codex should clone the repo, get it into local dev mode where feasible,
install and initialize Mimetic, author plausible public-safe personas/scenarios,
run a nested real Mimetic simulation, and leave that nested Observer visible in
the E2B browser.

The previous clone/discard proof loop remains useful, but it is now explicitly
named `mimetic lab oss-smoke`.

## Commands

Main operator path:

```bash
mimetic lab oss
mimetic lab oss --repos developit/mitt,lukeed/clsx,sindresorhus/is-plain-obj,ai/nanoid
mimetic lab oss --repo developit/mitt --repo lukeed/clsx --count 4
```

Agent/CI contract path:

```bash
mimetic lab oss --dry-run --json --no-open
```

Disposable clone smoke path:

```bash
mimetic lab oss-smoke
mimetic lab oss-smoke --limit 1 --keep
mimetic lab oss --smoke --limit 1 --keep
```

Local dogfood shortcuts:

```bash
pnpm mimetic:lab:oss
pnpm mimetic:lab:oss:ci
pnpm mimetic:lab:oss:smoke
```

## Repo Selection

The default public targets are intentionally small JavaScript packages:

- `developit/mitt`
- `lukeed/clsx`
- `sindresorhus/is-plain-obj`
- `ai/nanoid`

`--repos` accepts a comma-separated list. Repeated `--repo` is also supported.
If `--count` is larger than the repo list, assignments cycle through the repo
pool. Inputs must be public GitHub `owner/repo` slugs. Arbitrary URLs, local
paths, tokens, SSH remotes, and private GitHub references are rejected.

## Runtime Shape

The meta-lab writes ignored local Observer evidence:

```text
.mimetic/
  runs/<oss-meta-run-id>/
    run.json
    review.json
    review.md
    events.ndjson
    observer/
      index.html
      observer-data.json
```

Each stream lane records:

- assigned repo slug;
- headed desktop viewport contract;
- Codex TUI bootstrap prompt;
- current live-readiness state;
- public-safe gaps and events.

The current implementation renders the Observer contract and marks missing
live substrate truth in-lane. The E2B desktop launcher and Codex TUI injection
adapter are the next substrate slice behind the stable command and artifact
contract.

## Smoke Harness Runtime

`mimetic lab oss-smoke` shallow clones lightweight public GitHub repos into
ignored runtime state, applies Mimetic setup inside each throwaway clone, runs
the synthetic four-lane proof path, verifies the generated bundle, records
git-status evidence, writes an ignored report, and removes cloned repos by
default.

```text
.mimetic/
  lab/oss/<run-id>/
    report.json
    report.md
  tmp/oss-lab/<run-id>/
    repos...      # removed by default
```

Each cloned repo receives disposable uncommitted changes:

- `mimetic/` source starter files;
- `.mimetic/` runtime state;
- `.gitignore` updates;
- `package.json` script updates;
- synthetic run/Observer evidence under the clone's ignored `.mimetic/`.

The clone is removed unless `--keep` is passed. The host report remains under
ignored `.mimetic/lab/oss/<run-id>/`.

## Safety Rules

- Public GitHub `owner/repo` slugs only.
- No credential prompts; smoke clone calls set `GIT_TERMINAL_PROMPT=0`.
- No commits, pushes, branches, tags, GitHub API mutation, deploys, or issue
  filing.
- Do not write key values into committed `mimetic/` source.
- Do not emit PII, PHI, raw private transcripts, private screenshots, secrets,
  keys, or private source-system artifacts.

## What This Proves

The meta-lab proves the operator control surface and artifact contract for
watching multiple Codex/E2B OSS setup attempts at once. It also establishes the
public CLI shape before the live substrate is wired in.

The smoke harness proves first-run Mimetic package compatibility against
arbitrary public JavaScript repositories:

- setup can patch real package.json files without committing;
- generated `mimetic/` source can coexist with external repo layout;
- ignored `.mimetic/` runtime proof can be generated;
- the Observer can render from those disposable proofs;
- verification passes before the clone is discarded.

Neither path may claim private product behavior proof without live, redacted,
public-safe evidence.
