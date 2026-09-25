# Local browser studies

Linux x64 and supported Apple Silicon Mac users can run isolated Firecracker
browser participants from the installed CLI or TUI. Docker manages their
containers and private state volumes; the normal study runner supplies
scheduling, recordings, Observer and findings.
No separate host service is installed.

## Start a study

Both platforms need a signed-in, supported Codex CLI. Linux needs a local,
rootful Docker Engine, KVM (`/dev/kvm`) and TUN (`/dev/net/tun`). Macs need an
M3-or-newer chip, native ARM64 Node, Lima 2.2+ (`brew install lima`) and a macOS
version supporting nested virtualization; see [Mac setup](#apple-silicon-macs).
Docker Desktop is unnecessary. See
[Codex account setup](restricted-codex-analysis.md) for the qualified version
and account restrictions. Docker access is an administrative capability.
Humanish does not install Docker on Linux or change host permissions. On Mac,
setup installs Docker only inside the dedicated Lima host.

Configure the starter while initializing the project, then start your app on
the same loopback URL:

```sh
npx humanish init --yes \
  --local-browser http://127.0.0.1:3000 \
  --local-mission "Create a note and explain anything confusing about saving it"
npx humanish doctor --lab local-browser
npx humanish lab run local-browser
```

`init` also writes `humanish/labs/local-browser.yaml` with safe defaults when
the two options are omitted. The options provide the normal setup path for the
app URL and mission on first setup. If the file already exists, `init` preserves
it and warns that these options were skipped; edit the existing manifest to
change its URL or mission. The resulting lab has this shape:

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
npx humanish runtime status --json
npx humanish doctor --lab local-browser --json
npx humanish lab run local-browser
```

The first live run downloads the pinned runtime archive (about 569 MiB on x64 or
556 MiB on ARM64), verifies its exact size and SHA-256, and loads it into Docker.
Later runs reuse the image.
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

Before handing the desktop to the participant, the guest navigates to the
selected app and waits up to 30 seconds for the initial document's
`DOMContentLoaded` event, then allows a bounded paint. It does not wait for app
data, images or network idle: the app's own loading screen remains observable.
Navigation failures and timeouts fail startup and release the owned desktop.
Later participant actions and observations do not use this startup wait.

## Current limits

- Linux x64 or M3-or-newer Mac with native ARM64 Node and Lima. The installed
  Mac journey was tested on an M5 Max; smaller machines are not capacity-qualified.
- On Linux, a local Docker Engine; remote contexts, rootless Docker and Docker
  Desktop are unsupported. The Mac adapter uses Docker inside its own Lima host.
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

Normal close and cooperative startup cancellation remove the owned container
and its private state volume. After a desktop connects, controller death
disconnects the guest, which reboots; Firecracker exits and Docker removes both.
A small host socket directory can remain after abrupt death.
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

## Apple Silicon Macs

The Mac adapter uses a dedicated `humanish-runtime` Lima/VZ host on M3 or
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

The installed CLI passed first-attempt public image setup and two-participant
studies on an M5 Max: distinct app-side saves, overlapping participants,
verified recordings and automatic account analysis. A fresh Lima instance used
the public ARM64 catalog without a development image override. The separately
available source archives match that native build. The manually dispatched ARM64
job in `browser-appliance-proof.yml` builds images and sources; compilation alone
does not establish Mac execution.

Status and doctor do not create or start Lima. Explicit setup/first live use
starts the owned host; closing a study removes its participant containers and
volumes, but keeps the reusable Lima host running. Stop it with
`limactl stop humanish-runtime` when no studies are running. An interrupted
first provision remains inspectable through Lima and can be retried. Humanish
does not replace a conflicting instance or stop unrelated instances.

Normal close, cancellation and controller death were exercised on established
Mac desktops. Shared startup cancellation and interrupted create-reply recovery
were exercised against real Linux Docker/Firecracker, with a separate regression
check for Lima cleanup. Forced controller death during startup, full-study
cancellation, host sleep/wake and higher concurrency remain unqualified. A forced
kill before a desktop connects can leave resources requiring inspection; this
adapter adds no suspend detector that unconditionally destroys a study.
