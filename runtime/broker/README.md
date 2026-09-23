# Broker protocol and lease core

This Python 3.12 standard-library code validates requests and models lease and
allocation authority. It does not install a service, open sockets, import files,
launch VMs, or inspect or stop processes. Passing these tests does not qualify a
privileged lifecycle or make a local runtime available.

From the repository root:

```sh
python3 -B -m unittest discover -s runtime/broker/tests -p '*_test.py' -v
```

## Request boundary

`BrokerCore.handle(data, peer_uid=uid, clock=sample)` accepts one complete request
as bytes. The future transport must acquire the peer UID from the OS and pass it
separately. A numeric UID is insufficient by itself: `Policy.authorized_uids`
defaults to an empty immutable allowlist. Unauthorized UIDs are refused before
decoding, clock changes, capability generation, or reservation changes.

Every request has integer `version: 1` and an `operation` from this table.
Exactly the listed additional fields are required; all other fields are refused.

| Operation | Additional fields |
| --- | --- |
| `hello` | None |
| `acquire` | `attempt` |
| `allocate` | `study`, `capability`, `attempt` |
| `renew` | `study`, `capability`, `sequence` |
| `release` | `study`, `capability` |
| `inspect` | `study`, `capability` |

IDs and attempt keys are exactly 32 lowercase hexadecimal characters. A
capability is exactly 64 lowercase hexadecimal characters encoding 256 random
bits. Renewal sequences are integers from 1 through 2⁵³−1; each accepted sequence
must exceed the previous one. Booleans are not integers. Requests are flat JSON
objects, at most 16 KiB, with strict UTF-8 and no duplicate keys, nested objects,
arrays, floats, nonfinite numbers, trailing data, or coercions. No wire field
selects a UID, path, command, resource limit, service property, or cleanup result.

`Decision.reply` is ordinary detached diagnostic data. `Decision.effects` is
internal owner-only plan data. Neither executes anything. Initial acquisition
also returns a `Capability` object, omitted from decision repr; only its explicit
`reveal()` method yields the token for authenticated delivery. Request repr,
capability repr, errors, and ledgers do not reveal that token. The future owner
must never log it or put it in argv, environment, public artifacts, or generic
response serialization.

Acquire attempts are scoped by authorized UID and attempt key. Retrying the same
attempt returns the same study description, without minting or revealing another
capability. If the initial reply is lost, the caller can inspect that owned
attempt by retrying acquisition; it cannot recover authority. Without renewal,
the lease expires. Allocation attempts are separately scoped to their study;
retries return the existing allocation, with no new allocation effect.

## Trusted owner policy and time

`Policy` fixes TTL, absolute startup/study limits, and capacity. The development
profile permits at most four reserved slots per study and eight globally; the
owner may choose lower limits. The default TTL is 20 seconds, startup cap one
minute, and study cap 30 minutes. These are bounded policy defaults, not measured
performance or cleanup guarantees. Callers cannot change them.

The owner supplies `ClockSample` from a continuous `CLOCK_BOOTTIME` source and
separate trusted sleep detection. Wall time and caller timestamps are not inputs.
`advance()` must run independently of client traffic. Expiry at a deadline is
inclusive. Renewal cannot extend either absolute cap. `activate()` is an
owner-only readiness transition; it does not renew controller liveness.

Startup and active leases can become expired or revoked. Detected sleep, boot
mismatch, or a clock rollback terminates existing live generations and places
the core into reconciliation mode. Terminal states never become live again.
No capability-bearing operation is admitted in reconciliation mode, even if
its hash matches. Hello and an already-owned acquisition attempt remain
inspectable. This module does not detect sleep, prove supervisor independence,
or supply an OS watchdog.

## Allocation and cleanup boundary

The owner must serialize this model's calls; it is not a concurrent service.
An allocation initially becomes `reserved` and consumes capacity. Before any
external creation, the owner must durably persist that intent. Immediately
before its single OS dispatch, the owner calls `begin_allocation(identity,
clock=sample)`. This advances trusted time, checks the current lease and exact
generation, and irreversibly consumes the reservation into `creating`. It rejects
expired, revoked, already-consumed, releasing, absent, or foreign attempts.

An old `Effect` is not launch authority. No awaited journal I/O, scheduling gap,
or queued dispatch is permitted after the last admission check. If that boundary
is interrupted, the attempt remains uncertain; do not replay it. The future OS
owner must bind this check to actual process/service identity and independently
enforce lease loss. This source-only core cannot make an OS syscall atomic with
lease expiry.

`record_outcome()` accepts an owner-observed present or unknown outcome. Unknown
results stay `unresolved`; no automatic retry or capacity release occurs. Release
revokes the specified study and marks its remaining allocations `releasing`.
It leaves other studies alone and does not claim anything has stopped. All
states except `absent` consume capacity, including creating, unresolved, and
releasing states.

Only `confirm_absent(OwnerAbsence(..., creation_quiescent=True), clock=sample)`
frees a reservation. The future OS owner must first establish both actual absence
under its acquired identities and that all in-flight creation has settled, so
no delayed launch can follow. A moment with no visible process is insufficient.
The identity includes installation, original host boot, study, and allocation.
This attestation is a trusted Python API, not a wire operation, authenticated
attestation format, or permission to adopt resources by their names or IDs.

Stop intent remains available through `pending_cleanup()` until confirmed
absence, including when a request fails after time advancement. The owner must
drain that intent independently of successful requests. Repeated stop plans
require idempotent, identity-checked OS cleanup; this module supplies neither.

## Bounded persistence and recovery

`dump_ledger()` returns bytes; the caller owns atomic, protected persistence.
Only capability hashes are serialized, bound to installation, boot, study, UID,
creation time and absolute limits. Tombstones preserve every acquired study and
allocation attempt. Policy bounds their accumulation: by default 32 studies and
16 attempts per study, with hard maxima of 64 and 32. Full ledgers refuse new
admission; they never evict keys and accidentally replay an earlier request.

`restore()` validates a bounded, exact-schema owner ledger and always returns a
reconciliation-only core. Old non-absent allocations remain reserved for cleanup,
old live leases become terminal, and matching capabilities do not regain
authority. Even an empty or fully cleaned restored ledger cannot reopen
admission through this API. No ID-based adoption, automatic restart, or removal
of tombstones is implemented. There is no safe maintenance or epoch-rotation API
in this cut: eventually `ledger_full` is an intentional development limit.
Discarding the ledger and reconstructing an accepting core under the same
installation and boot would permit replay of old acquisition attempts; the
future owner must never treat that reset as recovery. A future recovery owner
must establish protected journal integrity, OS identity matches, quiescence and a reviewed generation
rollover before admitting new work.
