# Optional participant media

Media belongs to the desktop. The participant still navigates through screenshots
and the shared computer-use loop, using one continuing Codex conversation for
clicks, listening and spoken replies.

```yaml
actors:
  - type: local-agent
    localAgent: codex
execution:
  target: local
  desktop:
    media:
      camera: { source: synthetic }
      microphone: { source: speech }
policies:
  mediaPermission: prompt
```

Omit `media` for ordinary browser studies. They keep the smaller browser image
and start no audio server, camera producer or speech worker. Camera and speech
can also be requested separately. Local media setup uses a separately pinned
image, prepared by the first live study or `humanish runtime setup --media`.

The local camera is an animated test pattern behind a native V4L2 device. Speech
uses a synthetic microphone and a separate speaker sink. Chromium uses its
ordinary devices and permission dialog. `mediaPermission: granted` bypasses the
dialog explicitly; it does not replace the devices.

## Speaking and listening

With speech enabled, `humanish_ui` accepts `{kind: "speak", text: "..."}` in
addition to browser actions. It plays into the microphone; the participant must
join and unmute through the app. Tool narration is never automatically spoken.
Keep each utterance within 400 characters. Playback acknowledgement establishes
local microphone input, not delivery to another caller.

The desktop captures actual speaker audio. Finalized English transcriptions
arrive as `heardSpeech` observations with an utterance ID, `speaker_audio` source
and duration. A participant can use the existing `wait` action while listening.
Hearing something counts as progress even when the screen stays unchanged.

Transcription and synthetic speech run inside the Linux desktop, without a
speech API key or a host Python installation. Codex inference still runs remotely
using the selected account. The first voice uses espeak-ng and sounds robotic;
whisper.cpp performs recognition. This is bounded turn-taking, with recognition
latency and possible transcription errors, not a streaming voice conversation
with interruption handling.

Spoken text and heard observations pass through the existing evidence redaction
before being retained in the trace. Analysis reads that evidence alongside the
recording. Raw audio is not saved by default; Observer remains a screenshot
recording with text evidence, not an audio/video call recording.

## Hosted desktops

The same worker and participant loop support speech on an explicitly prepared
E2B media template; see the [build recipe](../../runtime/browser-media/E2B.md). Select it with `execution.desktop.template`. The host starts
the worker through the SDK's streaming command interface; model credentials stay
on the host. Missing worker dependencies fail desktop preparation before a
participant starts.

Existing hosted synthetic cameras use Chromium's fake-device flags. Those flags
also replace its microphone, so hosted camera and speech cannot currently be
combined. Use a local native-media desktop for both, or a hosted audio-only
study. Microphone files and speech through other participant providers are not
supported. A template alone cannot add camera support to a kernel without V4L2.

## Runtime maintenance

`runtime/local-firecracker/build.py --media` extends the maintained browser image
with native devices and the speech worker. The published media image must carry
`to.humanish.runtime.media=1`; a cached browser image cannot satisfy a media
request. Source builds can select an already-built media image with
`HUMANISH_LOCAL_MEDIA_RUNTIME_IMAGE`.

The media worker owns its subprocesses and buffers. Failed speech recognition,
worker exit and queue overflow stop the media session instead of appearing as
successful silence. Closing the desktop stops media and reclaims its isolated
state. No conferencing vendor or room-specific behavior is implemented in core.

Retain the matching media sources and package notices when publishing runtime
assets. Pass `--media-browser` and `--media-inputs` to the existing
`runtime/local-firecracker/sources.py` collector alongside its ordinary inputs.
Hardware capacity and conferencing topology require their own measured proof;
requesting media does not qualify twenty concurrent participants or TURN.
