# A participant with a camera, live (#509, first slice)

**2026-09-04, two runs on stock E2B desktops, $0.07 in all.** The lab is
`humanish/labs/participant-camera.yaml` (committed dry-run; run live with `scenario.mode: live`)
over `bench/media-check/index.html`: one button that calls `getUserMedia({ video: true })` and
prints the track's label and frame size under a `<video>`. The lane declares

```yaml
execution:
  desktop:
    browser: chrome
    media:
      camera:
        source: synthetic
```

and the mission asks the participant to turn the camera on, allow the browser's request for this
visit if one appears, and report what the page says. The feed is ffmpeg's test pattern, generated
in the sandbox before Chrome starts (`/dev/shm/humanish-media/camera.y4m`, 640x480 at 10 fps, six
seconds, looped by Chrome's fake capture device).

## The permission gate stays real: `cua-2026-09-04T20-49-04-436Z-c5e0e7a3` ($0.04)

`policies.mediaPermission` left at its default, `prompt`.

| turn | what happened |
|---|---|
| 1 | the participant clicked "Turn on camera" |
| 2 | Chrome raised its own dialog: "http://127.0.0.1:8000 wants to: Use available cameras (1)", a live preview of the test pattern, the device picker naming the Y4M, and Allow while visiting the site / Allow this time / Never allow (`screenshots/turn-02.png`) |
| 3 | the participant chose "Allow this time"; the page read back the camera |

The participant's own account: "I clicked “Turn on camera” and chose “Allow this time.” Camera
name: `/dev/shm/humanish-media/camera.y4m`. Size: `640x480`. Nothing was confusing; I only briefly
hesitated between the two permission options before selecting the one limited to this visit."
Declared task `camera-on` (page text "Camera: on.") measured complete. Chrome names the fake device
after the file it was fed, so the page's "camera name" is the feed's path; a `.y4m` of the
adopter's own would carry its own name.

## The gate bypassed: `cua-2026-09-04T20-49-44-273Z-9d457120` ($0.02)

`policies.mediaPermission: granted` adds `--use-fake-ui-for-media-stream`. "I clicked “Turn on
camera”; no permission prompt appeared. Camera name: `/dev/shm/humanish-media/camera.y4m`. Size:
`640x480`." Three turns, one action.

## What the bundle records

`desktopBrowser.media` on both runs:

```json
{ "camera": { "source": "synthetic", "file": "/dev/shm/humanish-media/camera.y4m" },
  "permission": "prompt",
  "flags": ["--use-fake-device-for-media-stream", "--use-file-for-fake-video-capture=/dev/shm/humanish-media/camera.y4m"] }
```

with `"permission": "granted"` and the extra `--use-fake-ui-for-media-stream` flag on the second.
The feed lives on the sandbox's tmpfs rather than under `/tmp` because the public-safety scan
reads any `/tmp/` or `/home/` path as an operator's local path; this one is the harness's own and
belongs in the bundle.

## What this slice does not do

- A microphone. The stock desktop image has no audio stack (the 2026-08-20 probe: Chrome
  enumerates no microphone on the honest path), so `media.microphone` without
  `execution.desktop.template` is refused at parse time, before any spend. Audio is an opt-in
  upgrade on a custom image, never a prerequisite.
- A real conferencing product. The environment property is proven against `getUserMedia` on a
  page we wrote, with no vendor in the path, which is the point: it will not overfit to one.
- The shared-world routes; the option is wired on the computer-use route.
