# Owned desktop sessions

Independent computer-use lanes, on hosted E2B desktops and local Firecracker
desktops, acquire an owned desktop allocation before subject setup, then bind its
executor after browser setup. The participant loop still consumes `CuaExecutor`;
provisioning commands stay in the desktop adapter. This internal interface is not
a public runtime plugin API.

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

`ParticipantDesktop` separates desktop preparation from the participant runner:

1. `prepare()` acquires and prepares the desktop. Failures still leave cleanup
   authority with the adapter.
2. The runner starts its model session and signals the existing hosted pipeline
   gate, preserving the current scheduling order.
3. `openSession()` measures initial browser geometry, starts the optional live
   stream, and supplies a `CuaExecutor` plus any participant inbox location.
4. The runner executes the participant loop and closes its model session.
5. `finalize()` collects final evidence and releases the desktop, including after
   preparation or participant failure. Repeated calls share one finalization.
6. `snapshot()` supplies the desktop facts for the existing lane outcome.

The E2B lane is composed in `src/routes/computer-use/e2b-desktop.ts`, with its
steps in the `e2b-desktop-*.ts` files beside it; acquisition and release are in
`src/substrates/e2b/sandbox.ts`. The local desktop is `createLocalParticipantDesktop` in
`src/routes/computer-use/local-vm.ts`, over
`src/substrates/local/firecracker-desktop.ts`. Browser launch is in
`src/substrates/e2b/desktop-browser.ts`, DevTools reads and mobile emulation in
`src/substrates/e2b/desktop-cdp.ts`, geometry in
`src/substrates/e2b/desktop-geometry.ts` and media in
`src/substrates/e2b/desktop-media.ts`. Subject provisioning lives in
`src/subject/` and reaches the sandbox only through a `Shell`
(`src/substrates/shell.ts`), which `e2bShell` (`src/substrates/e2b/shell.ts`)
builds from the sandbox handle. The adapter never imports the lab runner at
runtime.

The runner owns instructions, model execution, spend guards, screenshots, trace
persistence and participant outcome interpretation. It does not invoke desktop
shell commands or manufacture E2B objects for an alternate executor. A local
Firecracker study supplies its desktops through the `PARTICIPANT_DESKTOP` symbol on
the hook bag (`src/routes/computer-use/participant-desktop.ts`), which no caller
can set by name. The public `cuaHooks.createDesktopLane` is deprecated, warns once,
and goes in the next minor; contract tests still inject a desktop through it. Neither
bypasses CLI admission checks.

Final evidence errors cannot skip desktop release. Existing bundle fields and
desktop lifetime accounting retain their meanings; unconfirmed or retained
desktops do not become confirmed cleanup. Provider facts remain absent when the
adapter cannot establish them.

Independent hosted browser and terminal lanes, local Firecracker lanes, and
shared-world seats that use `runCuaParticipant` use this boundary. Local execution is
described in [local browser studies](local-browser-runtime.md).

The independent lane's `runSession` testing hook now receives a constructed
`executor` instead of `desktop`/`executorOptions`. A hook should consume the
normal `CuaActorSessionOptions` executor or delegate to `runCuaActorSession`.
Library calls directly using `runCuaActorSession({ desktop, executorOptions })`
still work but warn as deprecated; use `runComputerUseLoop`. A custom in-process
executor now goes through `RunLabOptions.inProcess`, which replaces the
deprecated `cuaHooks.buildExecutor`.
