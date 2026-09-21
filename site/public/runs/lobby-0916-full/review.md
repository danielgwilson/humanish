# Three personas, one lobby — live multiplayer on the real deployment

- run: concurrent-shared-world-2026-09-16T17-18-01-966Z-36a121d7
- mode: live
- attribution class: shared-world
- topology: shared-world / concurrent
- personas: 3
- verdict: pass
- summary: Concurrent shared-world (ONE external-public plane, 3 simultaneous personas): swarm ran coherently; 3/3 actor session(s) passed credibility checks; mission endpoint: 3/3 ended goal_satisfied; completion reasons: goal_satisfied 3/3; overlap proven; 3 seats converged on one lobby.
- plane: Shared plane: an EXTERNAL-PUBLIC deployment (operator-attested owner danielgwilson, authorized) used DIRECTLY as the shared plane — NO getHost, clone, subject sandbox, or seed. The harness OBSERVES that each seat reached the operator-declared origin (publicOriginDigest); it did NOT mint or control the plane. Author-trust ownership attestation, NOT a synthetic-data claim.
- concurrency: Concurrency: 3 lane(s), up to 3 live at once (cap 3), overlap PROVEN; stateSeries omitted (no authoritative shared-state proof on the external-public plane); lobby convergence PROVEN (all seats reached one /lobby/CODE). Attribution ceiling: concurrent, best-effort-causal-attribution, non-deterministic-shared-state, window-and-snapshot-granularity, contention-observed-not-proven-safe, state-change-not-isolated-to-actors, external-public-plane, operator-attested-target-not-harness-controlled, no-synthetic-attestation, no-authoritative-shared-state-proof, concurrency-by-temporal-co-occupancy-only. This run reports only its own observed overlap and state changes; it does not prove scale, repeatability, or adopter-harness replacement.
- attribution limits: concurrent, best-effort-causal-attribution, non-deterministic-shared-state, window-and-snapshot-granularity, contention-observed-not-proven-safe, state-change-not-isolated-to-actors, external-public-plane, operator-attested-target-not-harness-controlled, no-synthetic-attestation, no-authoritative-shared-state-proof, concurrency-by-temporal-co-occupancy-only
