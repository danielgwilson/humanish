# Public GitHub Feedback Loop Architecture

Date: 2026-06-01

Status: design note. No implementation exists yet.

## Goal

Make feedback a first-class CLI path that can safely turn persona simulation
evidence into a public-safe GitHub issue draft without requiring hosted
infrastructure or GitHub credentials.

Target loop:

```text
mimetic run
-> run bundle
-> mimetic review
-> mimetic verify
-> mimetic feedback draft
-> mimetic feedback issue
-> user files public GitHub issue
-> maintainer triage / project cockpit
-> scoped implementation when accepted
-> rerun
```

## Public And Privacy Boundary

The GitHub loop must assume repository contents, issue bodies, project fields,
and future examples may become public.

Never place PII, PHI, secrets, tokens, raw customer data, raw patient data,
private transcripts, private screenshots, private source snippets, or provider
payloads into GitHub. Feedback drafting must redact or block unsafe fields
before printing an issue body or issue URL.

## Command Shape

Likely v0 commands:

```bash
mimetic feedback list --run latest
mimetic feedback draft --run latest --json
mimetic feedback verify --run latest --json
mimetic feedback issue --run latest --repo owner/repo --format markdown
mimetic feedback issue-url --run latest --repo owner/repo
```

`issue` and `issue-url` should fail closed unless the draft contains:

- run id;
- adapter id;
- scenario id;
- persona id or persona class;
- actor runtime;
- substrate;
- failure owner;
- observed behavior;
- expected behavior;
- evidence pointers;
- redaction result;
- duplicate/idempotency key;
- proposed next state;
- acceptance proof.

The default public CLI should not create GitHub issues, update Projects, call
hosted queues, require tokens, or depend on private infrastructure. It should
produce a high-quality issue draft and clear filing instructions.

## Feedback States

| State | Meaning | GitHub action |
| --- | --- | --- |
| `watch` | Useful observation, not yet work | Keep as bundle-local feedback or low-priority issue |
| `needs_spec` | Real signal, scope unclear | Create issue with spec task |
| `spec_ready` | Docs/spec work can clarify it | Create issue with docs-only authority |
| `agent_ready` | Narrow enough for autonomous PR draft | Include readiness block for maintainers |
| `blocked` | Needs human/operator input | Create or update issue with blocker |
| `wontfix` | Accounted for and rejected | Keep in review packet; no issue by default |

## Issue Body Contract

Promoted feedback should use this stable body shape:

```yaml
mimetic_feedback:
  schema: mimetic.feedback.v1
  run_id: "<run-id>"
  adapter_id: "<adapter-id>"
  scenario_id: "<scenario-id>"
  persona_id: "<persona-id-or-class>"
  actor: "<actor-runtime>"
  substrate: "<substrate>"
  failure_owner: "product_ux|agent_runtime|executor_substrate|payment_provider|model_provider|harness|unknown"
  source_bundle: "<path-or-url>"
  evidence:
    - "<relative artifact pointer>"
  redaction:
    status: passed
    notes: "no sensitive data promoted"
  idempotency_key: "<stable-key>"
  proposed_next_state: "watch|needs_spec|spec_ready|agent_ready|blocked"
```

For maintainer/agent-ready work, the issue can also include:

```yaml
mimetic_swarm:
  schema: mimetic.swarm-readiness.v1
  status: needs_spec
  authority: draft_spec
  blocked_by: []
  can_parallel_with: []
  exclusive_files: []
  allowed_write_paths:
    - docs/**
  denied_write_paths:
    - .env*
    - .github/workflows/**
    - infra/**
  artifact_schema_version: mimetic.run-bundle.v1
  credential_manifest: []
  network_policy: no_network
  spend_policy: no_spend
  idempotency_key: "<issue-or-feedback-key>"
  proof_commands:
    - "<exact command>"
  telemetry_expectations:
    - "none for docs-only work"
  stop_conditions:
    - "required field missing"
    - "changed files outside allowed_write_paths"
    - "proof command fails"
```

The readiness block is authority, not decoration. Labels and Project fields may
mirror it, but they do not replace it.

## Labels

Initial label taxonomy:

| Label | Meaning |
| --- | --- |
| `product-feedback` | Persona/user friction captured as public-safe feedback |
| `agent-candidate` | May become autonomous work after spec/readiness |
| `needs-spec` | Requires scope or acceptance criteria before mutation |
| `agent-ready` | Has valid readiness block and narrow write scope |
| `proof-required` | Cannot close without run bundle or command proof |
| `harness` | Harness/core/observer/review work |
| `adapter` | Product adapter work |
| `feedback-loop` | Feedback, issue-draft, or queue plumbing |
| `privacy-boundary` | Public/PII/PHI/secret-safety concern |

## GitHub Projects

Projects are useful for maintainer operating visibility, not canonical truth.
The public CLI should not require Projects. Canonical state should live in:

- issue body YAML blocks;
- labels;
- issue comments;
- PR bodies;
- checks;
- run bundles and proof artifacts.

The first maintainer Project can track broad workstreams and status. It should
not be the only place a field such as authority, write scope, or proof command
exists.

## Issue Draft Rules

- Capture generously, execute rigorously.
- Vague feedback can become `watch`; it cannot become `agent_ready`.
- A GitHub issue may say `contributes to` broader goals, but should not say
  `closes` without product proof.
- The issue draft includes an idempotency key so maintainers can dedupe.
- Redaction failure blocks issue drafting.
- Missing evidence blocks issue drafting.
- Any PII/PHI/secret ambiguity blocks issue drafting.

## Optional Maintainer Tooling

Maintainers may later add repo-local tooling that reads a verified draft and
uses GitHub APIs to create or update issues. That tooling should be separate
from the default public CLI, dry-run first, token-explicit, and disabled unless
the maintainer asks for mutation.
