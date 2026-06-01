# Self-Driving Harness Principles

Date: 2026-06-01

Status: initial repo doctrine for `mimetic-cli`.

## Thesis

`mimetic-cli` should be a closed-loop product simulation system, not just a
CLI that launches agents.

The operating loop is:

```text
persona scenario run
-> durable evidence bundle
-> review and verification
-> structured feedback
-> GitHub issue or project queue
-> scoped implementation
-> rerun and compare
```

The hard part is not getting an agent to do something. The hard part is making
the result verifiable, repeatable, safe to file, and useful to the next
agent with no chat context.

## Public Boundary

This repo must be designed as if it will become public.

No PII, PHI, secrets, keys, tokens, raw private transcripts, real patient data,
real customer data, or private product artifacts belong here. Examples,
fixtures, screenshots, personas, run bundles, issue bodies, and docs must be
synthetic or redacted.

## Principles

### 1. Model, Harness, Environment

Reliable agentic work is the composition of model, harness, and environment.
`mimetic-cli` owns the harness layer: replay, invariants, observability,
policy, artifacts, review, and feedback routing.

### 2. Verifiability Defines Throughput

Autonomy stalls when outcomes cannot be classified as red, yellow, or green.
Every claim a run makes should point to retrievable evidence: bundle files,
screenshots, terminal transcripts, state proofs, event streams, review packets,
or issue links.

### 3. Run Bundles Are Source Of Truth

The observer is a projection. The GitHub Project is a cockpit. The issue queue
is a work surface. The run bundle is the canonical evidence record.

### 4. Coverage Is The Product

Serious adapters need discovery maps and coverage matrices. Hidden
undercoverage is worse than visible gaps. A partial matrix with named gaps is
more useful than three green happy paths pretending to prove the whole product.

### 5. Product Trial Beats Tracker Truth

Tracker fields, issue comments, PR summaries, and author receipts are not
acceptance. A product claim needs a product trial or a precise explanation of
why the run is only contract proof.

### 6. Staged Autonomy Beats Binary Replacement

Authority should progress through stages:

```text
observe -> draft feedback -> draft issue -> draft spec -> draft PR -> steward PR -> release assist
```

Each stage requires stricter proof, narrower write scope, and clearer stop
conditions.

### 7. Idempotent Closed Loops Beat Heroic Retries

Every run and feedback issue-draft path needs idempotency keys, duplicate
prevention, explicit terminal states, cleanup proof, and safe re-run behavior.
Retries without loop closure create queue debt.

### 8. Feedback Is A First-Class Artifact

Friction found by a persona or agent should not be buried in prose. It should
be structured, evidence-linked, dedupable, public-safe, and reviewable. For an
open-source CLI, the default output should be an issue draft and filing
instructions, not live GitHub mutation.

### 9. Product Nouns Belong In Adapters

Core owns schema, lifecycle, actors, substrates, evidence streams, history,
review, verification, redaction, and feedback mechanics. Adapters own product
routes, personas, app topology, milestones, vocabulary, environment allowlists,
and product-specific proof.

### 10. Credential Boundaries Are Architecture

Executor auth, product auth, provider auth, spend policy, network policy, and
repo/GitHub authority are separate boundaries. A run must name what was
available and prove that sensitive values were not persisted.

### 11. Dry-Run Is Contract Proof

Dry-run proves scenario selection, bundle shape, review generation, and CLI
semantics. It does not prove product behavior. Review output must preserve that
distinction.

### 12. Green Requires Reviewer Acceptance

The builder of a harness is not the final judge of the harness. `review` can
summarize, `verify` can validate contracts, but acceptance requires a reviewer
or reviewer-like gate that checks coverage, evidence, and product relevance.

## Anti-Patterns

- Treating the best model as a substitute for harness quality.
- Using screenshots as vibes without state or transcript evidence.
- Letting product-specific nouns leak into generic core.
- Generating GitHub issue drafts from vague summaries without bundle links.
- Closing issues because a PR exists, not because product proof exists.
- Giving autonomous agents broad write authority before observe/draft stages
  are reliable.
- Letting project fields become canonical state.
- Retrying failed issue submission paths until duplicates appear.
- Storing private data in examples because it was convenient during extraction.
