# Public GitHub Feedback Loop Architecture

This is a design note. The dry-run issue draft path ships; live GitHub mutation is out of scope.

## Goal

Make feedback a first-class CLI path that can safely turn persona simulation
evidence into a public-safe GitHub issue draft without requiring hosted
infrastructure or GitHub credentials.

Target loop:

```text
humanish run
-> run bundle
-> humanish review
-> humanish verify
-> humanish feedback draft
-> humanish feedback issue
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

There are five feedback commands. Each takes `--run` and `--cwd`. All but `list`
also take `--candidate`, or `--analysis` with `--finding`, to choose what to
draft:

```bash
humanish feedback list --run latest
humanish feedback draft --run latest --json
humanish feedback verify --run latest --json
humanish feedback issue --run latest --repo owner/repo --format markdown
humanish feedback issue-url --run latest --repo owner/repo
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

A draft's `proposed_next_state` is one of six values (`RunFeedbackCandidate` in
`src/run/bundle.ts`). Maintainer triage beyond it, such as spec or agent
readiness, uses the labels and the `humanish_swarm` block below.

- `watch`: the dry-run contract-proof draft; the observation is not work yet.
- `study-quality-review`: the live-run summary draft and every analysis-finding
  draft (`src/feedback/draft.ts`).
- `adapter-hardening`, `target-app-setup`, `actor-auth` and
  `setup-quality-review`: feedback candidates that an adapter adds to the
  bundle. `src/lab/adapter-extension.ts` checks the value.

## Issue Body Contract

Promoted feedback uses this body shape. [The feedback
contract](../contracts/feedback.md) has the full block, including its optional
fields:

```yaml
humanish_feedback:
  schema: humanish.feedback.v1
  run_id: "<run-id>"
  adapter_id: "<adapter-id>"
  scenario_id: "<scenario-id>"
  persona_id: "<persona-id-or-class>"
  actor: "<actor-runtime>"
  substrate: "<substrate>"
  failure_owner: "harness|target-app|actor|environment|unknown"
  source_candidate_id: "<candidate-id>" # only when drafted from a candidate
  source_bundle: "<path-or-url>"
  evidence:
    - path: "<relative artifact pointer>"
      kind: "screenshot|state|review|trace|log|filesystem"
      note: "<public-safe note>"
  redaction:
    status: passed
    notes: "no sensitive data promoted"
  idempotency_key: "<stable-key>"
  proposed_next_state: "watch|adapter-hardening|target-app-setup|actor-auth|setup-quality-review|study-quality-review"
  acceptance_proof:
    - "<command or artifact that would close this>"
```

For maintainer/agent-ready work, the issue can also include this block from the
agent-ready issue template (`.github/ISSUE_TEMPLATE/agent-ready-work.yml`):

```yaml
humanish_swarm:
  schema: humanish.swarm-readiness.v1
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
  artifact_schema_version: humanish.run-bundle.v1
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

Label taxonomy, from `.github/labels.yml`:

| Label              | Meaning                                                |
| ------------------ | ------------------------------------------------------ |
| `product-feedback` | Persona/user friction captured as public-safe feedback |
| `agent-candidate`  | May become autonomous work after spec/readiness        |
| `needs-spec`       | Requires scope or acceptance criteria before mutation  |
| `agent-ready`      | Has valid readiness block and narrow write scope       |
| `proof-required`   | Cannot close without run bundle or command proof       |
| `area:core`        | Core run, artifact, lifecycle and verification work    |
| `area:observer`    | Observer work                                          |
| `area:adapters`    | Product adapter work; `adapter:*` names the adapter    |
| `feedback-loop`    | Feedback, issue-draft, or queue plumbing               |
| `privacy-boundary` | Public/PII/PHI/secret-safety concern                   |

## GitHub Projects

Projects are useful for maintainer operating visibility. They do not hold the
feedback state. The public CLI should not require Projects. The state should live in:

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
- Vague feedback can become `watch`; it cannot get the `agent-ready` label.
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
