# Local browser studies

Linux x64 users can run isolated Firecracker browser participants from the
installed CLI or TUI. Docker manages their containers and private state volumes;
the normal study runner supplies scheduling, recordings, Observer and findings.
No separate host service is installed.

## Start a study

Prerequisites: a local, rootful Docker Engine; Linux KVM (`/dev/kvm`) and TUN
(`/dev/net/tun`); and a signed-in, supported Codex CLI. See
[Codex account setup](restricted-codex-analysis.md) for the qualified version
and account restrictions. Docker access is an administrative capability.
Humanish does not install Docker or change host permissions.

Start your app on loopback, then save a lab such as
`.humanish/labs/local-browser.yaml`:

```yaml
schema: humanish.lab.v2
id: local-browser
title: Review the note editor
subject:
  source: app-url
  appUrl: http://127.0.0.1:3000
actors:
  - type: local-agent
    localAgent: codex
    count: 2
    mission: Create a note and explain anything confusing about saving it.
scenario:
  mode: live
execution:
  target: local
  concurrency: 2
  timeoutMs: 120000
```

```sh
npx humanish init --yes
npx humanish runtime status --json
npx humanish doctor --lab .humanish/labs/local-browser.yaml --json
npx humanish lab run .humanish/labs/local-browser.yaml
```

The first live run downloads the pinned runtime archive (about 569 MiB), verifies
its exact size and SHA-256, and loads it into Docker. Later runs reuse the image.
`humanish runtime setup` prepares it in advance. Status, doctor and dry-run never
download an image or launch a participant. Preparation does not consume the
participant's task-time budget. The TUI lists the same lab and runtime readiness;
starting it uses the same preparation and execution path.

This configuration needs neither an E2B key nor an OpenAI API key. Participants
and the separate post-run analyst use Codex account quota and **remote model
inference**. It is not an offline model. The restricted participant has no host
shell, checkout mount or credential files. Account dollar cost and output-token
ceilings are unknown; numeric dollar/token caps are rejected. Set
`review.analysis: false` to skip analysis.

For API billing and its supported caps, use `type: openai-computer-use`, remove
`localAgent`, and provide `OPENAI_API_KEY`. Its analysis retains the existing API
default. Neither path silently falls back to another provider or hosted desktop.
Existing labs without `execution.target: local` retain their previous behavior.

## Current limits

- Linux x64 only. Mac/Lima setup is a separate follow-up.
- A local Docker Engine; remote contexts, rootless Docker and Docker Desktop
  virtual machines are not supported by this host adapter.
- Loopback HTTP(S) app URLs on explicit ports above 1023. Each participant can
  reach its selected app port, plus public destinations over ordinary TCP/UDP.
  Other private host/LAN destinations and cloud metadata are blocked.
- Chromium at 960×720, 2 vCPUs and 2 GiB guest RAM per participant. Docker's
  enclosing memory limit is 3 GiB. Start with a small concurrency for your host;
  these allocations are not a promise of measured peak memory or capacity.
- Browser-only. Inbox and camera/microphone declarations are rejected until
  integrated. TAP/NAT networking preserves the path to optional media.
- A 20-minute default and maximum participant session budget, within the runtime
  image's 30-minute process lifetime. A shorter `execution.timeoutMs` is supported.
- Codex participants currently use `gpt-6-astra` at low effort. Hosted templates,
  device presets and hosted sandbox timeouts do not apply.

Normal close removes the owned container and its private state volume. If the
controller dies, the disconnected guest reboots, Firecracker exits and Docker
removes both. A small host socket directory can remain after abrupt death.
Run evidence remains in `.humanish/` under the normal local capture and sharing
rules. An unconfirmed release is reported as such.

## Runtime maintenance

The npm build pins a release URL, byte count, SHA-256 and immutable Docker image
ID in `src/local-runtime-release.ts`. It has no moving `latest` image dependency.
Runtime releases include source archives and notices separately; study users do
not download those archives. Updating a runtime requires a reviewed catalog
change and a new CLI release.

Source builders can use the
[maintained recipes](../../runtime/local-firecracker/README.md) and set
`HUMANISH_LOCAL_RUNTIME_IMAGE` to an already-built compatible local image. An
invalid override fails; it does not cause an implicit registry pull.

## Apple Silicon development candidate

The source adapter uses a dedicated `humanish-runtime` Lima/VZ host on M3 or
newer Macs, with Lima 2.2+ and macOS supporting nested virtualization. Docker
runs inside that host; Docker Desktop is unnecessary. Setup creates the host
with 6 CPUs, 8 GiB RAM and an 80 GiB growable disk. It mounts no Mac directories.
Start with two participants; larger concurrency has not been qualified by this
integration. Use Lima's normal resource configuration for subsequent capacity
experiments, without changing study concurrency behind the user's back.

The scheduler and study loop remain shared. Standard OpenSSH forwards the
browser-control Unix socket to the Mac, and the selected app port back into the
Linux host. It preserves HTTP(S)/WebSocket bytes without parsing them. Codex
runs on the Mac and retains the same separate participant/analyst profiles and
file-backed login requirement. Keychain-only authentication is not supported.

**This candidate is not a published Mac feature.** The ARM64 release catalog
remains empty until an installed Mac study passes. Development testing uses an
already-loaded image selected by `HUMANISH_LOCAL_RUNTIME_IMAGE`; it does not
silently substitute the published x64 runtime. The manually dispatched ARM64
candidate job in `browser-appliance-proof.yml` builds native images and matching
sources. It establishes compilation and packaging, not Mac execution.

Status and doctor do not create or start Lima. Explicit setup/first live use
starts the owned host; closing a study removes its participant containers and
volumes, but keeps the reusable Lima host running. Stop it with
`limactl stop humanish-runtime` when no studies are running. An interrupted
first provision remains inspectable through Lima and can be retried. Humanish
does not replace a conflicting instance or stop unrelated instances.

Mac acceptance requires the installed CLI journey, two independently verified
app saves, recordings, automatic analysis, and normal/interrupted cleanup.
Host sleep/wake and higher concurrency remain separate measured limits; this
adapter adds no suspend detector that unconditionally destroys a study.
