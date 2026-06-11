# Contract Schema Index

Date: 2026-06-02 (updated 2026-06-11)

Status: schema map aligned to the shipped v0.6.x surface. Rows marked
"reserved" name layering intent only — no code emits or validates them yet.
Do not emit a reserved schema.

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
| Lab | `mimetic.lab.v2` | `first-run` |
| Persona | `mimetic.persona.v1` | `synthetic-maintainer` |
| Scenario | `mimetic.scenario.v1` | `first-run-smoke` |
| Actor trace | `mimetic.actor-trace.v1` | `synthetic-actor-trace` |
| Substrate | reserved (never shipped) | none |
| Evidence stream | reserved (streams live inside the run bundle) | see [`run-bundle.md`](run-bundle.md) |
| Review | `mimetic.review.v1` | `contract-proof-review` |
| Verification | `mimetic.verify-result.v1` | `five-check-verify` |
| Policy | `mimetic.policy.v1` (fixture-only; not engine-validated) | `public-safety-policy` |
| Feedback | `mimetic.feedback.v1` | `public-safe-feedback` |

## Lab Manifest

Schema: `mimetic.lab.v2` (`src/lab-config.ts`). There is deliberately no v1
compatibility: v1 (`kind`, top-level `sims`) had zero real users and was
deleted when labs became config.

A lab is a composition over code primitives, not a hardcoded kind:

- `subject`: what the run acts on — `this-repo`, `clone` (owner/repo slugs,
  optional in-sandbox `serve` + env var names + `state`), or `app-url`
  (loopback unless `policies.allowPublicTargets` declares an owned deployment);
- `subject.state` (clone subjects, computer-use route): the subject's state
  story. `state.seed[]` declares ordered, bounded seed/migration/fixture steps
  (`{ name, command, when: before-build | before-start | after-ready,
  timeoutMs }`) executed in-sandbox around the serve sequence; `state.external[]`
  declares env var NAMES (each must also appear in `subject.env`) pointing at
  state the lab does not control, recorded as UNPINNED in provenance. Commands
  persist in evidence as sha256-16 digests only, never as text;
- `actors`: who drives it. On the computer-use and scripted-browser routes
  `actors[0].type` is a real dispatch key resolved against the actor registry;
  elsewhere it is a descriptive label (e.g. `synthetic-persona`).
  `actors[0].count` carries route-specific meanings: synthetic route lane
  count (simCount); scripted-browser route surface roster (1 = desktop,
  2 = desktop + mobile, default 1); computer-use routes must be 1 until
  fan-out lands;
- `execution`: where it runs — `local` or `e2b-desktop`, plus desktop
  device/resolution and timeouts. app-url subjects pair `e2b-desktop` with a
  computer-use actor, or `local` (or absent) with a scripted-browser actor;
- `scenario`: `mode: dry-run` (contract evidence, no spend) or `live`.
  `scenario.ref` is CONSUMED (and REQUIRED) on the scripted-browser route: it
  resolves a committed scenario (`mimetic/scenarios/<ref>.yaml` or a repo
  path) whose `browser.steps` ARE what the actor executes, digest-pinned into
  bundle provenance; on other routes `ref`/`inline` stay forward-declared
  warnings. On the scripted route `live` gates real browser ACTUATION against
  the declared app — provider spend stays $0 by mechanism (no model runs);
- `policies`: `redactRepos`, `redactScreenshots`, `allowPublicTargets`.
  The scripted-browser route is loopback-only and rejects
  `redactScreenshots: true` (blur unimplemented there) and
  `allowPublicTargets: true` fail-closed rather than ignoring them.

Lab backends report results in their own schemas (`mimetic.run-result.v1`,
`mimetic.oss-lab-result.v1`, `mimetic.oss-meta-lab-result.v1`,
`mimetic.cua-lab-result.v1`, `mimetic.scripted-lab-result.v1`); the evidence
record stays `mimetic.run-bundle.v1` in every case.

Manifests are human-authored `.yaml` source under `mimetic/labs/*.yaml` for
committed public-safe labs, or ignored `.mimetic/labs/*.yaml` /
`.mimetic/local/labs/*.yaml` for private local dogfood. Fields the engine does
not yet consume are accepted but reported as warnings (`mimetic lab inspect`
shows them), so a manifest never silently claims behavior that did not run.

Committed fixture (`mimetic/labs/first-run.yaml`):

```yaml
schema: mimetic.lab.v2
id: first-run
title: First-run synthetic Observer
description: Public-safe starter lab that generates a synthetic run bundle and Observer without provider spend.
subject:
  source: this-repo
actors:
  - type: synthetic-persona
    count: 4
scenario:
  mode: dry-run
defaults:
  open: true
```

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
- `subject` (optional, additive): structured subject provenance —
  `{ source: clone | app-url, repo?, commit?, envNames?, state }` where `state`
  is `{ provenance: seeded | unpinned | declared-not-run | undeclared,
  seed?: [{ name, when, commandDigest, ok?, exitCode?, timedOut?, durationMs? }],
  externalEnvNames? }`. Emitted by the computer-use backend; absent on
  pre-existing and other backends' bundles. `commandDigest` is the sha256-16 of
  the exact seed command — command text and env values never appear. Verified
  by the `subject state provenance` check in `mimetic verify`.

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

## Actor Trace

Actors execute or simulate the trial. Actor evidence is the provider-neutral
`mimetic.actor-trace.v1` (`src/actor-contract.ts`): Codex app-server items,
Claude Agent SDK blocks, pi events, computer-use cycles, and scripted browser
steps all map onto one `ActorTrace`. Registered actors live in
`src/actor-registry.ts` (`codex-app-server`, `pi-agent-core`,
`claude-agent-sdk`, `openai-computer-use`, `scripted-browser`). There is no
`mimetic.actor.v1`; that name never shipped.

Core-owned fields:

- `schema`
- `provider` / `providerVersion`
- `protocol` (`json-rpc` | `json-stream` | `in-process-sdk` | `cua-loop` |
  `scripted-steps`)
- `lane` (`code` | `app` | `computer-use` | `scripted-browser`)
- `persona` (`id`, `traitsApplied`, `promptDigest`)
- `redaction` (`status`, `screenshots: n/a|raw|blurred|ocr_scrubbed`, `notes`)
- `startedAt` / `completedAt` / `durationMs`
- `status` / `completionReason` / `reason` (`completionReason` includes
  `step_failed`: a deterministic scripted step/expectation evaluated false —
  the subject failed the script while the harness executed faithfully)
- `ids`, `counts`, `items[]`, optional `tokenUsage`, `capabilities`

Adapter-owned fields:

- the prompt, mission, persona text, and lane focus that produced the trace
- product-specific acceptance notes

Synthetic fixture (abridged; see `src/actor-contract.ts` for the full type):

```yaml
schema: mimetic.actor-trace.v1
provider: codex-app-server
protocol: json-rpc
lane: code
persona:
  id: synthetic-maintainer
  traitsApplied: []
  promptDigest: synthetic
redaction:
  status: passed
  screenshots: n/a
  notes: Synthetic fixture only.
startedAt: "2026-06-02T10:00:00.000Z"
completedAt: "2026-06-02T10:00:01.000Z"
durationMs: 1000
status: passed
completionReason: turn_completed
reason: Synthetic dry-run fixture completed.
ids: {}
counts: {}
items: []
```

## Substrate

Reserved: `mimetic.substrate.v1` is named here for layering intent but has
never shipped — no code emits or validates it. Substrate truth today lives
inside run bundles (per-stream transport and status) and lab execution config
(`execution.target: local | e2b-desktop`). Do not emit this schema.

## Evidence Streams

Reserved: `mimetic.evidence-stream.v1` has never shipped as a standalone
schema, and streams are not standalone artifacts. They are the `streams` array
inside `mimetic.run-bundle.v1`, normalizing UI, browser, terminal, TUI,
code-agent UI, artifact, and summary lanes — each with transport, terminal
tail, completion, meaningful-use verdicts, and artifact pointers. See
[`run-bundle.md`](run-bundle.md#completion-and-meaningful-use-verdicts) for
the stream shape, the meaningful-use rubric, and hard-failure rules.

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
- `warnings` (advisory postures, e.g. raw screenshots; never flip `ok`)
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
`mimetic.policy.v1` exists today only as an adapter fixture shape
(`adapters/fixtures/`); the engine does not validate it. The committed policy
source files scaffolded by `mimetic init` use `mimetic.redaction-policy.v1`,
`mimetic.network-policy.v1`, and `mimetic.credentials-policy.v1`.

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
