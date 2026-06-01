# Self-Driving Feedback Ramp

Date: 2026-06-01

Purpose: capture the ramp from self-driving codebase and harness-engineering
doctrine into the first `mimetic-cli` GitHub feedback-loop plan.

## Sources Read

- Repo-local `AGENTS.md`.
- `docs/ramp/2026-05-31-sim-systems-context-dump.md`.
- Daniel evergreen notes:
  - `model-harness-environment.md`;
  - `verifiability-defines-throughput.md`;
  - `staged-autonomy-over-binary-replacement.md`;
  - `idempotent-closed-loops-over-heroic-retries.md`.
- Daniel harness-engineering references:
  - doctrine;
  - architecture;
  - product-owner watchtower;
  - reviewer contract.
- Image Skill first-hand docs on self-driving loops, swarm readiness, feedback,
  and GitHub queue promotion from current `origin/main`, used as a contrast
  point for what an open-source default should not require.

## Findings

The most reusable Image Skill idea is not any one implementation file. It is
the loop:

```text
usage / dogfood / telemetry / alerts / direct feedback
-> product signal
-> triage
-> spec
-> scoped PR
-> CI + dogfood + review
-> release / monitor
```

For `mimetic-cli`, persona simulations become the front of that loop. The tool
should not stop at "agent completed scenario." It should produce evidence that
can become structured feedback, and feedback that can become a public-safe
GitHub issue draft when its provenance and redaction are strong enough.

Important divergence from Image Skill: because `mimetic-cli` is intended to be
open source, the default public CLI should not need hosted product memory,
databases, private queue workers, GitHub tokens, or Project mutation. The CLI
should generate high-quality issue bodies and filing instructions. Maintainers
can add separate optional tooling later if direct GitHub mutation becomes useful.

## Design Decisions Captured

- Add a prominent future-public boundary to `AGENTS.md`.
- Treat `mimetic feedback` as a first-class future command family.
- Treat GitHub Issues as canonical queue records and GitHub Projects as a
  cockpit over those records.
- Use issue-body YAML blocks for machine-readable feedback and autonomous
  readiness.
- Require redaction before public issue drafting.
- Keep dry-run, review, verify, and feedback semantics separate.
- Keep product nouns and private source-system context out of core docs and
  issue bodies.

## Initial GitHub Queue Shape

The first repo queue should be small and architecture-led:

1. Public boundary and redaction contract.
2. Run bundle contract.
3. Adapter and persona/scenario contracts.
4. Feedback command contract.
5. GitHub issue-draft and maintainer-triage contract.
6. Observer and mission-control contract.
7. First NoBG adapter proof.
8. First Image Skill-style agent-study adapter proof.

Each issue should state whether it is research-only, needs spec, or agent-ready.
No issue should authorize autonomous mutation until it has a narrow write scope,
proof commands, redaction expectations, and stop conditions.
