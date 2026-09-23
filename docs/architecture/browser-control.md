# Internal browser control

The browser-control client implements the existing `CuaExecutor` over an
already-owned Node `Duplex`. The matching dispatcher invokes an owner-supplied
executor. This is a preparatory internal boundary, not a managed-local runtime,
CLI mode, browser launcher, VM isolation claim, or installer.

## Ownership and admission

`createBrowserControlClient({ transport, identity, requestTimeoutMs? })` returns
`{ executor, ready(), close() }`. `ready()` performs a lazy handshake; the first
observation/action also performs it when needed. The owner closes the client
when its session ends. The client never discovers endpoints, opens sockets,
spawns processes, reconnects, retries, or replays a mutation.

`attachBrowserControlDispatcher({ transport, identity, executor, isAuthorized,
authoritySignal })` returns `{ close() }`. The authority signal is required.
The owner establishes the channel and authority independently; the identity's
`generation`, `challenge`, and `runtimeRevision` only check consistency.
Each is a bounded ASCII token. A matching string does not prove a lease or
authenticate executable bytes.

The dispatcher checks current authorization immediately before invoking browser
I/O. It passes a signal combining owner revocation, channel loss, and its request
deadline to `execute`. The physical driver must check that signal immediately
before **each actual input**, including after asynchronous preparation. Closing
the channel cannot roll back already-dispatched input or prove the browser has
stopped. The physical owner remains responsible for resource cleanup and the
independent watchdog. Observation has no cancellation parameter in the existing
executor interface; late observations are discarded after closure.

One operation may be pending, including handshake and observation. Concurrent
calls are rejected rather than queued. The client marks its executor with
`stallRecovery: 'fail_closed'`, so an earlier computer-use loop deadline cannot
trigger the legacy observation retry or idle-action skip behavior.

## Wire contract

Each frame is a four-byte unsigned big-endian length followed by strict UTF-8
JSON. The parser allocates its bounded payload only after validating the length;
it handles fragmented and coalesced input without repeatedly concatenating it.
A partially received frame has a nonrenewing 35-second assembly deadline.

Version 1 has only `HELLO`, `OBSERVE`, and `EXECUTE`. Both directions carry the
version, operation, identity, strictly increasing sequence and `request-N`
correlation ID. Execute additionally carries the distinct `action-N` ID.
Unknown fields, methods, versions, stale identity, duplicates, missing or wrong
correlation, malformed UTF-8/JSON and oversized frames close admission. There is
no generic CDP, command, file, navigation-management, or runtime-management method.
Initial target navigation remains an adapter-owned operation.

Replies acknowledge completion or contain a finite `CuaExecutorError` code and
`not_dispatched` / `outcome_uncertain` disposition. They never include raw
exception prose, typed text, page URLs, or browser errors in their error fields.
A generic driver exception after invocation is uncertain; only a genuine typed
driver declaration can attest that input was never dispatched.

The client resolves execute only after a matching completion acknowledgement and
its write callback. Cancellation, deadline, explicit close, or channel loss after
a possible write is uncertain and terminal. A later acknowledgement cannot reopen
that channel. Pre-aborted signals and locally rejected input cause no write.
Cancellation during the preliminary handshake remains a pre-dispatch action
failure. No exactly-once or rollback guarantee is implied by sequence IDs.

## Finite bounds

| Input | Version 1 bound |
| --- | --- |
| Framed JSON | 12 MiB |
| PNG bytes | 8 MiB |
| Image dimensions | 4096 per side, at most 16,000,000 pixels |
| Typed text and each observed string | 64 KiB UTF-8 |
| Key chord | 16 keys, 64 characters per key |
| Drag | 1–1024 points |
| Coordinates, deltas, scroll position | Finite, within ±1,000,000; fractions preserved |
| Wait | 0–30 seconds, fractions preserved |
| Client request | 35 seconds by default; caller may choose 1–60 seconds |
| Dispatcher request | 35 seconds including acknowledgement write |

Observation requires a PNG and state signature. It may include bounded URL,
title, text, and fractional scroll position; those remain runtime-only under the
existing loop contract. Arbitrary `appState` is refused because v1 has no closed
schema for it. The protocol does not truncate strings, round coordinates, or
silently drop unsupported state.

PNG admission checks signature, IHDR before decoder allocation, chunk framing,
IDAT/IEND presence, no trailing bytes, CRCs and full decode. Version 1 admits
8-bit, noninterlaced browser PNGs. Interlaced and 16-bit images are rejected:
the current decoder has an unbounded interlaced inflation branch, so admitting
those would require a separately bounded decoder. Image dimensions and the
pixel product are checked before decoding, independently of compressed size.

## Verification boundary

`tests/browser-control-protocol.test.ts`, `browser-control-transport.test.ts`
and `browser-control-client.test.ts` exercise production schemas and framing,
all action kinds, image limits, correlation, malformed input, revocation,
concurrency, lost acknowledgements, backpressure and cancellation. These use
synthetic PNGs and inert paired byte streams, with no network, model or VM calls.
They establish the protocol contract, not a real-browser or managed-runtime
claim. The separate owned-child/browser conformance proof must retain real
pixels and independently observed fixture mutations through the same modules.

From a source checkout, run `pnpm build && pnpm browser-control:proof` with a
Chromium installation that supports its sandbox. The proof uses a fresh profile,
a private local socket, a separate controller process and a synthetic loopback
page. It checks a normal save, a lost acknowledgement after one save, and owner
revocation/cancellation during input preparation. Screenshots, loop traces,
independent save counts and exact child/profile cleanup results are retained in
`.humanish/browser-control-proof/`. Failed cleanup remains unconfirmed and keeps
the private recovery directory; killing a controller alone does not prove its
browser stopped.

This is deterministic `runComputerUseLoop` conformance, not model perception,
the study producer, a ready-desktop adapter, a durable local-study bundle or
Observer qualification. Page request interception does not establish process-wide
egress isolation. Those integration and runtime boundaries remain separate gates.
