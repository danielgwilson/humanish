# E2B speech template

E2B speech uses the same guest media worker, PulseAudio devices, synthetic
`espeak-ng` voice, and offline `whisper.cpp` model as the local Linux media
runtime. It extends E2B's maintained `desktop` template; the default browser
template remains unchanged.

From a source checkout, build Humanish and then build a private E2B template:

```sh
pnpm build
node runtime/browser-media/e2b-template.mjs humanish-browser-media
```

The streaming worker was checked with `@e2b/desktop` 2.4.0. The E2B SDK reads `E2B_API_KEY`. The recipe downloads fixed Node, whisper.cpp,
and Whisper model revisions, verifies every digest, retains the upstream
licenses and model card, and builds a 4-vCPU/4-GiB template. Select the returned
template name or ID with `execution.desktop.template` and request
`media.microphone.source: speech`.

The recipe deliberately stages build inputs under `/opt/humanish/build` rather
than `/tmp`: E2B can clean `/tmp` between cached Build System 2.0 layers. It
does not publish the template. A maintainer can publish a qualified build with
E2B's `template publish` command; publishing requires a separate cross-account
launch check before Humanish can use that template as a default.
