# Optional Linux desktop media layer

This opt-in image extends the maintained browser guest with a synthetic V4L2
camera, PulseAudio devices, `espeak-ng` speech, and offline `whisper.cpp`
transcription. The default browser image is unchanged. Speech audio stays in
memory and is not added to run evidence. The synthetic voice is intentionally
robotic; this image needs a received-word acceptance test before release.

`fetch.py` acquires fixed source/model bytes. `build.py` requires a matching
browser build receipt and the compiled `dist/guest-media-worker.js`. The image
label `to.humanish.runtime.media=1` is the capability gate. The whisper source
license and pinned model card are retained in `/opt/humanish/media`.
The media input directory retains the pinned whisper and V4L2 source archives;
the guest also carries both upstream licenses for redistribution review.
