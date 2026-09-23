# Browser guest base recipe

This maintained development recipe builds a Debian 13 root filesystem for a
headed Chromium desktop. It does not include a guest kernel, controller bundle,
network gateway, broker, or independent lifetime enforcement. It exposes no
public Humanish local-runtime selector and is not a qualified VM image.

Inputs are pinned in `inputs.json`: architecture-specific official Debian image
manifests and existing Debian archive/security snapshot timestamps. The base
manifest digests came from the official Debian image index; Docker verifies the
pulled bytes. APT verifies signed Release/index/package hashes using the Debian
archive keyring. Only snapshot expiry checks are disabled, because a fixed
historic snapshot otherwise expires; signature checking stays enabled.

Run with a native Docker builder and Python 3, writing outside the repository:

```sh
python3 runtime/browser-guest/build.py --architecture amd64 --output /tmp/browser-guest-build
```

Use `arm64` on a native ARM64 builder. The script refuses architecture mismatch
and never installs emulation, changes host privileges, mounts host directories,
passes host devices, starts a VM, or uses host networking. It records whether
the existing Docker daemon is rootless. Running the CLI without sudo against a
rootful daemon is **not** a rootless build. Rootless-Docker qualification is a
separate build-environment cell.

The build snapshots and hashes an allowlisted context before Docker receives it;
both targets use that same snapshot. A changed snapshot fails finalization.
The context allowlist contains only this recipe's fixed inputs. Build services
are suppressed. The exported rootfs is produced from a created but never-started
container; cleanup uses the actual acquired container ID. The local built image
remains available for a separate disposable driver conformance test. Each output
directory is new; failed build logs are retained rather than overwritten.

## Desktop interface

- User/group `humanish`, UID/GID 1000; home `/home/humanish`, mode 0700.
- Intended X display `:0`; runtime owner must start Xvfb with a fresh private
  Xauthority file and `-nolisten tcp`, fixed geometry, and guest-local storage.
- Fixed binaries `/usr/bin/chromium`, `/usr/bin/Xvfb`, `/usr/bin/openbox`,
  `/usr/bin/scrot`, `/usr/bin/xdotool`, `/usr/bin/xclip`, `/usr/bin/xauth`,
  `/usr/bin/xdpyinfo`, and `/usr/bin/node`.
- Openbox has no keyboard, mouse, or menu launch bindings; browser chrome and
  the address bar remain visible. No desktop session autostart is invoked.
- DejaVu, Noto CJK, and Noto Color Emoji provide Latin, CJK and emoji fonts;
  installed fonts alone do not qualify exact input or visual rendering.
- `/opt/humanish/control` is reserved for an independently built, pinned runtime
  bundle. There is no npm install at boot and no copied operator profile,
  clipboard, credential, source checkout, or E2B image.
- Chromium's sandbox package is installed. The recipe never adds `--no-sandbox`.
  The native guest and container-conformance environment must independently prove
  the sandbox works; a container launch failure does not authorize disabling it.

The controller owns browser startup, clipboard lifetime, bounded captures,
finite native input, and cancellation checks at actual input. Installing X11
helpers does not expose a general command API. Their paths or arguments must
never come directly from participant requests. The final owner must provide no
NIC and no host mounts; a rootfs file alone cannot enforce those boundaries.

## Build inventory and distribution gate

Every installed binary package is downloaded at its exact version and checked
against its signed APT index SHA-256 and size. The provenance export retains those
`.deb` bytes, indexes, Release metadata, the keyring, and snapshot configuration.
It maps installed packages to source package/version and signed source-file
hashes, and copies each installed package's copyright notice. Chromium media
libraries can remain required dependencies; no separate media worker or audio
service is added. The inventory rejects listed standalone media/remote-login
services and package managers rather than claiming a browser contains no codecs.

The manifest binds the recipe, base image, resulting rootfs tar, package inventory,
and actual runtime versions. Build artifacts and full third-party notices stay
outside the public source repository. The rootfs retains Debian's installed
copyright files. Source archive references are inventoried, but complete matching
source archives still need to be mirrored, checked, and reviewed before any image
redistribution. This recipe is not legal clearance or a signed release catalog.

Neither byte-for-byte reproducibility nor runtime qualification is inferred from
fixed inputs. A second-build comparison, native ARM64 build, kernel/controller
integration, actual sandboxed desktop proof, boot/lifecycle/network tests, and
source/notice distribution review remain separate gates.

Build-orchestration regressions (context edits, tampering, cleanup, architecture
refusal and output preservation) run without Docker:

```sh
python3 -B -m unittest discover -s runtime/browser-guest/tests -p '*_test.py' -v
```

Those tests substitute an inert command runner and do not establish package or
browser behavior. An actual completed build and its retained inventory establish
the package result for that one architecture.

Primary references: [Debian snapshot usage](https://snapshot.debian.org/),
[APT authentication](https://manpages.debian.org/trixie/apt/apt-secure.8.en.html),
[official Debian image source](https://github.com/debuerreotype/docker-debian-artifacts),
and [Docker rootless requirements](https://docs.docker.com/engine/security/rootless/).
