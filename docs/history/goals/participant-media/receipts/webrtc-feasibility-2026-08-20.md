# A participant can hold a video session: an E2B substrate probe, 2026-08-20

Before designing a media capability, the question was whether the substrate carries one at
all. Four things had to be true and none of them were known: that UDP leaves an E2B sandbox,
that a synthetic camera can be presented to `getUserMedia`, that the browser's own permission
gate stays real and navigable, and that two sandboxes can exchange live media. All four now
have receipts.

**What this is NOT:** not a humanish run. No lab manifest, no run bundle, no `verify`, no
actor and no model. Five E2B sandboxes were driven directly through the SDK to answer a
substrate question that must be settled before any of this becomes a lab route. Nothing here
proves a humanish mechanism; it proves the ground a mechanism could stand on.

**Probe date:** 2026-08-20 · **Written:** 2026-08-22 · **Source tree:** `0.56.0`
**Cost:** five sandboxes, each under ~80s wall clock, well under $1 total
**Artifacts:** raw output below; screenshots held outside the repo (probe scratch, not evidence-of-record)

## What was proven

### 1. UDP egresses, and the NAT is the forgiving kind

A STUN binding probe from inside a stock sandbox, one socket to three servers, comparing the
mapped port each returned:

```json
{ "udpEgress": true, "serversAnswered": "3/3", "mappedPorts": [55261],
  "natVerdict": "ENDPOINT-INDEPENDENT (cone)", "portPreserved": true }
```

One mapped port across three distinct servers, equal to the local port. That is
endpoint-independent mapping: peer-to-peer works and TURN is a fallback, not a requirement.
This was the question that could have ended the whole line of work.

### 2. A declared synthetic camera reaches the page

Headed Chrome on the stock desktop template, `--use-fake-device-for-media-stream` with a Y4M
generated in-sandbox by the image's own `ffmpeg`. The page read back:

```
getUserMedia: OK
  video track: "/tmp/probe/humanish.y4m" 640x480@25fps
  audio track: "Fake Default Audio Input"
ICE candidate types: host, srflx
```

Chrome names the track after the file it was fed. `srflx` means the browser reached the
public internet over UDP and learned its reflexive address — the browser-level confirmation
of finding 1.

### 3. The permission gate stays real

With no auto-accept flag, Chrome raised its ordinary camera/microphone dialog: a live preview
of the synthetic feed, a device picker naming the Y4M, and `Allow while visiting the site` /
`Allow this time` / `Never allow`. `getUserMedia` blocked until answered.

This matters more than the capability. The gate is where a real person hesitates, picks the
wrong device, or refuses — and it survives intact, which means it can be studied rather than
stepped over.

### 4. Two sandboxes, live media both ways

Two desktops, distinct synthetic cameras, a signaling exchange over an E2B public URL, and a
plain `RTCPeerConnection` on each side. No vendor SDK, no conferencing service, no account.
Both peers, sampled every 8s for 56s:

```
t+8s   A: rtc-a-connected-remote:640x480   B: rtc-b-connected-remote:640x480
...
t+56s  A: rtc-a-connected-remote:640x480   B: rtc-b-connected-remote:640x480
```

Each side reported `connected` and a 640x480 remote track for the life of the probe, and each
screen rendered the other's feed. Two hosted participants can see each other.

## What was NOT proven

- **Nothing through an SFU.** A public conferencing service was attempted and refused the
  join for its own account reasons — a vendor policy, not a substrate limit. The finding
  stands as peer-to-peer only. An SFU is a server with a public address and should be an
  easier case than the one that passed, but that is an argument, not a receipt.
- **Nothing sustained.** The longest observation was 56 seconds. Multi-minute call quality,
  CPU behaviour under encode load, and 3+ participants in one session are all untested.
- **No audio on the honest path.** See constraint 1.

## Constraints the probe found

1. **The stock desktop template has no audio stack.** With the real permission dialog, Chrome
   enumerates `Use available microphones (0)` and reports `No microphone available` — there is
   no ALSA or PulseAudio in the image, so nothing enumerates. Video is unaffected. Audio
   appears only when the auto-accept flag bypasses enumeration entirely. A participant that
   must both face a real permission prompt and speak needs a custom template
   (`execution.desktop.template`, `src/e2b-desktop-launch.ts:186`).

   The failure mode this creates is the dangerous one: a participant meeting "no microphone
   available" will report it, and a limitation of the instrument becomes a finding about the
   product — the category error `docs/principles/three-roles.md` exists to prevent.

2. **`--use-fake-ui-for-media-stream` paints a warning banner** across the top of every frame
   ("You are using an unsupported command-line flag"). Two runs minutes apart on the same
   image are the control: the auto-accept run carried it, the real-prompt run did not. It is
   cosmetic, it is confined to that one flag, and it argues for the honest path on evidence
   grounds alone. A Chrome managed-policy file suppresses it if a fast lane ever needs the
   shortcut — the same seam shape as the profile preferences
   `src/browser-evidence-hygiene.ts` already writes.

3. **The stock template still has no Node**, which is closed for subject pipelines
   (`nodeBootstrapCommand`, `src/subject-runtime.ts:42`) but not for anything else. The
   probe's first signaling server died on `failed to run command 'node'` and was rewritten in
   Python. Any in-sandbox helper must be Python, a static binary, or sequenced after the
   bootstrap — the same lesson the comms catch learned in `0.29.0`.

## What this implies

- The capability is **media devices on a hosted desktop**, not support for any conferencing
  product. It was proven with no vendor in the path at all, which is the strongest available
  evidence that it will not overfit to one.
- **Video works on the stock template today.** Audio should be an opt-in upgrade, never a
  prerequisite, or first contact acquires a template-building step.
- The gap that surfaced is not media at all: there is no way to say **"stay here and keep
  watching for a while."** `stopWhen` matches state; nothing expresses elapsed time. A
  freeform participant with nothing to do keeps acting, which in a call means clicking mute,
  settings, or leave — and paying a model turn for each. Related: #480.

## Reproduction

The probe scripts are deliberately not committed — they are throwaway substrate tests, not
harness code. Each step is small enough to restate: a STUN binding request over `dgram`; a
Chrome launch with `--use-fake-device-for-media-stream` and
`--use-file-for-fake-video-capture` pointed at an `ffmpeg`-generated Y4M; a Python signaling
exchange over an E2B public URL with a `RTCPeerConnection` on each side.
