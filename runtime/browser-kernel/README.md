# Browser runtime development kernel

Build an amd64 kernel from the exact signed Amazon microvm source paired with
Firecracker 1.17.0. This recipe never starts a VM, installs a host package, changes
a device permission or mounts an image. The output is development-unqualified.

Fetch the [pinned inputs](../runtime-assets/README.md), then run from the repo root:

```sh
python3 runtime/browser-kernel/build.py \
  --inputs .humanish/boot-inputs --output .humanish/kernel-build-01 --jobs 8
python3 runtime/browser-kernel/build.py \
  --inputs .humanish/boot-inputs --output .humanish/kernel-build-02 --jobs 8
python3 runtime/browser-kernel/compare.py .humanish/kernel-build-01 .humanish/kernel-build-02
```

Every output directory must be new. The source/recipe snapshot is taken before
building, and copied inputs are rehashed. The Docker daemon must be native amd64.
Our development builder uses an existing rootful daemon with ordinary containers;
this is not a rootless build claim. No host binds, host networking, devices or
privileged flag are used. The compile container has no network and is limited to
eight CPUs, 8 GiB memory, 256 processes and one hour. The toolchain build can access
the fixed signed Debian snapshots; it has a separate 30-minute limit.

The toolchain is the digest-pinned Debian 13 base plus fixed Debian/security
snapshots. Each build retains installed package versions, binary package archives,
source references and package notices. Compiler version, toolchain image identity,
source hashes, source signature logs and source patch order are retained. Build
images/cache remain available for inspection; cleanup concerns the exact acquired
compile container, not global Docker resources.

## Kernel contract

`policy.json` enforces built-in virtio MMIO/block, ext4 ACL/security attributes,
vsock, device/tmp/proc/sys filesystems, shared memory, loopback networking, X11 IPC,
user/PID/network/IPC namespaces, seccomp filtering and the memory/pids/CPU cgroup
controllers. The complete guest-required policy is checked after olddefconfig.
The x86_64 base-page size is 4 KiB. Virtio RNG and the upstream entropy configuration
are preserved. Mount/cgroup namespaces do not have additional standalone Kconfig
switches in this kernel.

Virtio networking and boot-time IP configuration support ordinary TCP and UDP.
The upstream MicroVM patch disables loading modules even when `CONFIG_MODULES`
is enabled. The optional media kernel therefore builds the pinned v4l2loopback
driver in; its device parameters use the standard kernel command line. Media
and sound are allowed by policy, but the browser-only image starts no media
services. Initramfs, DRM and the listed debug features remain disabled.

The fixed guest contract is a whole-disk `/dev/vda` ext4 read-only root and a fresh
whole-disk `/dev/vdb` ext4 state volume. No partition/UUID discovery or initramfs is
required by this proposed layout. The disk builder must select ext4 features
compatible with the actual config. A config check does not prove that Debian,
Chromium sandboxing, read-only mounts, vsock or the guest memory budget work at boot.

The signed source RPM's complete ordered 140 patches are applied using its
one-line patch-fuzz policy. The empty additional upstream patch list is asserted,
so new patch material cannot be silently omitted. The RPM spec itself is never
executed. `config-delta.json` records every normalized/customized setting against
the pinned Firecracker config, including toolchain differences.

## Evidence and failure handling

`output/kernel.bin` is the uncompressed amd64 ELF image; `bzImage`, final config,
System.map, COPYING and LICENSES are retained too. Inspect `manifest.json`,
`output/manifest.json`, `build.log` and `cleanup.json` together. A build receipt
without confirmed cleanup is not a successful workflow. Acknowledged interrupted
creation can be recovered from Docker's cidfile in the new private attempt directory;
if no ID was acknowledged, acquisition stays uncertain and no cleanup authority
is invented.

Repeat builds must compare actual rehashed outputs, source/config/build identities
and toolchain image identity. Any differing host orchestration recipe or timestamps
must remain visible; do not label a build reproducible merely because the kernel
version string matches. Generated receipts/artifacts belong outside committed source.

Focused unprivileged tests:

```sh
python3 -m unittest discover -s runtime/runtime-assets/tests -v
python3 -m unittest discover -s runtime/browser-kernel/tests -v
```

The tests cover input bounds/origins/types, required/forbidden configuration and
orchestration failures with simulated Docker results. Those tests do not establish
an actual container or VM runtime. Independent artifact inspection and actual
compilation are separate evidence. Public distribution, ARM64, first boot and
hosted/local study support are not enabled by this recipe.
