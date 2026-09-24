# Local Firecracker study integration

Native Linux amd64/ARM64 source builder for a complete browser study: isolated
Firecracker desktops, Codex-account participants, normal Observer recordings and
automatic Codex analysis. Installed users should follow
[local browser setup](../../docs/architecture/local-browser-runtime.md), which
downloads a prepared image. The Mac/Lima candidate passed installed studies
with the ARM64 image; its public download path remains a release gate. Inboxes
and optional media remain follow-ups.

## Run it

Prerequisites: Node/pnpm, Python 3, a rootful Docker daemon with accessible
`/dev/kvm` and `/dev/net/tun`, and the supported Codex CLI/login profile described
in [account analysis](../../docs/architecture/restricted-codex-analysis.md).
Building the kernel requires approximately 8 GiB of available memory and several
minutes; this is a source build, not the intended end-user installation path.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
python3 runtime/local-firecracker/build.py --output .humanish/local-assets
node scripts/local-firecracker-study.mjs .humanish/local-assets/assets.json
```

The study consumes account quota; dollar cost remains unknown. It serves a
synthetic note app on loopback, asks two participants to save different notes,
checks the app's actual saves, runs analysis, and verifies the normal run bundle.
The final output identifies its Observer page. Runtime evidence stays under
`.humanish/`; raw screenshots are local-only under the existing sharing rules.
Build directories must be new. The builder retains source/provenance, logs and
Docker images for reuse; it does not install a host service or publish images.

## Runtime

Docker supplies the network namespace, resource limits and device grants.
Firecracker runs as an unprivileged process using its native configuration file,
with its standard seccomp filter. The guest has a read-only root disk and a
fresh writable state disk; it receives no host credential or checkout mount.
No privileged container or host-network mode is required.

Networking follows Firecracker's [TAP/NAT setup](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/network-setup.md).
Public TCP/UDP egress is available; guest access to private host/LAN addresses and
cloud metadata is blocked in its outer network namespace. A separate opaque
TCP forward grants access to the selected loopback app port, preserving the
original URL, HTTPS and WebSocket byte streams without an HTTP parser.

The existing guest browser control interface implements `DesktopSession`.
`CuaDesktopLane` plugs it into the existing scheduler, participant loop and
recording pipeline. Each Codex request retains its own process, home and thread.
The guest exits on controller disconnect; Firecracker's reboot path exits the
VMM, and Docker removes the container and its anonymous state volume. Abrupt
controller death can leave a small host socket directory. A 30-minute process
deadline bounds a guest that stops responding.

The development guest currently uses a 960×720 Chromium desktop, 2 vCPUs and
2 GiB guest RAM per participant. Media is off. A NIC and loadable-module support
preserve the path to optional media without changing the study or network model.

## Distribute a runtime

`build.py` produces `assets.json` with an immutable image ID and runtime revision.
`pack.py` can also package already-prepared assets without rebuilding the kernel.
Use `docker image save <image> | gzip -1` for the downloadable archive, then
record its exact byte count, SHA-256 and image ID in `src/local-runtime-release.ts`.
Publish under a versioned `runtime-*` GitHub release; users never follow a moving
tag. Runtime tags do not publish the npm package.

Retain and distribute the matching sources and notices alongside the image:

```sh
python3 runtime/local-firecracker/sources.py \
  --browser .humanish/local-assets/browser \
  --runtime-image humanish-local-runtime:<build-tag> \
  --boot-inputs .humanish/local-assets/inputs \
  --kernel-build .humanish/local-assets/kernel \
  --output .humanish/runtime-sources
```

The collector matches guest and runner packages to the retained Debian source
indices, verifies each source download, and includes the kernel source/config,
Firecracker source and license notices. Include a `git archive` of the matching
Humanish source commit for its build scripts and guest control code. Large source
archives can be split into numbered parts below GitHub's per-asset limit; include
checksums and exact concatenation/extraction instructions in the release.
Review the distributable inputs, never publish local run bundles or build logs.

ARM64 builds run natively in Linux (including Lima on supported Macs), using the
same recipes with the pinned ARM64 VMM, guest base and upstream kernel config.
The kernel output is the raw ARM64 `Image`, not x86 ELF `vmlinux`. The manual
`arm64_candidate` workflow input builds a transferable image and corresponding
source archive on an ARM64 runner; it does not boot a VM or qualify Mac support.
