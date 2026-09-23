# Offline development browser disks

This internal builder assembles inspectable amd64 ext4 templates. It does not
install a runtime, import privileged assets, start a VM, access KVM or expose a
new CLI execution mode. Keep generated output private under `.humanish/`.

Build the maintained browser base, kernel configuration and guest payload first:

```bash
python3 runtime/browser-guest/build.py --architecture amd64 --output .humanish/browser-base
pnpm exec tsc -p tsconfig.build.json
node scripts/guest-runtime-package.mjs .humanish/guest-payload
python3 runtime/browser-disk/build.py \
  --base .humanish/browser-base \
  --package .humanish/guest-payload \
  --kernel-config .humanish/kernel-build/output/kernel.config \
  --output .humanish/browser-disks-01
```

The [kernel recipe](../browser-kernel/README.md) supplies the checked configuration.
Every attempt requires a new output directory. Repeating the disk command with
the same immutable inputs and a second output allows an explicit comparison:

```bash
python3 runtime/browser-disk/compare.py .humanish/browser-disks-01 .humanish/browser-disks-02
python3 -B -m unittest discover -s runtime/browser-disk/tests -v
```

The tools image uses the maintained base's digest and signed frozen Debian
snapshot. Assembly starts in an acquired ordinary Docker container by exact
image ID: network disabled, no user-supplied bind mounts, devices, privileged flag or image
volumes, 2 GiB memory with no swap, two CPUs and 128 tasks. Four filesystem
capabilities preserve the exported numeric owners and modes inside that
container. This is an ordinary rootful Docker build, not rootless isolation or
a claim about guest memory requirements. No guest executable is run.

The complete tar is validated before container-only extraction. Special entries,
traversal, duplicate paths, writes below symlinks, unsupported metadata and
hardlinks to anything other than a known regular entry are refused. Ownership
is restored before permission bits; directory metadata is finalized last.
The copied tree must equal the tar's bytes, modes, numeric owners, symlinks and
hardlink groups. Docker export does not establish source-image ACL or xattr
preservation; that limitation remains in every assembly receipt.

The guest payload is a finite manifest and file tree. Its canonical revision
must match its declared inputs, and compiled modules, dependencies and fixed
configuration bytes must match those input hashes. Generated revision/package
files must have their exact derived contents. This proves self-consistency,
not trust or authorization. A future privileged importer must use a separately
reviewed catalog; it must never trust a caller-supplied build manifest.

The overlay replaces only approved leaves after checking every ancestor. It
never writes through an existing leaf symlink. A full before/after inventory
allows only declared leaves and required parent directories to change.

`mke2fs -d` produces a 2 GiB read-only-root candidate and a fresh 512 MiB state
template without loop devices or mounts. Block size, inode count/size, reserved
blocks, UUIDs, features, ownership and eager initialization are explicit.
The state filesystem root is UID/GID 1000 and 0700; it contains only filesystem
scaffolding. The fixed UUIDs identify templates, not participants or authority.
Future owners must make private writable state copies for each participant.

Both filesystems must pass `e2fsck -fn`, feature/geometry/headroom checks and
complete content readback. `debugfs rdump` drops setuid bits and splits hardlinks
in its extracted copy, so a separate batch reads every disk inode and checks
exact modes, owners and hardlink equivalence classes. The init symlink chain,
Chromium sandbox mode, all payload bytes and fresh state are included.
The tools follow the pinned [Debian13 mke2fs interface](https://manpages.debian.org/trixie/e2fsprogs/mke2fs.8.en.html).

The host rehashes the exported disks. A final manifest appears only after exact
owned-container removal and confirmed absence. Create uncertainty, changed
inputs, failure, cancellation, missing inspection, truncated output and cleanup
uncertainty prevent promotion; available diagnostics stay with the failed
attempt. Cleanup never scans by name or label.

Disk hashes need not repeat: filesystem creation/inode times, directory hash
seeds and checksums are not normalized. The comparison verifies identical
declared inputs and semantic inventories, records actual byte equality and
retains differing superblock fields. It does not claim those fields explain
every differing byte. Catalog any later accepted disk by its actual digest.

Clean filesystems do not prove initrdless boot, effective guest mounts, systemd
ordering, AF_VSOCK, sandbox enforcement inside a VM, KVM support, ARM64,
networking, source-distribution completeness or a working local study.
Every receipt remains `vmBooted:false` and `redistributionApproved:false`.
