# GitHub Control Plane Setup

Date: 2026-06-01

Status: live GitHub setup performed for `danielgwilson/mimetic-cli`.

## Public Boundary

This repository is expected to become public. The GitHub control plane must not
contain PII, PHI, secrets, keys, tokens, raw private transcripts, private
screenshots, private customer data, private patient data, or private source
snippets.

The public `mimetic feedback` command should not require this Project, GitHub
tokens, hosted queues, databases, webhooks, Actions, or private infrastructure.
It should produce public-safe issue drafts and filing instructions by default.

## Live Project

Created user project:

- Title: `mimetic-cli`
- URL: `https://github.com/users/danielgwilson/projects/5`
- Linked repo: `danielgwilson/mimetic-cli`

Project readme states that canonical truth stays in issues, labels, PR bodies,
repo docs, run bundles, and proof artifacts. The Project is a maintainer
cockpit only.

Custom fields:

- `Coordination Status`: Inbox, Needs Spec, Ready, In Progress, In Review,
  Proof Pending, Blocked, Done, Parked
- `Workstream`: Doctrine, Contracts, Core, CLI, Observer, Actors,
  Substrate/E2B, Adapter: NoBG, Adapter: Image Skill, Adapter: Northstar,
  Feedback/GitHub, Docs/Release
- `Autonomy`: Human Review, Agent Candidate, Agent Spec, Agent PR,
  Agent Deploy Candidate
- `Authority`: observe, draft_spec, draft_pr_docs_harness,
  draft_pr_product_code, steward_pr, blocked
- `Proof Gate`: None, Unit, Contract Fixture, Dry-Run Artifact, Live E2B Proof,
  Observer Proof, Feedback Loop, Human Reviewed
- `Risk`: Low, Public Contract, GitHub Mutation, Provider Cost, Auth Security,
  Data Privacy, Deployment
- `Priority`: P0, P1, P2, P3, Parked
- `Owner Lane`: PO Watchtower, Core, CLI, Observer, Adapter,
  Runtime Substrate, Evaluator, Human
- `Proof URL`: text

## Live Labels

Added labels are checked in at `.github/labels.yml`. They cover:

- product feedback and proof requirements;
- privacy boundary;
- areas and adapters;
- authority levels;
- risk;
- proof gates;
- next actions.

## Seeded Issues

Created and added to the Project:

| Issue | Title | Priority | Workstream |
| --- | --- | --- | --- |
| #1 | public boundary: no PII, PHI, secrets, or private artifact leakage | P0 | Docs/Release |
| #2 | review packet 0: repo state, source-system context, and control-plane state | P0 | Doctrine |
| #3 | doctrine: self-driving harness principles and feedback-loop contract | P0 | Doctrine |
| #4 | contracts: define run bundle, adapter, actor, substrate, evidence, and review schemas | P0 | Contracts |
| #5 | feedback: specify public issue-draft CLI command | P0 | Feedback/GitHub |
| #6 | core: run IDs, artifact paths, git state, history, and lifecycle primitives | P1 | Core |
| #7 | cli: scaffold doctor, run --dry-run, review, verify, runs, and watch | P1 | CLI |
| #8 | adapter: NoBG-style dry-run contract parity for post-auth-return scenario | P1 | Adapter: NoBG |
| #9 | adapter: Image Skill-style terminal/product evidence fixture parity | P1 | Adapter: Image Skill |
| #10 | observer: static mission-control viewer over fixture bundle | P1 | Observer |
| #11 | policy: credential, network, spend, redaction, and assisted-run boundaries | P0 | Contracts |

Issue #5 was corrected after the open-source/public realization: it now targets
public issue drafting, not live GitHub issue creation by the default CLI.

## Important Course Correction

Image Skill's private-factory model includes hosted product memory, queues, and
explicit live GitHub mutation. `mimetic-cli` should not copy that default. The
right open-source default is:

```text
verified run bundle
-> public-safe feedback draft
-> markdown issue body or prefilled issue URL
-> user files issue
-> maintainer triage
```

Optional maintainer tooling can later consume the same schema to mutate GitHub,
but it should remain token-explicit, dry-run first, and separate from the public
CLI.
