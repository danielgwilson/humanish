# Goal: the two-axis proof roadmap

Status: ratified 2026-06-10. This is the standing definition of "homun has succeeded,"
against which individual PRs carve their scope.

## The proof goal

> **Homun core is proven when (depth) each first-party bespoke simulation harness can be
> deleted in favor of homun core plus at most a thin, declared, in-repo extension — with
> decision-equivalent evidence — and (breadth) a stratified panel of foreign repositories
> goes from install to verified evidence with failures attributed, both gated by the same
> invariant set that extensions are certified against.**

Depth without breadth is an internal platform wearing an open-source coat. Breadth without
depth is a demo that cannot replace anything. Both axes are required; neither substitutes.

## Depth axis: the deletion-branch tests

Three first-party private products run bespoke sims today: a consumer web app, an
agent-facing skill product, and a multi-party clinical platform. Each is a forcing event:

- The bar is **decision-equivalence**, not feature parity: the same product decisions are
  supported by homun-produced evidence, on a branch where the bespoke sim is deleted and
  the product's own CI gate is green.
- The success metric is the **extension budget**: how thin is the in-repo extension (custom
  actor, provider, or scorer registered against homun's contracts) needed to close the
  gap? Zero is not the goal; small, honest, and declared is. The extension seam — how a
  consumer repo plugs code into the registries without forking core — is therefore a
  first-class deliverable, certified by the same conformance suite first-party actors pass.
- Replacement inherits the bespoke sims' *questions*, never their *flaws*. (Example: a
  bespoke sim that points lanes at an unpinned external database answers its question with
  unreproducible evidence; the homun replacement records `state: UNPINNED` and the
  consumer decides whether to keep that trade.)

Sequencing: consumer web app first (simplest; forces the subject provider), then the
agent-skill product (forces the extension-budget thesis: its harness-matrix and cost-ledger
needs should mostly live in ITS repo as a thin extension, proving the seam), then the
clinical platform (forces shared-world topology and the PII/PHI detection gate as a hard
prerequisite). Until a phase begins, its product is a design-review check ("would this
contract decision break that consumer's thin extension?"), not a build target.

## Breadth axis: the stratified panel

"Works on arbitrary repos" is proven by a recurring, autonomous panel — not by N:

- **Stratify, don't enumerate.** One repo per stratum that stresses a different default:
  SPA / SSR / CLI-only / API-only; needs-database / static; package managers; monorepo /
  flat; strong README / hostile README. A stratified N≈20 beats a random N=500.
- **Golden paths are executable, not judged.** Per stratum repo, a maintained script whose
  proof is a verified run bundle. Agents produce and maintain these; the success criterion
  is mechanical.
- **Attribution by triangulation, not oracle.** Panel failures attribute via diversity:
  multiple distinct agent harnesses attempt the same setup. One harness fails where others
  succeed → actor-owned. All fail where the golden script passes → discoverability-owned
  (the most valuable finding: possible but not findable). Golden script breaks → harness-
  or target-owned. This is the run bundle's existing `failure_owner` taxonomy, exercised.
- **The product of the panel is friction reports, not pass rates.** Agents power through
  friction humans bounce off; where an agent struggled, re-read, or retried is the signal.

The panel is also the proving ground for third-party extensions: an extension ships with a
lab config; the panel demonstrates it on stratum repos; the conformance suite certifies it
against the invariants. That is the ecosystem loop.

## Evidence classes

The honesty rule extended to the biggest overclaim risk in the category. What a run proves
depends on how much of the real user distribution the actor can sample:

| Class | When | What a bundle may claim |
|---|---|---|
| `user-census` | The users of the product ARE agents, and the lab runs real production harnesses | A genuine user study, modulo scenario realism |
| `plausible-use` | LLM personas proxy human users at moderate stakes | Plausible-use evidence; supports most product decisions |
| `coverage-floor` | LLM personas proxy high-stakes human users whose tails matter most | Robustness floor only — never "users will be fine" |

The class derives from what the actor is relative to the declared user population — not
from what the lab author wishes. Calibration against real behavioral traces (e.g. session
replay analytics) can measure and shrink the persona gap for `plausible-use` claims (a
fidelity score against a named real-traffic baseline), with two standing cautions: replays
sample surviving users, so calibrating toward them can overfit away from the tails — tail
coverage requires deliberately synthetic adversarial panels, scored and claimed separately;
and raw sessions are PII by definition — they never enter homun evidence; only aggregate
divergence findings do. Calibration is the LAST layer of the roadmap: it needs traces
flowing from real labs first.

## Layer order (each forces the next, none skips ahead)

Re-sequenced 2026-06-10 after a first-principles audit against the three mature in-house
bespoke sims (a consumer web app, an agent-facing skill product, a multi-party clinical
platform). The audit found two value-destroying constraints sitting OUTSIDE the ladder that
silently break every depth phase, and one prerequisite a rung too late. Blurred screenshots
cannot support a product *decision* (the literal success bar), and the agent-skill target's
harness cannot run loopback-only at all — so the de-paranoia work precedes the depth phases,
and a seed primitive joins layer 1. The middle (fan-out, scenario grammar, hybrid
scripted+LLM actor) is load-bearing, not optional/late as originally framed.

0. **De-paranoia** (`0.6.0`, done): redaction binds the publish boundary not capture
   (raw screenshots local by default, `policies.redactScreenshots` opt-in);
   `policies.allowPublicTargets` demotes the loopback wall; debug enablers (`clone.keep` on
   failure, configurable serve timeouts). Without it, no depth evidence is decision-grade.
1. **Subject provider** (`subject: clone` + serve + detached-run primitive + subject-env
   channel — done in 0.5.0) **+ a seed/migrate/fixtures primitive** (stateful apps boot empty
   without it) **+ register the existing scripted browser driver** (`run.ts` already has it —
   integration, not greenfield; gives hybrid scripted-auth + LLM-exploration so personas stop
   burning model turns on deterministic login).
2. **Fan-out**: bounded-concurrency N lanes from one prepared sandbox (the core sim capability;
   the reference sims default to 3-16 lanes). Genuinely unbuilt.
3. **Depth phase 1 — consumer-web-app target**: parity labs → dual-run comparison → deletion branch.
4. **Scenario grammar + scoring** (lift the existing `run.ts` step grammar): graded, repeatable
   proof instead of a freeform-mission vibes verdict.
5. **Snapshot reuse** (`reuse: snapshot`): memoized provisioning keyed by commit + source +
   env fingerprint; the cache key IS the provenance pin.
6. **Extension seam**: out-of-tree actor/provider/scorer registration + conformance
   certification. **Depth phase 2 — agent-skill target** proves it (cost-ledger + control-arm
   as a thin in-repo extension), adding in-sandbox command-scoped key placement with per-lane
   budgets/ledger.
7. **Multi-actor + multi-service subject + shared-world topology** + PII/PHI gate →
   **depth phase 3 — clinical-platform target** (the hardest; its defining capabilities).
8. **Breadth panel v1** (stratified repos, executable golden paths, triangulated attribution),
   then **evidence classes in schema**, then **calibration** as the asymptotic layer.
