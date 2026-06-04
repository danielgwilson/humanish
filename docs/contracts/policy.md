# Policy Contract

Date: 2026-06-02

Status: v0 draft contract for credential, network, spend, redaction, and
assisted-run boundaries.

## Purpose

Policy defines what a run may access, what it may persist, and what it may
promote into public feedback. It keeps the public CLI useful without requiring
private infrastructure, maintainer GitHub credentials, provider account access,
or real product data.

Policy records env var names, capability classes, decisions, and redaction
status. It never records credential values.

## Boundary Principles

- Credential classes are separate; access to one class does not imply access to
  another.
- Dry-run and smoke proof should work with no provider spend.
- Network and provider spend require explicit opt-in.
- Public feedback requires redaction status `passed`.
- Assisted runs are useful evidence, but they are non-comparable to autonomous
  runs unless the assistance is modeled as an explicit actor event.
- Maintainer GitHub credentials are not required for the public CLI feedback
  path.

## Credential Classes

| Class | Examples | May Be Recorded | Must Not Be Recorded |
| --- | --- | --- | --- |
| Executor auth | local Codex login, local shell authority, E2B desktop token, browser automation session | class name, env var name, present/missing status, authority level | tokens, cookies, session ids, raw home config, private command history |
| Product auth | target app test account, synthetic browser state, local fixture login | synthetic fixture id, auth state class, redaction status | real emails, passwords, customer accounts, patient accounts, production cookies |
| Provider auth | model provider key, desktop provider key, package registry token | env var name, provider class, present/missing status, spend policy | API key values, auth-bearing stream URLs, billing account identifiers |
| Maintainer auth | GitHub token, npm publish authority, repository admin rights | required/not-required, requested authority, explicit maintainer approval status | tokens, OAuth payloads, private org metadata, mutation authority by implication |

Synthetic fixture:

```yaml
schema: mimetic.policy.v1
kind: credentials
credentials:
  executor:
    required: false
    envNames: []
    valuesPersisted: false
  product:
    required: false
    fixture: synthetic-login-state
    valuesPersisted: false
  provider:
    required: false
    envNames:
      - OPENAI_API_KEY
      - E2B_API_KEY
    availability: names_only
    valuesPersisted: false
  maintainer:
    required: false
    githubMutation: disabled
    valuesPersisted: false
```

## Network Policy

Network policy describes where a run may connect. It is not a hidden allowlist
for credentials.

| Mode | Meaning | Default For |
| --- | --- | --- |
| `no_network` | No external network calls. | contract docs, local unit tests |
| `local_only` | Localhost and loopback only. | Observer, local fixtures |
| `public_oss` | Public GitHub clone/fetch of owner/repo slugs only. | disposable OSS smoke |
| `authorized_private` | Token-backed clone/fetch of repos the maintainer is already authorized to access, with repo labels redacted by default. | local maintainer dogfood only |
| `provider_substrate` | Explicit provider substrate such as hosted desktop streams. | live OSS lab with keys |
| `custom_allowlist` | Adapter-declared public hosts. | target-specific adapters |

Synthetic fixture:

```yaml
schema: mimetic.policy.v1
kind: network
mode: public_oss
allowedHosts:
  - github.com
allowedRepoSlugs:
  - CorentinTh/it-tools
  - drawdb-io/drawdb
denied:
  - private remotes
  - SSH remotes
  - auth-bearing URLs
  - target repo mutation
```

Private maintainer dogfood must use `authorized_private` plus a redaction gate.
The repo name, screenshots, logs, source snippets, branch names, issue names,
and stream URLs remain local-only. Public receipts may include only redacted
labels, ignored artifact paths, and verifier status.

## Spend Policy

Spend policy names when provider costs may be incurred.

| Mode | Meaning |
| --- | --- |
| `no_spend` | No provider calls that can bill. |
| `dry_run_only` | Only local contract proof; no live substrate. |
| `explicit_live_provider` | Provider calls allowed because required env var names are present and operator intent is explicit. |
| `maintainer_approved` | Reserved for publish, billing, or high-risk mutation workflows. |

Synthetic fixture:

```yaml
schema: mimetic.policy.v1
kind: spend
mode: explicit_live_provider
providerClasses:
  - model
  - desktop_substrate
operatorIntent:
  command: mimetic lab run oss --json --no-open
  explicit: true
budget:
  limit: unspecified
  note: Operator-provided keys were present; values were not recorded.
```

## Redaction Policy

Redaction gates public output. A run may keep ignored local artifacts for
operator inspection, but public feedback cannot promote them unless the
redaction result is `passed`.

Required redaction gates:

- run bundle verification;
- Observer public-safety note;
- feedback draft creation;
- issue Markdown or issue URL rendering;
- PR or issue comments that summarize local live evidence.

Synthetic fixture:

```yaml
schema: mimetic.policy.v1
kind: redaction
status: passed
deny:
  - pii
  - phi
  - secrets
  - tokens
  - raw_private_transcripts
  - private_screenshots
  - auth-bearing URLs
allow:
  - synthetic_personas
  - synthetic_fixtures
  - env_var_names
  - local ignored artifact paths
promotion:
  publicFeedbackAllowed: true
```

If redaction is `failed` or `unknown`, the public CLI must fail closed and tell
the operator which class of material blocked promotion without printing the
material itself.

## GitHub Authority

The default public CLI does not need a GitHub token.

Allowed by default:

- render local feedback drafts;
- print public-safe issue Markdown;
- print prefilled issue URLs;
- include exact proof commands;
- include redacted local artifact pointers.

Not allowed by default:

- create issues through the GitHub API;
- update Projects;
- resolve review threads;
- merge PRs;
- publish packages;
- use maintainer tokens from the environment.

Maintainer automation can be built later as a separate, token-explicit,
dry-run-first tool. It must not be required for ordinary Mimetic feedback.

Synthetic fixture:

```yaml
schema: mimetic.policy.v1
kind: maintainer-authority
github:
  publicCliRequiresToken: false
  defaultAction: print_issue_draft
  apiMutation: disabled
  tokenValuePersisted: false
```

## Assisted Runs

An assisted run is any run where a human or outside tool performs work that the
declared actor could not perform autonomously inside the declared substrate.

Examples:

- human manually logs in to a target account;
- human edits the target repo during the run;
- human copies hidden browser state into a fixture;
- human clicks through product UI while the actor only observes;
- operator restarts a provider substrate lane and continues the same run;
- support staff or private upstream context resolves the blocker.

Assisted runs can produce useful observations, but they are non-comparable to
autonomous baselines. They must not be used as green regression proof unless the
assistance is explicitly modeled as an actor event and the review says what was
assisted.

Synthetic fixture:

```yaml
schema: mimetic.policy.v1
kind: run-comparability
assistance:
  status: assisted
  comparableToAutonomousBaseline: false
  reason: Human supplied setup that the actor could not perform.
review:
  verdictAllowed: blocked
  publicFeedbackAllowed: true
  notes: Assisted observation may become a spec issue, not a green proof.
```

## Policy Decision Envelope

Policy checks should produce small, public-safe decisions that can be copied
into run bundles, reviews, or feedback drafts.

```yaml
schema: mimetic.policy-decision.v1
ok: true
checkedAt: "2026-06-02T10:00:00.000Z"
policies:
  credentials:
    ok: true
    message: Required env var names are documented; values were not persisted.
  network:
    ok: true
    message: Public OSS clone mode only.
  spend:
    ok: true
    message: No provider spend in dry-run proof.
  redaction:
    ok: true
    message: Redaction passed before feedback promotion.
  comparability:
    ok: true
    message: Run is autonomous and comparable to dry-run baseline.
```

## Stop Conditions

Stop before public promotion when:

- a credential value appears in a prompt, artifact, issue, or PR body;
- a stream URL includes auth material;
- redaction is not `passed`;
- a run used human assistance but is being treated as autonomous proof;
- maintainer GitHub credentials would be required for the default public path;
- provider spend is implied but not explicit;
- network access exceeds the declared mode;
- a fixture requires real personal, customer, patient, or private source data.
