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
| Terminal cost ledger | `mimetic.terminal-cost-ledger.v1` | see Terminal Cost Ledger below |
| Terminal no-spend proof | `mimetic.terminal-no-spend-proof.v1` | see Terminal Cost Ledger below |
| Adapter score | `mimetic.adapter-score.v1` (additive `RunBundle.adapterScore`; namespaced) | see Product-Adapter Extension Seam below |

## Lab Manifest

Schema: `mimetic.lab.v2` (`src/lab-config.ts`). There is deliberately no v1
compatibility: v1 (`kind`, top-level `sims`) had zero real users and was
deleted when labs became config.

A lab is a composition over code primitives, not a hardcoded kind:

- `subject`: what the run acts on — `this-repo`, `clone` (owner/repo slugs,
  optional in-sandbox `serve` + env var names + `state`), `app-url`
  (loopback unless `policies.allowPublicTargets` declares an owned deployment),
  `local-app` (an already-running LOCAL dev server driven IN-PROCESS via a
  custom `CuaExecutor`, NO clone and NO E2B desktop — always loopback), or
  `terminal-product` (a CLI/product a real autonomous terminal agent studies
  from PUBLIC surfaces only — see below). A
  `local-app` subject pairs a computer-use actor with `execution.target: local`
  (or absent) and is library-assisted: the caller supplies
  `cuaHooks.buildExecutor` + `buildProvider`; with no hooks the engine fails
  closed (`MIMETIC_CUA_LAB_LOCAL_APP_NO_EXECUTOR`), never a desktop attempt. See
  [`docs/architecture/state-driven-executor.md`](../architecture/state-driven-executor.md);
- `subject.product` (terminal-product subjects): the product the agent studies.
  `product.name` is a public-safe token (committed fixtures use a NEUTRAL mock
  name); `product.publicSurfaces[]` is the list of http(s) URLs (docs, llms.txt,
  skill manifest) that are the ONLY world the agent sees — the lab does not
  clone/provision the product, so its provenance is recorded UNPINNED
  (invariant 5). `serve`/`clone`/`state`/`repos`/`appUrl` are rejected on a
  terminal-product subject (a field that cannot act on the route is a parse
  error, not silently dropped). See
  [`docs/architecture/terminal-product-lane.md`](../architecture/terminal-product-lane.md);
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
- `execution`: where it runs — `local`, `e2b-desktop`, or `e2b-terminal`, plus
  desktop device/resolution and timeouts. app-url subjects pair `e2b-desktop`
  with a computer-use actor, or `local` (or absent) with a scripted-browser
  actor; terminal-product subjects pair `e2b-terminal` (or absent → implied)
  with a registered terminal actor;
- `execution.terminal` + `execution.runtimeAuth` (terminal-product route):
  `terminal.transport` is `exec-stream` — captured NON-interactive exec output
  (stdin disabled); `pty` is rejected because labeling captured exec output as
  an interactive PTY would overstate the mechanism (invariant 6; a true duplex
  PTY transport is a deferred slice). `terminal.stdin` defaults to `disabled`
  (`sent`/assisted input is rejected until the interventions ledger + a
  non-comparable marker exist). `runtimeAuth: openai-env` declares the agent's
  runtime-auth channel — recorded as NAMES ONLY; the command-scoped injection
  (`keyPlacement: in-sandbox-command-scoped`) is enforced by the engine in a
  later slice;
- `scenario`: `mode: dry-run` (contract evidence, no spend) or `live`.
  `scenario.ref` is CONSUMED (and REQUIRED) on the scripted-browser route: it
  resolves a committed scenario (`mimetic/scenarios/<ref>.yaml` or a repo
  path) whose `browser.steps` ARE what the actor executes, digest-pinned into
  bundle provenance; on other routes `ref`/`inline` stay forward-declared
  warnings. On the scripted route `live` gates real browser ACTUATION against
  the declared app — provider spend stays $0 by mechanism (no model runs);
- `scenario.caps` (terminal-product route): `{ maxUsd, maxJobs, maxMinutes }`,
  all non-negative numbers (0 = no-spend, the default). The blast-radius budget
  that bounds the in-sandbox live key by MECHANISM, not by hope — the live key
  is never exercised without a fail-closed cap in force. `maxMinutes` is the
  wall-clock kill; `maxUsd`/`maxJobs` are enforced fail-closed against the cost
  ledger (a run whose KNOWN spend exceeds the cap fails closed,
  `MIMETIC_TERMINAL_LAB_CAPS_EXCEEDED`). The no-spend proof is derived from that
  real ledger, never asserted (see Terminal Cost Ledger And No-Spend Proof).
  Inert (warned) on every other route;
- `policies`: `redactRepos`, `redactScreenshots`, `allowPublicTargets`, and the
  terminal-product credential-boundary booleans `allowPrivateRepoAccess`,
  `allowProviderCredentials`, `allowPaymentCredentials`, `allowGitHubMutation`
  (all DEFAULT FALSE — deny-by-default; only the runtime LLM key enters, and
  only command-scoped). The scripted-browser route is loopback-only and rejects
  `redactScreenshots: true` (blur unimplemented there) and
  `allowPublicTargets: true` fail-closed rather than ignoring them.

Lab backends report results in their own schemas (`mimetic.run-result.v1`,
`mimetic.oss-lab-result.v1`, `mimetic.oss-meta-lab-result.v1`,
`mimetic.cua-lab-result.v1`, `mimetic.scripted-lab-result.v1`,
`mimetic.terminal-lab-result.v1`); the evidence record stays
`mimetic.run-bundle.v1` in every case.

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
Claude Agent SDK blocks, pi events, computer-use cycles, scripted browser
steps, and in-sandbox terminal-agent exec output all map onto one `ActorTrace`.
Registered actors live in
`src/actor-registry.ts` (`codex-app-server`, `pi-agent-core`,
`claude-agent-sdk`, `openai-computer-use`, `scripted-browser`, `codex-exec`).
There is no `mimetic.actor.v1`; that name never shipped.

Core-owned fields:

- `schema`
- `provider` / `providerVersion`
- `protocol` (`json-rpc` | `json-stream` | `in-process-sdk` | `cua-loop` |
  `scripted-steps` | `terminal-exec`)
- `lane` (`code` | `app` | `computer-use` | `scripted-browser` | `terminal`)
- `persona` (`id`, `traitsApplied`, `promptDigest`)
- `capabilities.keyPlacement` (`external` | `in-sandbox-command-scoped`): WHERE
  the actor's runtime key lives — registry metadata the engine enforces. The
  terminal agent declares `in-sandbox-command-scoped` (the agent-under-test runs
  inside the sandbox); every other actor is `external` (absent === external).
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

## Terminal Cost Ledger And No-Spend Proof

The terminal-product lane (`src/e2b-terminal-lab.ts`) places a real provider key
INSIDE the sandbox, so the no-spend claim must be REAL — derived from a ledger,
never asserted. The live run writes both to `terminal-ledgers.json` (a `cost`
block + a `noSpendProof` block, additive to `mimetic.terminal-ledgers.v1`).

The cost ledger (`mimetic.terminal-cost-ledger.v1`) has one line per category —
`product`, `media`, `payment`, `provider` — and follows a strict **null
discipline** that distinguishes three states and never conflates them:

- `usd: 0` — **known zero**: the category was metered and billed nothing.
- `usd: null` — **not measured**: no spend signal exists for the category this
  slice. `null` is written explicitly (never `undefined`-omitted, never guessed
  to `0`). A line with `null` says "this category exists but we did not measure
  it"; the no-spend proof reports it as unmeasured and does NOT claim it is zero.
- line **absent** — **not applicable** (n/a) to the lane/run.

`knownTotalUsd` sums ONLY the non-null lines (a `null` line contributes nothing
and is never coerced to `0`); `fullyMeasured` is true only when no line is null.
This slice meters only the `provider` line, populated from the actor trace's
`tokenUsage.costUsd` when present (else `null`); `product`/`media`/`payment` are
`null` until the SLICE-4 adapter supplies them.

```yaml
schema: mimetic.terminal-cost-ledger.v1
currency: usd
lines:
  product: { usd: null, count: null, source: unmeasured, note: "…no signal yet…" }
  media: { usd: null, count: null, source: unmeasured, note: "…no signal yet…" }
  payment: { usd: null, count: null, source: unmeasured, note: "…no signal yet…" }
  provider: { usd: null, source: unmeasured, note: "…no tokenUsage.costUsd this run…" }
knownTotalUsd: 0
fullyMeasured: false
```

The no-spend proof (`mimetic.terminal-no-spend-proof.v1`) is DERIVED from the
ledger. It vouches only for what it measured: `knownZeroLines` (proven zero),
`knownNonZeroLines` (break `satisfied`), and `unmeasuredLines` (the `null` lines
it explicitly CANNOT vouch for). `satisfied` is true only when every KNOWN line
is within `maxUsd` (for a no-spend run, `maxUsd: 0` ⇒ every known line is `0`);
unmeasured lines never make it satisfied. A proof never claims zero on a `null`
line — verification fails closed if it does.

```yaml
schema: mimetic.terminal-no-spend-proof.v1
maxUsd: 0
satisfied: true
knownZeroLines: []
knownNonZeroLines: []
unmeasuredLines: [product, media, payment, provider]
knownTotalUsd: 0
statement: "No-spend proof SATISFIED for maxUsd=0: every MEASURED spend line is zero…"
```

**Full caps enforcement (fail-closed, not advisory).** `scenario.caps.maxUsd`
is enforced against the ledger: if the observed KNOWN spend exceeds `maxUsd`, the
run fails closed (`MIMETIC_TERMINAL_LAB_CAPS_EXCEEDED`); `maxJobs` likewise when
a known job count is present; `maxMinutes` is the wall-clock kill (unchanged).
Unknowns (`null`) never trip a cap (we cannot claim a violation we did not
measure) and never grant a green pass (they surface as unmeasured). `verifyRun`
fails closed when a live bundle lacks the cost ledger or no-spend proof, when the
proof claims zero on a `null` line, or when known spend exceeds the declared cap.

## Product-Adapter Extension Seam

The terminal-product lane is proof-roadmap **layer 6**: an adopter (e.g. a
creative-CLI product) attaches product-specific scoring + feedback as a THIN
in-repo extension WITHOUT forking core. The seam is the EXPORTED contract types
plus a DI hook on `TerminalProductLabHooks` — never a built-in product scorer
(the adopter's scorecard lives in the adopter's repo).

Two product-agnostic carriers keep core's nouns closed while letting the adapter
record its own:

- **Adapter score** (`mimetic.adapter-score.v1`, additive `RunBundle.adapterScore`).
  A namespaced summary the adapter's `score` hook returns: `{ schema, namespace,
  status, score, summary, data? }`. Core never reads `data` — the adopter's
  component rubric rides there; `namespace` (an adopter slug) scopes the whole
  record so a future inert-field audit never misfires. The mission-based
  `review` verdict is UNCHANGED — the adapter score is additive, not a replacement.
- **Namespaced product-noun block** (`RunFeedbackCandidate.adapter`). The
  adapter's `deriveFeedback` hook returns feedback candidates that satisfy core's
  feedback-candidate shape; product-specific concepts (public CLI/product command
  observed, hosted product success-or-blocker, feedback id/draft, media/job/asset
  ids, explicit no-media/no-provider-spend proof, defection/friction risk) are
  recorded ONLY under `adapter: { namespace, data }` — never as core enums. Core
  validates the SHAPE (a non-empty `namespace` + a `data` record); the keys inside
  `data` are the adapter's.

```yaml
# RunBundle.adapterScore (namespaced; data is the adopter's, core never reads it)
schema: mimetic.adapter-score.v1
namespace: adopter-slug
status: pass
score: 88
summary: Product study scored by the adopter's own rubric.
data: { productRubric: { discovery: 1, firstImage: 1 }, hostedProductSucceeded: true }
```

```yaml
# RunFeedbackCandidate.adapter — product nouns stay NON-core under the namespace
adapter:
  namespace: adopter-slug
  data:
    publicCommandObserved: "product generate --prompt '…'"
    hostedProductOutcome: success
    feedbackId: null
    mediaJobIds: []
    noMediaSpendProof: { mediaUsd: null, providerUsd: 0 }
    defectionFrictionRisk: low
```

The `e2b-terminal` substrate is added to `RunFeedbackCandidate.substrate` so a
terminal-agent candidate names its substrate honestly. The lane invokes the hooks
over the FULLY-ASSEMBLED, redacted evidence (`TerminalProductScoringContext`:
`bundle`, `trace`, `ledgers`, `product`, `labId`, `runId` — all exported public
types), scrubs+redacts the returned payloads, and DROPS any malformed score or
candidate with a warning so a bad extension never poisons a verifiable bundle.
Default behavior (no hook) is unchanged. `verifyRun` re-checks the surviving
shapes fail-closed.

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
