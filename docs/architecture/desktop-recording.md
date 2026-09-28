# Optional desktop recording

Humanish keeps screenshots, actions, participant feedback and analysis by default.
For continuous playback, opt into a desktop video:

```yaml
execution:
  desktop:
    recording: { audio: true }
```

Set `audio: false` for screen-only video. Omit `recording` to keep the lightweight
snapshot recording. This applies to independent computer-use desktop lanes on
local Firecracker and E2B; scripted-browser, shared-world and in-process executors
do not consume this setting and reject it before execution.

Recording does not enable a camera, speech synthesis or speech recognition.
Those remain separate [participant media](participant-media.md) options. With
audio enabled, microphone input and speaker output are mixed into one AAC track.
`audioSources` identifies the capture points feeding that mix, not separate
retained tracks. The microphone can be silent when speech is not configured.
A recorded microphone signal proves what was offered to the browser, not what
another person received. Confirm reciprocal delivery from the other
participant's evidence.

## Capture and playback

The desktop runs FFmpeg against its X display. MP4 carries H.264 video and optional
AAC audio. Recording stops and streams to the run directory before desktop cleanup.
Both providers use the same encoding settings and artifact metadata. Video encoding
uses the capture input’s microsecond time base, preserving closely spaced captures
and their offsets rather than rounding them to the nominal frame interval.
Explicit variable-frame-rate output preserves gaps without filling them with
duplicate frames across the supported FFmpeg versions. The recording
mix disables playback rewinds to avoid the null sink's initial two-second buffer. The local
runtime transfers one bounded file over its existing owner connection; E2B uses
the SDK's streaming file download. Participant tools cannot request arbitrary files.

Local recording uses the existing optional media runtime archive. This keeps the
browser-only download unchanged, but the optional archive also contains speech
assets even when speech is disabled. Recording alone does not start Whisper or
text-to-speech. E2B's stock desktop already has the recording dependencies; a custom
template must provide compatible FFmpeg, X11 and, for audio, PulseAudio tools.

Observer uses the existing study clock to play the selected participant's video.
Scrubbing, opening a participant and returning to the grid preserve study time.
The grid continues to show lightweight captures; only the selected participant
has audible playback. Outside the retained media interval, Observer shows that
video is unavailable rather than extending its coverage. Old screenshot-only runs
continue to work.

Capture still begins after device and transport startup. An audio track can contain
silence before a cold source delivers sound; early dispatch of speech or playback
does not itself prove audible capture. Preserve these offsets when reviewing early
events. The startup correction does not reconstruct missing frames or audio in
existing files. Variable guest execution stalls can still leave frame gaps; the
recorded timestamps preserve those gaps. A regularly timestamped video can also
show an unchanged screen while the application stalls. Visual/audio event timing
depends on source delivery and guest execution; timestamp precision does not
guarantee simultaneous delivery. See #854 for the remaining investigation.

The file and its measured interval are recorded in `streams[].recording` and a
`recording` artifact entry. A recorder failure warns and preserves screenshots,
actions and feedback; it does not fail an otherwise useful participant. Incomplete
but playable media is labeled partial. Forced VM loss may leave no retrievable
video. Analysis continues to use the existing screenshot and text evidence; it
does not inspect the MP4.

## Local evidence and exports

Video and audio are raw local evidence. `policies.redactScreenshots` does not redact
them, and verification keeps a run with continuous media `local_only`. The recorder
has a 128 MiB per-participant file limit; a retained size-limited recording is partial.
Encoding consumes additional CPU, memory and disk, so snapshots remain the default.

`humanish export --local-only` produces the existing portable HTML with screenshots
and text, excludes continuous media and displays that exclusion. Open the original
run through `humanish watch` or `humanish serve` to play its video. Redacted bundle
export does not redact video/audio and rejects these runs. There is no new portable
video format or automatic audio/video redaction in this feature.
