# Browser-control conformance

Date: 2026-09-23. Scope: the internal finite browser-control client, dispatcher,
framing and executor error handling. This does not qualify a managed local
runtime, VM isolation, installation or autonomous participants.

Retained proof: `browser-control-proof/2026-09-23T09-41-39.461Z`, repeated after
the final transport fix as `browser-control-proof/2026-09-23T09-47-23.921Z`. The source
command is `pnpm build && pnpm browser-control:proof`. It used actual Chrome
149.0.7827.114 with its sandbox enabled, fresh temporary profiles, an owned child
controller and private socket. The production `runComputerUseLoop` used a
deterministic actor. An independent synthetic HTTP server counted Save requests.

| Case | Observed result |
| --- | --- |
| Normal sequence | Click, chord, type and Save changed the real page. The returned capture showed the entered note, Saved and one confirmed save. |
| Lost acknowledgment | The page saved once; its reply was deliberately lost. The loop stopped with `harness_error` and `outcome_uncertain`. A later action was refused and the independent count remained one. |
| Owner revocation during preparation | No browser input occurred and the save count remained zero. The client retained uncertainty because its request had already been sent; the independently observed zero does not retroactively manufacture an acknowledgment. |
| Loop cancellation during preparation | No browser input occurred and the count remained zero. The existing `harness_aborted` stop cause remained, with an explicit uncertain-action notice and no replay. |

All four controllers acknowledged browser closure and exited naturally with code
zero and no signal. Their owned socket/profile directories were then removed.
No unexpected page requests were observed by the interception hook; it does not
measure all browser-process network traffic. The failure cleanup path preserves
an unconfirmed private recovery directory rather than deleting an active profile
or claiming that a killed controller proves browser termination.

Protocol tests additionally cover strict validation before browser I/O, all action
kinds, fragmented/coalesced frames, bounded PNG decoding, stale/cross-session
responses, overlap, backpressure, lost replies and cancellation. Loop regressions
cover a deadline shorter than the transport deadline, typed refusals and closing
observations. Existing hosted retry behavior is preserved for executors that do
not select the internal fail-closed stall policy.

A parent fault check found that admitting an already-destroying stream could
leave its queued native error unhandled. The listener is now installed before
admission checks and removed after queued events. A separate Node subprocess
checks this without an uncaught-error handler and verifies listener cleanup.
The final protocol suite passed 85 tests independently; the final integrated
release gate passed 3,429 core and 86 TUI tests, build, startup/preflight proofs,
public scanning and package inspection. The four browser cases were rerun after
the fix, and their pixels/results were independently reviewed. CI also runs the
browser conformance command and retains its artifacts.

This proof does not exercise a study producer, prepared-desktop adapter, normal
local run bundle, Observer, independent lease watchdog, privileged broker,
vsock/network policy, model participant or Mac host. It is one control component
required by those later integrations.
