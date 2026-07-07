# Design (DESIGN-ONLY, HELD): multi-origin shared-world

Status: design sketch, 2026-06-18. **Not for implementation yet.** This documents the smallest
generic extension that would let one shared-world run span multiple app ORIGINS, and compares it to
a downstream reverse-proxy facade. The build is GATED on a single-origin shared-world live proof
first confirming the need (see "The gate"). Written generically — no adopter/product nouns.

## The question

Can homun support ONE shared simulation world where different lanes start from different app
ORIGINS, while preserving the SAME evidence, attribution, Observer, and replay guarantees as
single-origin shared-world (shipped 0.10.1)?

Motivating shape: a product split across several deployed app origins (e.g. three Next apps on
different ports) that all read/write ONE shared backend/DB. The eventual sim is "actor on app A
mutates state → actor on app B sees it → actor on app C observes" — cross-origin, one world.

## The load-bearing invariant

**The shared plane is the BACKEND/DB, not the app origin.** The origins are front-doors onto one
shared world. Everything that makes shared-world evidence honest today is about that shared backend:
- `stateSeries` = digest checkpoints over the ONE shared backend (the delta signal).
- `attributionClass: shared-world` + the verify-enforced `attributionLimits` + the
  concurrency-on-pass gate (real overlap + a backend delta).
- per-lane `laneWindows` (real-clock overlap) + per-lane `routeHostDigest` (which host a lane drove).

None of that changes for multi-origin. "Actor B saw a world actor A mutated" is the SAME shared-DB
causality whether A and B are on the same origin or different ones. So **multi-origin needs zero new
attribution doctrine** — only a per-lane ORIGIN dimension on top of the existing model.

## The contract (smallest additive extension)

Single-origin stays the default and byte-stable. Multi-origin is a strict SUPERSET:

```yaml
subject:
  topology: shared-world
  # Today (single origin) — unchanged, still valid:
  # serve: { start: ..., url: http://127.0.0.1:4102/ }
  #
  # New (multi origin): a named map of app front-doors onto ONE shared backend.
  apps:
    appA: { serve: { start: "...:4101", url: http://127.0.0.1:4101/ } }
    appB: { serve: { start: "...:4102", url: http://127.0.0.1:4102/ } }
    appC: { serve: { start: "...:4103", url: http://127.0.0.1:4103/ } }
  state:
    seed: [ ... ]        # the ONE shared backend is migrated + seeded ONCE
    checkpoint: [ ... ]  # digests the ONE shared backend (unchanged)
actors:
  - type: openai-computer-use
    lanes:
      - { id: lane-a, app: appA, entry: /portal,    persona: ... }
      - { id: lane-b, app: appB, entry: /dashboard, persona: ... }
      - { id: lane-c, app: appC, entry: /work,      persona: ... }
```

- `subject.apps` (new, optional) XOR `subject.serve` (existing). When `serve` is used, it's the
  single-origin case — unchanged. When `apps` is used, the subject provisions ONE backend (seeded
  once) and starts each app, `getHost`-exposing each.
- `lanes[].app` (new, optional) selects which app a lane drives; defaults to the sole app when there
  is exactly one (so existing single-origin labs keep parsing + behaving identically).
- `lanes[].entry` (existing) is the route within that lane's app.

## Provisioning (identical shape to single-origin)

One subject context: clone → migrate+seed the ONE backend once → start the N apps → `getHost`-expose
each. Single-origin provisions one app; multi-origin provisions N. This is exactly what an adopter's
multi-app runtime startup script already does. Each LANE is still its OWN actor desktop driving ONE
origin — there is **no cross-origin-in-one-browser** requirement; the sharing happens at the backend.
(That single fact is why the facade below is mostly unnecessary, and why core multi-origin is simple.)

## Evidence / provenance changes (small, additive)

The `homun.shared-world.v1` block gains:
- `apps`: a name → `hostDigest` map (sha256-16 of each app's getHost origin; raw host never persisted,
  exactly as the single-origin `plane.hostDigest` works today).
- each `laneWindow` carries its `app` name; `routeHostDigest` must match that app's recorded host
  (generalizes today's "all lanes drove the ONE plane host" → "each lane drove ITS declared app's
  host"; verify fails closed otherwise).
- one new honest `attributionLimit`: `cross-origin-shared-backend` — declares that what is shared is
  the BACKEND, not sessions/origins (so the bundle never implies a shared browser/session). The rest
  of the limit set is unchanged.
`stateSeries`, `attributionClass`, the concurrency-on-pass gate, the single-plane-backend-provenance
check: all unchanged (they're about the ONE backend).

## Observer

Label each lane with its `app`/origin (a per-lane badge). No structural Observer change beyond
surfacing the `app` already on each `laneWindow`.

## Backward compatibility (the corner check)

Multi-origin = the single-origin case with `apps` having one entry and `lanes[].app` defaulting. So:
- existing single-origin shared-world labs are byte-stable (no `apps`, no `lanes[].app`).
- a single-origin live proof done now needs **zero** changes when multi-origin lands.
**Therefore single-origin-first does NOT paint us into a corner** — the contract is a
strict additive superset. This is the answer to "are we cornering ourselves": no.

## The fork: downstream facade vs core multi-origin

| Path | Shape | Pro | Con |
|---|---|---|---|
| Downstream facade | one exposed origin, reverse-proxy `/appA`,`/appB`,`/appC` to each app | no homun core change; rides single-origin + `lanes[].entry` today | fights each Next app's per-origin assumptions (basePath, auth callback URLs, cookie scoping); distorts real deployment topology |
| Core multi-origin | homun supports N subject origins per shared world | faithful to real topology; native auth/cookies (each app on its real origin); each lane single-origin so no browser gymnastics; reusable for any multi-app adopter | a (small) core schema + provenance change |

**Lean: core multi-origin.** Because each lane is single-origin (sharing is at the backend), the
facade solves a problem the sim doesn't have while introducing real auth/cookie fragility. Core
multi-origin is both more faithful and structurally simpler. But this is a lean, not a commitment —
see the gate.

## Red flags this design must NOT trip (all avoided)

- "Just run N independent sims" — NO: that loses the shared-backend causality (the whole point). This
  design keeps ONE seeded backend + cross-origin state assertions.
- "One URL, let the adapter figure it out" — NO: loses per-lane origin provenance. This design records
  per-app `hostDigest` + per-lane `app`.
- "Build a generic multi-service orchestration platform" — NO: this is only multiple browser ENTRY
  origins into ONE prepared shared-backend world; nothing more.
- "Anything that weakens run-bundle evidence" — NO: the evidence model is preserved exactly; the only
  additions are app provenance + one honest limit.

## The gate (do NOT implement until this holds)

Implement multi-origin ONLY after a single-origin shared-world LIVE proof is green AND that proof
surfaces a concrete need for cross-origin interaction that the facade can't cleanly serve. Until then
this stays a design. The single-origin proof is corner-free (additive superset, above), so there is
no cost to proving it first.
