# Feedback Contract

Date: 2026-06-01

Status: draft contract for future `mimetic feedback` commands.

## Purpose

Feedback is the bridge between simulation evidence and public issue filing.

`mimetic feedback` should let a persona simulation say:

```text
this user-like run found this concrete friction
here is the evidence
here is the likely owner
here is the redaction proof
here is the next state
```

It should not be an issue spammer, infra dependency, or generic comment
collector.

## Privacy Rule

Feedback payloads must be public-safe by default. They may not contain PII,
PHI, secrets, keys, tokens, raw private transcripts, private screenshots, raw
customer data, raw patient data, or private product source.

Public issue drafting fails closed if redaction cannot prove the payload is
safe.

## Command Stages

```bash
mimetic feedback list --run latest
mimetic feedback draft --run latest --json
mimetic feedback verify --run latest --json
mimetic feedback issue --run latest --repo owner/repo --format markdown
mimetic feedback issue-url --run latest --repo owner/repo
```

### `list`

Reads feedback candidates from the run bundle. Does not mutate.

### `draft`

Builds structured feedback from review output and raw evidence pointers. Writes
a draft under the run bundle, not GitHub.

### `verify`

Checks schema, evidence pointers, idempotency key, redaction result, and public
issue eligibility.

### `issue`

Prints or writes a public-safe GitHub issue body. It does not call the GitHub
API. The user files the issue in the public or eventually public repository.

### `issue-url`

Prints a prefilled GitHub issue URL when the platform supports one. It still
does not create the issue.

## Schema

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
  summary: "<public-safe concrete summary>"
  expected: "<public-safe expected behavior>"
  actual: "<public-safe observed behavior>"
  source_bundle: "<path-or-url>"
  evidence:
    - path: "<relative artifact pointer>"
      kind: "screenshot|terminal|browser|state|media|review|trace"
      note: "<public-safe note>"
  redaction:
    status: "passed|failed|not_applicable"
    notes: "<public-safe note>"
  idempotency_key: "<stable-key>"
  proposed_next_state: "watch|needs_spec|spec_ready|agent_ready|blocked|wontfix"
  acceptance_proof:
    - "<command or artifact that would close this>"
```

## Failure Owners

| Owner | Meaning |
| --- | --- |
| `product_ux` | The product confused, blocked, or failed the user/persona. |
| `agent_runtime` | The actor model/tool runtime failed independent of product UX. |
| `executor_substrate` | E2B, local browser, shell, filesystem, or network substrate failed. |
| `payment_provider` | Hosted payment/provider behavior blocked the run. |
| `model_provider` | Model/media provider behavior blocked the run. |
| `harness` | Mimetic or adapter logic produced invalid evidence or execution. |
| `unknown` | Evidence is useful but ownership is not yet clear. |

## Issue Draft Gates

Generating a public issue draft is blocked when:

- required schema fields are missing;
- source bundle is missing;
- evidence pointers are missing or invalid;
- redaction did not pass;
- any payload may contain PII, PHI, secrets, or private operational context;
- proposed next state is `agent_ready` without a readiness block;
- the feedback is a dry-run-only product claim;
- idempotency key is missing.

## GitHub Issue Semantics

GitHub issues filed from feedback should say `contributes to` unless the
acceptance proof closes the full product claim. The public issue should include
only redacted evidence pointers and reproduction instructions that a maintainer
can use without private local context.

The public CLI should not require GitHub tokens, hosted product memory, queues,
webhooks, Actions, databases, or Projects. Maintainers may later build separate
repo-local tooling that consumes the same issue schema, but that is outside the
default public feedback path.
