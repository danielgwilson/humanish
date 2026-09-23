# Inert systemd qualification

This finite Python 3.12 packet tests systemd ownership with inert processes. It
is not a broker, installer, VM launcher, or Humanish runtime mode. Source tests
and `systemd-analyze verify` do not establish that the privileged cases pass.
A real run must retain its exact manifest, host tuple and complete case receipt.

The supported qualification target is real system PID1 in the systemd 255
family, unified cgroup v2, Python 3.12, systemd NSS, pidfds and CLOCK_BOOTTIME.
A reviewed GitHub-hosted Ubuntu 24.04 job can provide an ephemeral target. Do not
run this on a self-hosted runner or infer native macOS/ARM64/VM support from it.
No command elevates itself, installs packages, changes accounts or networking,
opens Internet sockets, or starts VMs. Communication is AF_UNIX only.

## Source preparation and checks

From the repository root, as an unprivileged user:

```sh
python3 -B -m unittest discover -s runtime/inert-qualification/tests -p '*_test.py' -v
python3 -B -m unittest discover -s runtime/broker/tests -p '*_test.py' -v
python3 -B runtime/inert-qualification/prepare.py /absolute/fresh/bundle
```

The last command requires a new destination and prints one JSON object with
`source` and `manifest_sha256`. It copies only the fixed module allowlist,
including the exact current `runtime/broker/{protocol,leases}.py` bytes. There
is no edited copy of the lease core in this directory. The generated manifest
pins every copied source hash. Generated bundles and receipts stay outside Git.

`packet.render(packet.BASE / ("1" * 32), packet.nonce())` returns eight fixed
unit texts without host effects. Write those texts into a private temporary
directory and pass all eight filenames to `systemd-analyze verify`. Verification
may also emit diagnostics for unrelated existing host units; inspect the exit
status and the specific unit named. It does not start services.

## Reviewed staging and execution

Review the source, manifest and exact host before executing any privileged step.
The stager is standalone standard-library code. An authorized operator or fixed
CI wrapper must first read its reviewed bytes without privilege, copy those
bytes into a fresh root-owned directory with non-writable ancestors, verify the
copied SHA-256, and make the script read-only. Root must not execute the mutable
checkout or import its modules as the staging step.

The trusted copied stager accepts exactly the prepared bundle and its approved
manifest digest:

```sh
/usr/bin/python3 -I -S "$REVIEWED_ROOT_OWNED_STAGER" "$PREPARED_BUNDLE" "$MANIFEST_SHA256"
```

It verifies the target prerequisites before creating a destination, anchors
source traversal with directory descriptors, refuses links/non-regular/multiply
linked files and limits their size. The source bundle is never recursively
copied. After verifying all bytes, it creates its own random root below
`/run/humanish-inert-qualification/`, with a 0711 packet root, 0755 code
directories, 0444 code files and 0700 state. It prints `packet_root` and the
manifest digest. A partial staging failure reports `retained_partial_root`;
that incomplete root is preserved for operator inspection and cannot run a case.

The staged qualification entrypoint accepts only four commands:

```sh
/usr/bin/python3 -I -S "$INERT_PACKET_ROOT/code/qualification.py" inspect
/usr/bin/python3 -I -S "$INERT_PACKET_ROOT/code/qualification.py" run-matrix
/usr/bin/python3 -I -S "$INERT_PACKET_ROOT/code/qualification.py" recover
/usr/bin/python3 -I -S "$INERT_PACKET_ROOT/code/qualification.py" cleanup
```

There are no arbitrary unit, UID, property, command, output or deletion arguments.
`inspect` validates staging and the host without starting units. `run-matrix`
is one-shot for that packet root and preserves failures. `recover` and `cleanup`
only reclaim resources with matching saved authority or durable positive absence
evidence. They do not start or renew old studies. A missing original identity
remains unresolved; inactive metadata or a vanished pathname is insufficient.
No stale record can authorize stopping a replacement invocation.

Each command emits one JSON object. It includes `version: 1`, `command`, `status`,
`aggregate`, all twelve `cases`, `cleanup`, and a sanitized `host` tuple. Each
case contains `id`, `status`, `samples`, and `max_latency_ms`; each sample contains
`variant`, `phase`, `status`, `latency_ms`, `reason`, bounded `facts`, and a separate
post-verdict `cleanup` result. Case
status is `passed`, `failed`, `pending`, or `not_reached`. The current fixed table
has 29 observations. `aggregate` requires every expected variant and repetition
to pass plus complete cleanup. Empty, partial or reordered coverage cannot pass.
The sample cleanup result includes duration in milliseconds, outcomes for six
fixed roles, and unit-file/control-socket counts (`removed`, `retained`,
`unresolved`). Each role distinguishes positive process absence and its basis
from runtime-file/socket removal, unit-file removal, and collector-socket removal.
Unacquired or unregistered roles do not claim positive absence. Partial runtime
cleanup has unknown counts, never invented successful removals. Cleanup over
30 seconds remains unresolved, including when later recovery finds nothing left.

An independent verdict is persisted before cleanup; later cleanup cannot turn
that failed verdict green. Process absence and file cleanup are distinct facts.

Sanitized facts retain actual credential/capability/NNP/descriptor readback,
effective service properties, lease sequence/deadlines, fault and absence times,
and fresh unaffected-worker counters. The counter baseline is timestamped after
the phase delay and before the fault; progress must follow the fault. Decisive
events retain leader exit plus the still-active child, timeout-attributed hard
stop, startup-gate poll counts and final states, and replacement-refusal facts
without exporting invocation identifiers. `facts.observation_phase` explicitly
marks the pre-cleanup snapshot; per-role `absence_basis_before_cleanup` is separate
from the later cleanup result. Full ownership records, boot identities,
unit names, paths, pidfds and raw fixture reports stay in root-private state.
Only bounded fixed reports are retained; this packet has no recursive export.

## Topology and ownership

Every observation has a fresh A study (supervisor and two workers), B study
(supervisor and one worker), and a separate canary. The static-collision case
refuses A before registration and runs B/canary for the negative proof. Full
128-bit random generations use lowercase base32 so DynamicUser names fit the
31-character limit. Both user and group NSS namespaces must be empty before
unit registration. No account is created or deleted explicitly.

Supervisors are unprivileged `Type=notify` services. The actual single-threaded
lease loop sends READY and watchdog datagrams. The exact broker core receives
trusted CLOCK_BOOTTIME samples independently of client traffic. Its 20-second
TTL, increasing renewal sequences, 60-second A cap and 180-second B cap remain
separate bounds. Relay timestamps cannot extend a lease. The capability stays
inside the supervisor and never enters argv, environment, reports or wire replies.

Workers are `Type=exec`, `ExitType=cgroup`, `DynamicUser=yes`, with `BindsTo` and
`After` their supervisor. The fixed `ExecStart=!` launcher starts as root under
only SETUID/SETGID bounding capabilities. A root-private handshake allows the
collector to verify its real/effective/saved root credentials, invocation and
cgroup through acquired process identity. Then it closes that channel, empties
supplementary groups, drops every GID/UID, closes other descriptors and execs
only the fixed inert worker with locale-only environment. The worker reports
its denied root-regain attempts, empty effective/permitted/inheritable/ambient
capabilities, NNP and descriptors. Its bounding set is recorded separately.

Study slices have 128 MiB, one CPU and 32-task limits. Services have no restart,
no delegation, a 300-second hard cap, fixed stop/abort bounds and group kill.
The hard cap is emergency containment, never evidence that a tighter case passed.
Root renewal relays and the IS12 A conductor have exact-parent death guards and
finite lifetimes; none daemonize or create a new session.

The collector holds InvocationID, cgroup device/inode, runtime-directory
identity and pidfds. It faults only acquired processes. Cgroup emptiness or
positive exits of all held members plus matching inactive PID1 state establish
absence. These finite workers never fork after their ready report. No generic
process sweep or `cgroup.kill` fallback is implemented. Every owned stop and
readback shares the cleanup deadline. A failed resource does not skip independent
cleanup. After absence, verified bounded reports are copied into root-private
state, then exact runtime files, socket entries, directories and unchanged
unit files are removed. There is no recursive delete. The packet root and its
private evidence are intentionally retained.

## Case inventory

| Case | Fixed observation |
| --- | --- |
| IS01 | Normal root launch, credential drop, effective limits, B/canary progress. |
| IS02 | Actual fixed `User=root`/`Group=root` negative template refused before A registration. |
| IS03 | Held leader exit while a known child keeps the service active; owned stop removes it. |
| IS04 | Normal supervisor finish and SIGKILL, each at three renewal phases; dependent workers stop. |
| IS05 | SIGSTOP at three phases; PID1 attributes watchdog failure and removes descendants. |
| IS06 | Relay death, relay stop, and silent open channel, each at three phases; independent TTL expiry. |
| IS07 | Duplicate renewal rejection and sustained renewal through the absolute cap. |
| IS08 | TERM-ignoring descendant removed by fixed-grace hard stop. |
| IS09 | Worker requested while supervisor delays READY or fails startup; dependency gate blocks admission. |
| IS10 | New owner reuses an ended unit name; old InvocationID record refuses it. |
| IS11 | Owned-entry substitution refused; independent A2 cleanup still proceeds. |
| IS12 | Actual A conductor dies while observer/B owner survives; independent stop and cleanup-only recovery. |

Explicit-stop checks have a 30-second outer bound. Controller-loss checks have a
120-second outer bound, including observation. Death/hang/TTL repetitions retain
maximum measured latency. Every A-failure case requires fresh B/canary counters
across the fault window. These samples do not qualify suspend/resume, host load,
hard real-time scheduling, hostile-root races, Firecracker, jailer, devices,
networking, package upgrades or the complete managed-local study path.

PID1 has no atomic InvocationID compare-and-stop method in this packet. The
collector checks immediately before the fixed stop, serializes its own mutations,
and refuses the deliberate replacement case. A hostile administrator replacing
units between those operations is outside the proof's threat model.
