# Headed guest driver: scoped development proof

Date: 2026-09-23. Issue: [#812](https://github.com/danielgwilson/humanish/issues/812).

The internal guest driver passed 17 actual headed-Chromium cases on amd64. This
establishes bounded browser input and capture in the development image. It does
not establish Firecracker boot, an installed runtime, or a participant study.

## Retained identities

- Final run: `2026-09-23T11-10-45.094Z-f6c5f8b0-adcc-4a07-bfd3-88edbf75ed4d`.
- Receipt SHA-256: `21f50f3d0172762e5eff7807e9d563ce14a2f512153c28ea20ac739e87e90aa9`.
- Image: `sha256:0c83ec3d8027bebef490767caa5a9ba6de064760f7f10c49189f886c19256df8`.
- Rootfs tar SHA-256: `a050d105007679aaf9f0e8e2a2eaa2fb48d91d5825dff59b78f39d2264f11334`.
- Chromium: `153.0.8010.52`; authenticated Xvfb frame: `960 × 720`.
- The receipt binds 13 source/configuration files and all copied executable
  payload files. Retained output includes the gallery, raw structured result,
  screenshots, sandbox readback and cleanup result.

Generated proof is retained outside committed source. CI reproduces the proof
and uploads its synthetic receipt and screenshots for relevant changes.

## Observed results

| Cases | Result |
| --- | --- |
| Native address-bar navigation | Correct synthetic destination; browser chrome visible. |
| Unicode, rapid consecutive text, stalled renderer, large multiline text | Exact field readback, including CJK, Korean, combining characters, emoji, literal tabs/newlines and 7,029-byte input. The stalled renderer resumed before insertion. |
| Cancellation after preparation | No insertion; prior field contents preserved. |
| Page replaces its focus prototype | Isolated-world probe remains effective; exact text readback. |
| Unsupported address-bar characters, additional tab, iframe, navigation after preparation, modal dialog | Refused before text insertion; unrelated fields retained their contents. |
| Native click, double click/drag, wheel scroll | Full-frame coordinates match actual app events. The fixture's Save handler records the exact text. |
| Invalid key and revoked drag | Invalid key sends no input; revocation sends no later release/drop. |

Independent review inspected the driver, lifecycle changes, image inventory,
receipt and rendered Unicode/Save screenshots. Earlier native Unicode typing
and one-transfer clipboard implementations failed browser readback; those
attempts are retained and excluded from the implementation.

The container used no network, host mounts, host devices or privileged mode.
Chromium reported PID/network namespaces and seccomp-BPF enabled. The
hash-pinned Playwright 1.60.0 Docker seccomp profile permits its sandbox's user
namespace calls; default Docker seccomp had refused startup. The proof did not
disable Chromium's sandbox. Browser/display cleanup passed, and the acquired
container was confirmed absent.

The maintained Debian recipe built 317 packages with verified binary archives,
signed APT provenance, source-package references and copyright notices. Full
matching source archives remain unmirrored; image redistribution is not approved
by this receipt. The builder used an existing rootful Docker daemon.

## Qualification limits

One owner-acquired page/window, top-level editable content, and printable ASCII
address-bar entry after explicit Ctrl+L are supported by this driver. Web text
uses fixed browser text insertion; shortcuts and pointer actions remain native.
Focus checks and dispatch are separate operations, not atomic element binding.
Additional tabs, iframe text and dialogs require further work before broader
runtime qualification. Tool acknowledgement never substitutes for app outcome
evidence.

Native ARM64, kernel/controller integration, VM ownership, independent watchdogs,
host sleep/resume, egress, setup, model participants, media, and complete
Linux/Mac installed studies remain unqualified. No public local-runtime selector
or new telemetry is enabled by this change.
