# Offline guest control package

This development package connects one sandboxed, headed Chromium desktop to the
existing finite browser-control protocol. It does not install a host broker,
start a VM, select an application, or expose a managed local study mode.

The fixed guest unit runs as UID/GID 1000. A small Python relay accepts one
AF_VSOCK connection on port 5251, checks host CID 2 for consistency, then starts
the packaged Node entrypoint. CID and echoed challenge values are not
credentials: the future host owner must bind the stream to its acquired guest
and current lease.

Node alone validates the first frame: four-byte big-endian length, at most
1024 payload bytes, canonical ASCII JSON with exactly `version` and `identity`.
Identity is the existing generation/challenge/runtimeRevision object. Unknown,
reordered, duplicated, escaped or otherwise noncanonical input is refused.
After fixed desktop preparation, READY transfers the stream to the existing
browser-control dispatcher. There is no shell, actor JavaScript, selector,
arbitrary path, configurable URL, reconnect or fallback operation.

The private Node-to-relay pipe carries only ordered `A` and `R` supervision
markers. Python enforces admission within five seconds and readiness within
35 seconds of spawning Node, including import time. The listener accepts for
15 seconds; these are fixed development bounds, not a qualified cohort policy.
The host's absolute lease deadline remains authoritative. Queues are bounded
at 256 KiB in each direction. EOF and failures revoke input before exact-owned
teardown. Guest PID1 uses main-process lifetime, control-group kill, no restart,
a five-second stop grace and a 30-minute absolute cap.

`root/` contains fixed image files; `links.json` declares the only unit links
and timer masks. The root disk is read-only; fresh state mounts at
`/home/humanish`. Pinned vendor tmpfiles rules supply the volatile scaffolding;
RuntimeDirectory creates the private user runtime directory. The fixed readable
Openbox configuration has no launcher keybindings. Root's installed Chromium
sandbox metadata is retained, and startup verifies actual sandbox status.

Build from a frozen dependency install and current TypeScript output:

```sh
pnpm exec tsc -p tsconfig.build.json
node scripts/guest-runtime-package.mjs .humanish/guest-package
python3 -B -m unittest discover -s runtime/browser-guest/control/tests -p '*test*.py'
pnpm exec vitest run tests/guest-bootstrap.test.ts tests/guest-runtime.test.ts tests/guest-runtime-package.test.ts tests/guest-runtime-proof.test.ts
```

The packager requires a new output directory. It emits `root/` and
`manifest.json` (`humanish.guest-runtime-package.v1`), hashes actual compiled
modules and dependency bytes, verifies copied bytes and exact leaf coverage,
and refuses changing inputs. The generated revision is a canonical input hash;
it excludes its generated output to avoid a cycle. Final file/disk hashes are
separate. An unprivileged build manifest does not authorize a privileged
importer or replace a trusted catalog.

The development proof command requires a pinned local recipe-built image ID:

```sh
HUMANISH_GUEST_IMAGE=sha256:REPLACE_WITH_LOCAL_IMAGE_DIGEST node scripts/guest-runtime-proof.mjs
```

It uses ordinary owned containers with read-only root, no network, no host
binds/devices, 1536 MiB memory, no swap, 256 tasks and 256 MiB shared memory.
A test-only launcher prepares volatile directories inside that container and
permanently drops to the guest user. The proof output tmpfs and fresh-home
mount are harness resources, not production guest alternatives. Receipts,
screenshots, source manifests and failed attempts stay under ignored
`.humanish/`; container removal is checked by exact acquired identity.
Each container imports the exact packaged relay with its installed Python and
records the module hash. This import check does not invoke the listener.

Driver conformance, packaged stream control, guest PID1 behavior, ext4 boot,
AF_VSOCK, KVM and complete studies are separate claims. Container tests do not
qualify the latter five. The 2048 MiB VM's remaining OS headroom also requires
an actual later boot measurement.
