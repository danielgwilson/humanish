# Owned offline browser qualification packet

This is a temporary Linux amd64 development experiment for
[#825](https://github.com/danielgwilson/humanish/issues/825), not an installed
broker, a public local-runtime command, or a release qualification.

The only privileged entry is the fixed, input-free manual workflow on reviewed
`main`, on a disposable GitHub-hosted Ubuntu 24.04 runner. Pull requests and
ordinary pushes run unprivileged fixtures only. The manual job first repeats the
read-only host profile, builds the maintained inputs without privilege, and
stages only bytes matching the reviewed literal catalog. Staging never executes
submitted binaries. The official pinned Node binary runs only as the controller's
DynamicUser. Package metadata is accepted through its literal manifest digest;
no caller-supplied expected disk hash becomes root authority.

The packet has two executable cells. Both remain unmeasured until an actual
manual-main receipt and independent screenshot review exist:

| Cell | Required observation | Implemented scope |
| --- | --- | --- |
| PRELUDE | Same active retained parent reports 0 → 1 → 0 across a real post-READY fork, leader exit and service-leaf removal; unrelated B and canary continue | Executable, actual proof pending |
| OB01 | Exact jailed offline guest, existing bootstrap/client, full-frame before/typed/after screenshots, one Unicode insertion and one Save dispatch, root unchanged, state changed, exact cleanup | Executable, actual proof pending |
| OB02 | Cancel after resources exist and before browser admission | Not implemented |
| OB03 | Controller killed | Not implemented |
| OB04 | Controller stopped and lease expires | Not implemented |
| OB05 | Supervisor killed | Not implemented |
| OB06 | Supervisor stopped and PID1 watchdog fires | Not implemented |
| OB07 | Absolute study cap despite renewals | Not implemented |
| OB08 | Root owner killed; independent observer cleans up | Not implemented |

`aggregate` stays false. A successful first job means only the two executable
cells were observed and their cleanup completed. `visualReview: pending` requires
an independent inspection of all three real screenshots, including Unicode and
**Saved 1**. The packet has no DOM assertion or hidden guest command channel.

## Ownership and termination

The root observer captures a still-active VMM-only parent slice before launch.
It retains the directory and `cgroup.events` handles, boot identity, exact
InvocationID and cgroup path. Every fresh recursive population read rechecks that
identity. Owner disappearance is measured through a separate retained owner
slice, because the owner invokes bounded, awaited systemctl children. Neither
forking owner nor VMM uses an enumerated-PID absence fallback.

The independently supervised owner is capped at 1,800 seconds and has a
10-second PID1 watchdog. The VMM service is capped at 240 seconds. Its actual
broker lease has a 20-second TTL, a 60-second startup cap and a 120-second
absolute cap; only actual controller renewals reach it. Supervisor READY admits
the lease gate. It does not activate the study. Activation follows the existing
guest bootstrap, HELLO and first admitted full-frame observation.

The observer confirms the owner is quiescent and the exact VMM unit has no
pending start job before accepting the retained-parent zero. Known path names
are not cleanup authority: per-allocation file/socket/device identities are
captured during creation/admission and checked before unlink. Unknown entries,
replaced identities, missing ownership, incomplete starts, or unconfirmed exits
retain the affected packet with an unresolved receipt. There is no broad
PID/unit/container enumeration cleanup and no name-based recovery adoption.

The fixed nonforking supervisor/controller/progress roles retain the narrower
inert-fixture fallback: held exact leader pidfd exited, same invocation inactive,
and the prior cgroup leaf removed. This is never used for owner, prelude or VMM.

## Device and process policy

The launcher's capability whitelist is fixed. Only the separate root owner gets
`CAP_SYS_PTRACE`, to read the already acquired VMM's fixed proc identity fields;
its syscall filter denies `ptrace` and `process_vm_*`. No attach/read/write syscall
or capability grant to the VMM is added.

`DevicePolicy=closed` includes systemd's standard-device allowances. Explicit
additional rules are numeric KVM 10:232 `rwm`, TUN 10:200 `m`, and, only if the
bounded trusted `/proc/misc` read identifies it, exact userfaultfd 10:minor `m`.
The launcher rechecks that observation. No read/write grant, broad misc-device
wildcard, host device alias, or error-triggered widening exists. Jailer sanitizes
inherited descriptors and environment; actor and API connections are acquired
after launch. This packet configures no NIC, TAP, MMDS, snapshot or account.

Actual jailer access, namespace creation, capabilities, default seccomp, initrdless
boot, device policy and guest memory headroom remain live measurement gates.
Passing the earlier read-only KVM system-fd profile did not prove those gates.
In particular, a host kernel outside Firecracker's listed families is recorded
as a development limitation, not described as upstream supported.

## Bounded evidence and local checks

Run only the unprivileged tests locally:

```sh
python3 -B -m unittest discover -s runtime/owned-browser-qualification/tests -p '*_test.py' -v
python3 -B -m unittest discover -s scripts/tests -p 'owned_browser_*_test.py' -v
node --check runtime/owned-browser-qualification/controller.mjs
```

The manual job uploads finite JSON and three synthetic screenshots. Finite serial
facts retain the observed kernel release, systemd version and listening-marker
count as diagnostics; they are not guest attestation. Each slice cleanup requires
a fresh owned zero, terminal/no-job state and acknowledged cgroup removal.
The job does not
distribute appliance/kernel/VMM/Node binaries or broad host logs. Bounded serial
diagnostics remain in the private root packet on failure. An unconfirmed root
command exit prevents a second automatic cleanup command. Disposable-host
retirement is the final backstop for retained unresolved resources; it is not
reported as observed cleanup.
