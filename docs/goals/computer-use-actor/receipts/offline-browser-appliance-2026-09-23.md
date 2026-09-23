# Offline browser appliance construction

2026-09-23 · Linux amd64 · development artifacts only.

This work adds pinned kernel/VMM inputs, a fixed guest browser entrypoint and
control bridge, and inspected ext4 templates. It does not add a supported local
study, install a broker, boot a VM or change the existing execution defaults.
Generated appliance bytes remain private and unapproved for distribution.

## Inputs and kernel

The maintained Debian 13 browser base explicitly includes Python's minimal
interpreter and makes the constrained Openbox policy readable by the guest user.
Its native amd64 export contains 317 packages and 213 source references. Chromium
is 153.0.8010.52, Node 20.19.2 and Python 3.13.5.

Firecracker and jailer are the matching official 1.17.0 amd64 pair. Actual version
checks ran as nonroot with no network and all capabilities dropped; no VM was
created. The release archive matched its recorded GitHub asset digest and
checksum sidecar. The upstream tag is unsigned and the release is mutable;
this establishes reviewed HTTPS-origin bytes and integrity, not a signed or
independently rebuilt VMM release.

The browser kernel is 6.18.39-humanish-browser-amd64-1, built from the exact Amazon
microvm source RPM named by the pinned Firecracker configuration. Signed source
and repository metadata were checked against the AWS-documented public key.
All 140 declared patches were applied. Three separate compilations produced
identical ELF, compressed image, configuration, System.map and COPYING bytes.
Build orchestration changed between the first and final attempts; compiler
inputs, source, configuration and toolchain remained equal. Final source and
actual build snapshot were independently bound.

The final configuration includes the built-in block/ext4/vsock and
namespace/seccomp/cgroup primitives required by the proposed guest. It excludes
loadable modules, initramfs, media, sound, DRM and virtio networking. This is
configuration compatibility, not proof of a successful mount or boot.

| Final development artifact | SHA256 |
| --- | --- |
| Kernel ELF, 27,736,920 bytes | `caf3803a0c8c3cacdc2beedbd49f4806d4697934ddb328cf4df42ff2533ef138` |
| Kernel configuration | `9c4344820516d06d3ba0590b48a989c8b9236d444b16fb0a566bd33e3543f737` |
| Firecracker 1.17.0 amd64 | `99ad0f5cd0514a88aad0e9ae8cfdb3cc3b4ab9d190e1194602406c786b5de7a5` |
| Matching jailer | `65ef226e96f0ceda55ba643f445801ef2cc0ea667ef67cad8ac4f406c9c8434f` |

## Guest control and actual browser checks

The fixed Python relay accepts one guest-vsock peer and forwards bounded byte
queues to one fixed Node child. It parses no actor commands or JSON. Node owns
canonical bootstrap validation, display/browser startup, the existing finite
browser-control dispatcher and exact-owned teardown. Malformed initialization,
early actor bytes, cancellation, deadline or child loss revoke the attempt;
there is no reconnect or input replay. Host-side initialization consumes an
already-acquired stream and allocates no socket, sandbox or VM.

The package revision binds actual compiled modules, fixed configuration,
dependencies and build inputs. Copied bytes are checked again before the
manifest appears. The disk consumer independently checks that package contents
match those revision inputs, including the exact generated revision module.

Actual ordinary-container qualification used a read-only root, no user-supplied
binds/devices or network, 1536 MiB memory with no swap, 256 tasks and 256 MiB shared
memory. Chromium kept its sandbox. The three groups passed:

- 17 existing headed driver cases, including native coordinates, Unicode,
  cancellation, focus changes and explicit unsupported states.
- 6 owned-stream cases, including immediate HELLO after READY, full-frame PNG,
  independent exact Unicode DOM readback and browser sandbox inspection.
- 3 packaged-main cases using the actual installed Node entrypoint and pipes.

The exact packaged Python relay also imports successfully as UID/GID 1000 on
Python 3.13.5 in each cell. Its module digest matches the payload; the import
check invokes no listener or socket. The retained final packet is
`2026-09-23T14-02-35.709Z-21b12fba-e0a4-4d5b-b293-a20ebe967031`, receipt SHA256
`933e8058da22af8cb924fb0f9612f7940ebf1d20d9ac663b0ae003f52adc0f00`.
READY took 897 ms and 1583 ms in its two runtime cells; this excludes VM boot and
image preparation. Peak attributed memory stayed below 507 million bytes; it
does not measure whole-VM or cohort overhead. All three containers were
confirmed absent. Independent review inspected the actual PNGs as well as the
source, package and recorded restrictions.

Failed attempts are retained: an incorrect xauth invocation and an overly
small stdout assumption for a successful display probe both prevented READY.
Neither was fixed by relaxing permissions, sandboxing or readiness assertions.
Proof-consumer tests reject empty/missing cases, duplicated result records,
command failure and incomplete cleanup.

## Filesystem construction and failure checks

The builder validates the entire base export before extracting it inside its
owned ordinary tools container. It never extracts a root-owned image on the
host or mounts either disk. The finite overlay checks every ancestor and
replaces authorized leaves without writing through existing symlinks. Whole
tree comparison permits only declared changes.

The resulting root is 2 GiB; the fresh state template is 512 MiB with filesystem
root UID/GID 1000 and mode 0700. Fixed ext4 features, block/inode geometry,
ownership and eager initialization match the checked kernel configuration.
Both disks pass `e2fsck -fn`. Every root entry's contents, type, mode, numeric
owner, symlink target and exact hardlink group are inspected independently.
The content extraction tool drops setuid bits and splits hardlinks in its copy,
so those properties are read from disk inode records instead.

The final payload contains 882 leaves. Both complete assemblies inspected 14,246
root entries and the two fresh-state entries. Root free space is 822,894,592 bytes
with 51,282 free inodes; state has 511,627,264 free bytes and 32,757 free inodes.
The init chain, empty machine ID, vendor tmpfiles, guest service enablement,
mount table and installed Chromium sandbox metadata are included in readback.

The two assemblies have identical declared inputs and semantic inventories.
Their disk bytes differ: filesystem timestamps, directory hash seeds and
checksums differ in the retained metadata. Inode times are not normalized and
there is no claim that the observed fields explain every differing byte.

| First accepted payload assembly | SHA256 |
| --- | --- |
| Root ext4 | `1b0006d3ccbc97740bd4b796e7142eb98a7046e9ccae7ecc6ffec3ff685ab1c5` |
| Fresh state template | `0ee703d5dc3e5885c15dd904c766727cc3e20a5261c8c2aa32f68bdbd91dad0a` |
| Runtime revision | `guest-api1-22875826172118fa104baa756b17ef2366b2e7ee18f1fc7ea62b31f5c0d63bca` |

Separate actual proof covers a small filesystem, real block and inode
exhaustion, and cooperative SIGTERM during a disclosed pre-assembly hold.
Interruption prevents manifest promotion, removes the acquired container and
preserves an unrelated running canary. It does not prove interruption during
mkfs, SIGKILL recovery or VM lifecycle behavior.

Build success is published only after exact-owned cleanup and confirmed
absence. Unacknowledged create, daemon failure or unresolved cleanup cannot be
treated as absence. Tests exercise changed bytes, noncanonical paths,
unexpected links/owners, acquisition uncertainty, altered container profiles,
truncated disks and false-green proof records.

## Reproduction and limits

See the [input recipe](../../../../runtime/runtime-assets/README.md),
[kernel recipe](../../../../runtime/browser-kernel/README.md),
[guest control](../../../../runtime/browser-guest/control/README.md) and
[disk builder](../../../../runtime/browser-disk/README.md).
The appliance CI workflow rebuilds and inspects these inputs on a disposable
Ubuntu 24.04 host. It retains receipts/logs and does not upload appliance binaries.

Local release gates passed 3,641 core tests and 86 TUI tests, with 10 existing
skips, plus compiled CLI checks, public-surface scanning, documentation checks,
site build/typecheck and component registry validation. Focused Python suites
cover asset/kernel inputs, disk assembly/faults and the relay.

[Fresh CI run 35872206335](https://github.com/danielgwilson/humanish/actions/runs/35872206335)
passed the full recipe: actual 17+6+3 browser/controller checks, relay imports,
pinned kernel compilation, both disk inspections and the disk failure/cleanup
proof. Its five kernel outputs match the accepted local build. The CI payload
uses Node 22.14.0, while the local payload above used 24.12.0; that input changes
the recorded runtime revision. Each CI disk binds to its own exact package and
base inputs. The local disk hashes above are not claims about CI disk bytes.
Required checks on the final PR head remain the merge gate.

These receipts prove source-bound development construction and container
behavior. They do not qualify actual AF_VSOCK, guest PID1/mount ordering, direct
boot, KVM/jailer containment, VM memory, ARM64/Mac, networking, account-backed
participants, setup/install/rollback or a complete local study. Source-image
ACL/xattr preservation and source/notice completeness for distribution remain
open. No npm runtime release is justified by this foundation alone.
