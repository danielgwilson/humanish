# Contract Schema Index

Date: 2026-06-02

Status: v0 draft schema map for agent-ready contract work.

## Purpose

This document names the core Mimetic contracts before more implementation
lands. It is intentionally public-safe: examples use synthetic ids, local
relative artifact paths, env var names without values, and redacted evidence
notes.

Core contracts are reusable. Adapter contracts describe a target app, CLI, or
workflow without leaking private upstream truth into core.

## Ownership Rule

| Layer | Owns | Does not own |
| --- | --- | --- |
| Core | Schema versions, run ids, artifact layout, lifecycle events, actor/substrate status, evidence shape, review, verification, redaction, feedback mechanics, latest/history indexes. | Product routes, real customer data, private screenshots, private transcripts, credential values, target-specific acceptance language. |
| Adapter | Product routes, scenario/persona choices, app topology, env var names, network allowlists, coverage vocabulary, milestones, fixture data, target-specific proof expectations. | Generic run bundle schema, public-safety gates, provider secret values, raw private artifacts, GitHub mutation authority. |

## Contract Index

| Contract | Schema | Public-safe fixture |
| --- | --- | --- |
| Run bundle | `mimetic.run-bundle.v1` | `synthetic-run-bundle` |
| Adapter | `mimetic.adapter.v1` | `synthetic-cli-adapter` |
| Persona | `mimetic.persona.v1` | `synthetic-maintainer` |
| Scenario | `mimetic.scenario.v1` | `first-run-smoke` |
| Actor | `mimetic.actor.v1` | `synthetic-dry-run-actor` |
| Substrate | `mimetic.substrate.v1` | `local-filesystem-substrate` |
| Evidence stream | `mimetic.evidence-stream.v1` | `cli-stream-proof` |
| Review | `mimetic.review.v1` | `contract-proof-review` |
| Verification | `mimetic.verify-result.v1` | `five-check-verify` |
| Policy | `mimetic.policy.v1` | `public-safety-policy` |
| Feedback | `mimetic.feedback.v1` | `public-safe-feedback` |

## Run Bundle

Run bundles are the canonical evidence record. Observer data, review Markdown,
feedback drafts, and issue text are projections from the bundle.

Core-owned fields:

- `schema`
- `runId`
- `mode`
- `simCount`
- `createdAt`
- `artifactRoot`
- `source.git`
- `lifecycle`
- `simulations`
- `streams`
- `events`
- `redaction`
- `artifacts`
- `review`
- `feedbackCandidates`

Adapter-owned fields:

- `source.packageName`
- `source.mimeticSource`
- `persona`
- `scenario`
- target-specific stream labels and public-safe summaries

Synthetic fixture:

```yaml
schema: mimetic.run-bundle.v1
runId: synthetic-run-bundle-2026-06-02t10-00-00-000z-proof
mode: dry-run
simCount: 1
createdAt: "2026-06-02T10:00:00.000Z"
artifactRoot: .mimetic/runs/synthetic-run-bundle-2026-06-02t10-00-00-000z-proof
source:
  packageName: fixture-app
  mimeticSource: present
  git:
    schema: mimetic.git-state.v1
    status: clean
    capturedAt: "2026-06-02T10:00:00.000Z"
    head:
      shortSha: null
      refState: unknown
    changes:
      staged: 0
      unstaged: 0
      untracked: 0
      total: 0
    note: public-safe synthetic fixture
persona:
  id: synthetic-maintainer
  name: Synthetic Maintainer
  source: mimetic/personas/synthetic-maintainer.yaml
  sourceDigest: synthetic
scenario:
  id: first-run-smoke
  title: First-run smoke
  goal: Prove setup and verification without private data.
  source: mimetic/scenarios/first-run-smoke.yaml
  sourceDigest: synthetic
lifecycle:
  - at: "2026-06-02T10:00:00.000Z"
    event: run.created
    message: Created synthetic contract fixture.
redaction:
  status: passed
  notes: Synthetic fixture only.
artifacts:
  run: run.json
  reviewJson: review.json
  reviewMarkdown: review.md
  observerData: observer/observer-data.json
  events: events.ndjson
review:
  schema: mimetic.review.v1
  verdict: contract_proof_only
  summary: Synthetic contract fixture generated.
  gaps: []
feedbackCandidates: []
```

## Adapter

Adapters describe target-specific affordances without changing core contracts.

Core-owned fields:

- `schema`
- `id`
- normalized route/reference shape
- public-safety validation of adapter references

Adapter-owned fields:

- `name`
- `routes`
- route descriptions
- target-specific commands, paths, milestones, and vocabulary

Synthetic fixture:

```yaml
schema: mimetic.adapter.v1
id: synthetic-cli-adapter
name: Synthetic CLI Adapter
routes:
  - id: help
    path: synthetic-cli --help
    description: Public-safe command discovery.
  - id: dry-run
    path: synthetic-cli run --dry-run --json
    description: Generate a synthetic run bundle.
```

## Persona And Scenario

Personas and scenarios define trial intent. They are adapter-owned source
documents that core copies into run bundles by digest and id.

Core-owned fields:

- schema naming rules
- id/source/sourceDigest references inside run bundles
- redaction gates before persona/scenario text can appear in public feedback

Adapter-owned fields:

- persona traits
- scenario goals
- steps and expectations
- accessibility or workflow constraints

Synthetic fixture:

```yaml
persona:
  schema: mimetic.persona.v1
  id: synthetic-maintainer
  name: Synthetic Maintainer
  summary: Privacy-safe maintainer evaluating first-run clarity.
  constraints:
    - Do not use real personal data.
    - Treat credentials as env var names only.
scenario:
  schema: mimetic.scenario.v1
  id: first-run-smoke
  title: First-run smoke
  persona: synthetic-maintainer
  goal: Prove setup, dry-run evidence, verification, and feedback drafting.
  mode: dry-run
  steps:
    - name: Inspect help
      expectation: Help explains setup and verification commands.
    - name: Verify bundle
      expectation: Verification passes without private data.
```

## Actor

Actors execute or simulate the trial. Core records actor status; adapters
choose which actor fits the target and authority level.

Core-owned fields:

- `schema`
- `id`
- `kind`
- `status`
- `startedAt`
- `endedAt`
- `durationMs`
- `exitCode`
- `reason`
- redacted artifact pointers

Adapter-owned fields:

- actor prompt
- target command
- lane focus
- product-specific acceptance notes

Synthetic fixture:

```yaml
schema: mimetic.actor.v1
id: synthetic-dry-run-actor
kind: scripted
status: passed
startedAt: "2026-06-02T10:00:00.000Z"
endedAt: "2026-06-02T10:00:01.000Z"
durationMs: 1000
exitCode: 0
reason: Synthetic dry-run fixture completed.
artifacts:
  - path: actor.json
    kind: trace
    redaction: passed
```

## Substrate

Substrates are the execution environments that run actors or render evidence.

Core-owned fields:

- `schema`
- `kind`
- `status`
- lifecycle state
- safe capability names
- cleanup result

Adapter-owned fields:

- target start command
- allowed env var names
- allowed hosts
- viewport needs
- repo-specific setup commands

Synthetic fixture:

```yaml
schema: mimetic.substrate.v1
id: local-filesystem-substrate
kind: local-filesystem
status: ready
capabilities:
  - read committed source
  - write ignored run artifacts
cleanup:
  status: not_required
credentials:
  envNames: []
  valuesPersisted: false
```

## Evidence Streams

Evidence streams normalize UI, browser, terminal, TUI, code-agent UI, artifact,
and summary lanes for Observer and review.

Core-owned fields:

- `id`
- `simId`
- `kind`
- `status`
- `transport`
- `updatedAt`
- `completion`
- `artifacts`
- redacted terminal tail

Adapter-owned fields:

- stream label
- route or command name
- current step text
- public-safe summaries
- target-specific trace artifacts

Synthetic fixture:

```yaml
schema: mimetic.evidence-stream.v1
id: cli-stream-proof
simId: sim-01
kind: terminal
label: CLI proof
status: passed
transport: snapshot
updatedAt: "2026-06-02T10:00:01.000Z"
terminal:
  title: Synthetic terminal
  format: plain
  stdin: disabled
  tail: "synthetic-cli verify passed"
completion:
  checkedAt: "2026-06-02T10:00:01.000Z"
  exitCode: 0
  reason: Synthetic command passed.
  status: passed
artifacts:
  - label: review
    path: review.md
    kind: review
```

## Review

Review summarizes whether evidence supports the claim. It does not replace
verification or maintainer acceptance.

Core-owned fields:

- `schema`
- `verdict`
- `summary`
- `gaps`

Adapter-owned fields:

- vocabulary labels
- milestone names
- product-specific gap language

Synthetic fixture:

```yaml
schema: mimetic.review.v1
verdict: contract_proof_only
summary: Synthetic dry-run proves bundle shape, not product behavior.
gaps:
  - Live product behavior was not exercised.
```

## Verification

Verification checks bundles and evidence pointers. It fails closed when schema,
redaction, or artifacts are missing.

Core-owned fields:

- `schema`
- `ok`
- `run`
- `bundlePath`
- check names
- check booleans
- machine-readable error codes

Adapter-owned fields:

- optional target-specific checks
- acceptance proof commands
- coverage-specific check names

Synthetic fixture:

```yaml
schema: mimetic.verify-result.v1
ok: true
run: synthetic-run-bundle-2026-06-02t10-00-00-000z-proof
bundlePath: .mimetic/runs/synthetic-run-bundle-2026-06-02t10-00-00-000z-proof/run.json
checks:
  - name: run.json exists
    ok: true
    message: run.json present
  - name: redaction passed
    ok: true
    message: redaction status must be passed
```

## Policy

Policy names boundaries before an actor runs or feedback is promoted.

Core-owned fields:

- `schema`
- policy kind
- default action
- validation outcome
- redaction status
- no-secret-value persistence rules

Adapter-owned fields:

- allowed env var names
- allowed public hosts
- app-specific credential manifest
- network allowlist
- scenario-specific authority

Synthetic fixture:

```yaml
schema: mimetic.policy.v1
kind: public-safety
default: deny_sensitive_material
deny:
  - pii
  - phi
  - secrets
  - tokens
  - raw_private_transcripts
  - private_screenshots
allow:
  - synthetic_personas
  - synthetic_fixtures
  - env_var_names
credentialManifest:
  - envName: OPENAI_API_KEY
    valuePersisted: false
network:
  default: local_only
  allowedHosts:
    - localhost
```

## Feedback

Feedback turns verified evidence into public-safe issue draft material. The
default public CLI prints issue text or a prefilled URL; it does not mutate
GitHub.

Core-owned fields:

- `schema`
- run/source/evidence pointers
- redaction status
- idempotency key
- proposed next state
- failure owner enum
- public issue eligibility gates

Adapter-owned fields:

- adapter id
- scenario id
- persona id
- expected/actual language
- target-specific reproduction steps
- acceptance proof commands

Synthetic fixture:

```yaml
schema: mimetic.feedback.v1
run_id: synthetic-run-bundle-2026-06-02t10-00-00-000z-proof
adapter_id: synthetic-cli-adapter
scenario_id: first-run-smoke
persona_id: synthetic-maintainer
actor: synthetic-dry-run
substrate: local-filesystem
failure_owner: harness
summary: Synthetic user needed clearer verification instructions.
expected: Verification command is visible and public-safe.
actual: Dry-run review noted missing live behavior proof.
source_bundle: .mimetic/runs/synthetic-run-bundle-2026-06-02t10-00-00-000z-proof/run.json
evidence:
  - path: .mimetic/runs/synthetic-run-bundle-2026-06-02t10-00-00-000z-proof/review.md
    kind: review
    note: Public-safe synthetic review.
redaction:
  status: passed
  notes: Synthetic fixture only.
idempotency_key: synthetic-cli-adapter:first-run-smoke:verification-instructions
proposed_next_state: watch
acceptance_proof:
  - pnpm mimetic -- verify --run latest --json
```

## Contract Stop Conditions

Do not promote a contract fixture when:

- it needs private artifact data to make sense;
- it contains credential values instead of env var names;
- it embeds raw hosted stream URLs or auth-bearing links;
- it uses product-specific private nouns in a core-owned schema;
- it implies GitHub mutation without explicit maintainer authority;
- it cannot be proven with `git diff --check` and public-surface scanning.
