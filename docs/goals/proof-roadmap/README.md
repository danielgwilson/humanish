# Proof roadmap current status

Status date: 2026-07-14

The dated [`goal.md`](goal.md) packet is the immutable 2026-06-10 success
definition. Its ratification-time implementation labels are historical. This
file records current implementation truth without rewriting that packet.

## Current capability state

- Bounded per-lane-world fan-out shipped in `0.9.0` with deterministic and kept
  live proof. Seed-fork reuse from one prepared sandbox remains unbuilt.
- Sequential single-origin shared-world shipped in `0.10.0` with deterministic
  proof.
- Concurrent single-origin shared-world shipped and was live-proven in
  `0.10.1`; it has deterministic and kept live proof.
- Multi-origin shared-world has a ratified design direction, but no runtime or
  schema implementation. Its adopter-need and maintainer-review gate is closed.
- Public out-of-tree actor registration and conformance certification remain
  unbuilt.
- Cost tracking (ESTIMATED) shipped in `0.19.0`: a dated, operator-editable
  pricing table (`src/pricing.ts`), a per-lane + run-level cost ESTIMATE on the
  computer-use bundle (`humanish.run-cost-summary.v1` /
  `humanish.actor-estimated-cost.v1`, additive so `humanish.run-bundle.v1` stays
  v1), an `execution.caps.maxUsd` fail-closed abort for the CUA lane (default
  uncapped; an unpriced cap is refused at preflight), and Observer/library
  labeling ("estimated (rates as of `<date>`)", never a bare charge). Every
  dollar figure is an estimate; `verify` asserts its labeling, never its
  magnitude.

## Proof state

These are core capability proofs, not depth-axis completion:

- no first-party adopter has completed a decision-equivalent deletion branch;
- the stratified external panel remains unbuilt.

The definitions and sequencing standard in `goal.md` remain authoritative.
