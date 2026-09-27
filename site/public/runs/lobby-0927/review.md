# Eight participants, one lobby, live on the real deployment

- run: concurrent-shared-world-2026-09-27T20-57-56-664Z-1e8c9646
- mode: live
- attribution class: shared-world
- topology: shared-world / concurrent
- personas: 8
- verdict: fail
- summary: Concurrent shared-world (ONE external-public plane, 8 simultaneous personas): swarm did not run coherently; 6/8 actor session(s) passed credibility checks; mission endpoint: 6/8 ended goal_satisfied; completion reasons: goal_satisfied 8/8; overlap proven; 8 seats converged on one lobby.
- plane: Shared plane: an EXTERNAL-PUBLIC deployment (operator-attested owner danielgwilson, authorized) used DIRECTLY as the shared plane — NO getHost, clone, subject sandbox, or seed. The harness OBSERVES that each seat reached the operator-declared origin (publicOriginDigest); it did NOT mint or control the plane. Author-trust ownership attestation, NOT a synthetic-data claim.
- concurrency: Concurrency: 8 lane(s), up to 8 live at once (cap 8), overlap PROVEN; stateSeries omitted (no authoritative shared-state proof on the external-public plane); lobby convergence PROVEN (all seats reached one /lobby/CODE). Attribution ceiling: concurrent, best-effort-causal-attribution, non-deterministic-shared-state, window-and-snapshot-granularity, contention-observed-not-proven-safe, state-change-not-isolated-to-actors, external-public-plane, operator-attested-target-not-harness-controlled, no-synthetic-attestation, no-authoritative-shared-state-proof, concurrency-by-temporal-co-occupancy-only. This run reports only its own observed overlap and state changes; it does not prove scale, repeatability, or adopter-harness replacement.
- attribution limits: concurrent, best-effort-causal-attribution, non-deterministic-shared-state, window-and-snapshot-granularity, contention-observed-not-proven-safe, state-change-not-isolated-to-actors, external-public-plane, operator-attested-target-not-harness-controlled, no-synthetic-attestation, no-authoritative-shared-state-proof, concurrency-by-temporal-co-occupancy-only

## Gaps
- player-six: BLOCKED.
I used the keyboard-accessible Join flow, entered synthetic display name “Rook” and lobby code [REDACTED_LOBBY_CODE], then retried repeatedly for several minutes. The site consistently reported: “Game in progress. You can join when this game ends.”

I could not enter the waiting room or play any rounds. The recovery path was unclear: there was no automatic queue, status refresh, or indication of when joining would become available. I initially hesitated over the form’s unexpected focus order, corrected the swapped fields, and confirmed the Join button was keyboard accessible.
- player-eight: BLOCKED.
Joined lobby [REDACTED_LOBBY_CODE] as CipherFox72 and remained through rounds 1–2; round 3/5 was active. Keyboard focus repeatedly stayed in Chrome’s toolbar or opened unrelated browser controls instead of reaching “Guess the film.” The game provided no visible focus state or reliable keyboard path to submit guesses, and mouse-only interaction violates the navigation constraint. I hesitated around the ambiguous focus order and stopped after repeated failed recovery attempts.
