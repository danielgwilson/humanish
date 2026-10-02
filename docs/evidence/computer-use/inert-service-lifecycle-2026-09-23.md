# Inert service lifecycle: scoped Linux development proof

Date: 2026-09-23. Issue: [#816](https://github.com/danielgwilson/humanish/issues/816).

The finite systemd fixture passed 12 cases / 29 observations on a fresh
GitHub-hosted Ubuntu 24.04 VM. This tests actual process ownership, credential
dropping, lease expiry and failure cleanup using inert workers. It does not
install a broker, start Firecracker or qualify a Humanish study.

## Retained identities

- Accepted [CI run 35862234289](https://github.com/danielgwilson/humanish/actions/runs/35862234289),
  artifact `inert-service-proof`.
- Source branch commit: `5b7cbc4dfeaaaf366ae94a619823da68a6a47ea0`.
- Tested GitHub merge commit: `fb1bebf240b934a382672b28ecfc3634968e93a8`.
- Source manifest SHA-256: `03e5dd5e5c9e3211af3feb696ea0a71b94524651012da01a57ea7e395747c6e5`.
- Downloaded `run-matrix.json` SHA-256: `c0855ed8725c1c80ff496bf293ac5c921a20c7611620c292f229c84331782cf0`.
- Host: x86_64, kernel `6.17.0-1022-azure`, systemd
  `255.4-1ubuntu8.17`, Python `3.12.3`, real system PID1, cgroup v2,
  pidfds and CLOCK_BOOTTIME.

The retained packet binds ten executable source files and four CI/staging tools.
An independent reviewer downloaded the artifact separately, matched those hashes
to the reviewed source and checked 1,369 facts across every observation. Generated
artifacts are also retained outside committed source because CI retention is finite.

## Observed results

Each observation used a fresh A study, B study and separate canary. Phase-based
faults ran at 0, 1 and 4 seconds after readiness. B/canary baselines were sampled
after that delay, immediately before the fault; both counters advanced afterward.

| Case | Observed result |
| --- | --- |
| IS01–02: credentials and collision refusal | Root launch under SETUID/SETGID bounds, then nonroot UID/GID, empty supplementary groups and effective/permitted/inheritable/ambient capabilities, NNP, only standard descriptors and denied root regain. Static root identity refused before A registration. |
| IS03: leader exit | Known child remained alive and service active after held leader exit; explicit stop established positive absence. |
| IS04: supervisor finish/death | Normal exit and SIGKILL stopped dependent workers at all three phases; maximum measured observation latency 251 ms. |
| IS05: supervisor hang | SIGSTOP produced PID1 watchdog attribution and positive descendant absence; maximum 10,276 ms. |
| IS06: controller renewal loss | Relay kill, relay stop and silent open channel expired the independent 20-second lease at all phases; maximum 20,180 ms. |
| IS07: lease limits | Duplicate sequence never renewed the lease. Sustained valid renewals reached the absolute cap; observation ended after 59,948 ms with matching cap/deadline evidence. |
| IS08: TERM ignored | PID1 attributed the hard stop to timeout, with the five-second grace observed; complete observation 5,139 ms. |
| IS09: readiness failure | Delayed READY and startup failure retained 88 and 19 polls respectively; both requested workers remained inactive and were never observed running. |
| IS10–11: changed ownership | Stale owner refused a fresh invocation and left it alive. Replaced filesystem entry was refused while independent owned cleanup proceeded. |
| IS12: conductor death | Actual A conductor died; independent expiry stopped A within 20,209 ms. Cleanup-only recovery confirmed all three A services absent. |

Latencies include the case's observation/progress checks, not just signal delivery.
These are observed samples, not hard scheduling guarantees.

Cleanup retained a separate result for every sample and role: 167 acquired service
instances absent, zero unresolved resources, all 228 temporary unit files and 87
control sockets removed. Maximum per-case cleanup duration was 779 ms, within the
30-second bound. The temporary staging helper was removed. The root-private packet
and evidence were intentionally retained for that disposable host's lifetime.

The initial run, `35860440261`, passed its original assertions but was not accepted
as the final proof: it sampled canary counters before the phase delay and omitted
some decisive observations from exported evidence. Those gaps were corrected and
regression-tested before the fresh accepted run. Prior evidence remains retained.

## Checks and limits

The final fixture has 56 source tests and 26 CI-consumer tests, including independent
failure cases. The 54 broker tests pass. Full release checks passed 3,576 core and
86 TUI tests, with ten existing skips, and 51 documented commands. Normal CI on the
qualified source also passed, including Observer browser checks.

No package/account/network/device change, VM allocation, provider call or public
runtime selector is part of this fixture. It is outside npm packaging. Physical
Mac ownership, suspend/resume, loaded-host scheduling, jailer/device isolation,
KVM, guest boot, egress, installation and full participant studies remain separate
qualification gates. Missing paths alone never count as process absence. Hostile
administrators racing PID1 operations are outside this fixture's threat model.
