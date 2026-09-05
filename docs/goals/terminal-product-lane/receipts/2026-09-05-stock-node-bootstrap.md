# Stock terminal runtime bootstrap

Date: 2026-09-05. Fix for [issue #674](https://github.com/danielgwilson/humanish/issues/674).

The unmodified release dogfood gate failed before its participant could start:
`terminal-2026-09-05T02-33-30-831Z-994e29e1` reached the Node/npm bootstrap deadline
in 300,004ms. The original bundle was retained. It recorded no model usage, and
exact-id cleanup confirmed the sandbox no longer existed.

The old bootstrap refreshed every apt repository before installing Node. Earlier
stock probes timed out on an Ubuntu HTTP mirror while unrelated HTTPS endpoints
worked; the later probe reached both HTTP and HTTPS mirrors successfully. Those
observations varied over time. The replacement removes the full repository
refresh from this runtime prerequisite.

The normal command now reuses working Node >=20/npm or downloads the official
Node 22.23.2 Linux archive over verified HTTPS. It checks a trusted SHA256 pinned
in source before privileged extraction. The [official release table](https://nodejs.org/en/about/previous-releases)
listed Node 22 as LTS when checked; x64 and arm64 hashes were read from the
[versioned release manifest](https://nodejs.org/dist/v22.23.2/SHASUMS256.txt).

## Live stock-desktop proof

Four serial bootstrap-only SDK probes used fresh default desktops with no Node
or npm installed. No model was called. The first two installed successfully in
2.260s and 2.333s and passed ordinary/sudo version checks. Their repeat invocations
exposed a second problem: an explicit `exit 0` under `set -e` ran the stock login
shell's `clear_console -q` logout hook, which returned an error and changed the
command outcome to exit 1. A retained trace showed this exact sequence.

The corrected fast path finishes its conditional naturally. Two further fresh
stock desktops ran the exact exported command:

| Probe | Initial installation | Repeat fast path | Ordinary and sudo Node/npm | Cleanup |
| --- | --- | --- | --- | --- |
| 3 | 2,585ms, exit 0 | 251ms, exit 0 | Node 22.23.2 / npm 10.9.8 | Exact-id kill and not-found confirmation |
| 4 | 2,618ms, exit 0 | 183ms, exit 0 | Node 22.23.2 / npm 10.9.8 | Exact-id kill and not-found confirmation |

Both installed binaries were root-owned with mode 755. No global permission or
shell-startup-file changes were made. All four probe sandboxes were reclaimed by
exact id. Their E2B charges remain unknown; model calls were zero.

The corrected command SHA256 was
`f9ae0c883fadf0d033dd4b2b136850dc83e5c8e06a2875b35fa2c04f0417dbd7`.
These probes establish the x64 runtime prerequisite, including the existing
installation path. They do not establish a completed release participant journey;
the unmodified candidate dogfood gate remains the release check for that path.
Arm64 archive selection and its pinned checksum are covered by local tests; no
live arm64 desktop was tested.

Focused shell tests run the actual command and prove that corrupt archives,
missing prerequisites, unsupported architectures, and network failures stop
before privilege or extraction. The existing-runtime tests preserve a working
installation without network or mutation and avoid an explicit successful exit.
A separate real local login-shell check reproduced exit 1 before the correction
and exit 0 after it without changing the user's home or profile files.
