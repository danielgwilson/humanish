# Owned desktop sessions

Independent hosted computer-use lanes acquire an owned desktop allocation before
subject setup, then bind its executor after browser setup. The participant loop
still consumes `CuaExecutor`; provisioning commands stay in the hosted adapter.
This internal interface is not a public runtime plugin API.

`desktop-session.ts` holds the lifecycle contract. The allocation captures a
resource ID and a release closure. Its ID is a record of acquisition, not
authority to reconstruct or reclaim a resource from an arbitrary saved bundle.

An allocation binds one participant executor. Closing it immediately rejects new
observations and actions, forwards no further calls, and shares one release
attempt across repeated or concurrent callers. Cancellation signals pass through
unchanged. Closing does not wait for an already-dispatched backend operation;
that operation may fail as the desktop stops.

Cleanup has three outcomes:

- `released`: the adapter confirmed termination or that the resource was already
  gone;
- `retained`: an existing debug-retention policy deliberately kept the desktop;
- `unconfirmed`: release was unavailable, failed, or returned an invalid result.

A closed allocation never implicitly retries cleanup or reopens input. Recovery
needs its own authorized operation. Runtime exceptions remain untrusted and must
pass the caller's existing redaction before entering warnings or artifacts.

The E2B adapter preserves the existing create options, template overload, startup
retry guard and kill-on-timeout policy. It captures the acquired ID and kill
method before provisioning hooks can mutate the SDK object. E2B's boolean kill
result confirms either termination (`true`) or prior absence (`false`, its 404
case). Other values do not confirm cleanup. Account-wide enumeration is never
part of release.

Already-absent cleanup carries a warning: the exact termination time is unknown.
As before, desktop cost is an estimate over the host's acquisition-to-cleanup
span, not a provider billing measurement.

The independent lane uses this allocation through setup, participant execution
and final evidence collection. Final evidence errors cannot skip desktop release.
Existing bundle fields and desktop lifetime accounting retain their meanings;
unconfirmed or retained desktops do not become confirmed cleanup.

This change supplies an internal boundary for future runtime adapters. Managed
local execution, artifact installation, controller-death leases, capability
admission and new media support require separate implementations and proofs.
Hosted shared-world and terminal routes retain their existing lifecycle code.

The independent lane's `runSession` testing hook now receives a constructed
`executor` instead of `desktop`/`executorOptions`. A hook should consume the
normal `CuaActorSessionOptions` executor or delegate to `runCuaActorSession`.
Library calls directly using `runCuaActorSession({ desktop, executorOptions })`
remain supported; the custom in-process `buildExecutor` route is unchanged.
