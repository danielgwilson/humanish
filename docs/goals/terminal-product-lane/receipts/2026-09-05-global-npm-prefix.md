# Global npm executables after stock runtime installation

Date: 2026-09-05. Fix for [issue #679](https://github.com/danielgwilson/humanish/issues/679).

The versioned Node installation introduced in #677 passed Node/npm checks but
changed npm's default global prefix to its real location under `/opt/humanish`.
Global product executables therefore landed outside the ordinary shell's PATH.
The unchanged `pnpm release:dogfood` caught the regression: retained run
`terminal-2026-09-05T03-15-04-195Z-c872fb7d` bootstrapped in 2,458ms, then failed
product setup with exit status 127 after 1,779ms, before any participant or model
call. The exact sandbox was reclaimed. Its original bundle remains unchanged.

The correction adds `prefix=/usr/local` only when the newly installed npm
distribution lacks a built-in prefix. Other file contents, existing prefixes,
and higher-priority configuration remain intact. The working-runtime fast path
does not change. No user/global npmrc, shell profile, or global permissions are
changed. npm documents the [default prefix and global executable directory](https://docs.npmjs.com/cli/v10/configuring-npm/folders#prefix-configuration)
and [built-in distributor defaults](https://docs.npmjs.com/cli/v10/configuring-npm/npmrc#built-in-config-file).

## Evidence

An offline check with the actual installed npm 11.12.1 and Node 24.12.0 reproduced
the versioned default and missing command before applying the exact prefix
configuration script. Afterward, npm reported `/usr/local`; an explicit
environment override still worked, a local project retained its own prefix, and
a synthetic package installed and executed under the override. This check made
no network or sudo calls and removed its temporary runtime afterward.

Two fresh default x64 E2B desktops then ran the exact exported bootstrap command.
Both began with no Node or npm. Each globally installed a tiny synthetic local
package with npm's offline mode and executed its binary from a separate ordinary
shell and through sudo:

| Check | Probe 1 | Probe 2 |
| --- | --- | --- |
| Stock bootstrap | 2,687ms, exit 0 | 2,694ms, exit 0 |
| Installed runtime | Node 22.23.2 / npm 10.9.8 | Node 22.23.2 / npm 10.9.8 |
| Ordinary and sudo global prefix | Both `/usr/local` | Both `/usr/local` |
| Local package global install | Exit 0 | Exit 0 |
| Ordinary and sudo binary execution | Both returned the expected marker | Both returned the expected marker |
| Repeat bootstrap | 184ms, exit 0 | 186ms, exit 0 |
| Built-in npmrc ownership/mode | root:root, 644 | root:root, 644 |
| Cleanup | Exact-id kill and not-found confirmation | Exact-id kill and not-found confirmation |

The command SHA256 was
`b4d1690186c14e9be503ea9763e6b9562111dcd23fd00cf806df05a0013a214e`.
All two probe allocations were reclaimed. Neither called a model; E2B charges
remain unknown. The earlier failed dogfood allocation was also reclaimed.

Focused tests exercise the actual configuration script for missing files,
preserving existing settings and prefixes, commented examples, and repeat calls.
The original checksum, prerequisite, architecture, network failure, and no-mutation
fast-path tests remain in place. No live arm64 desktop or custom-template PATH
was tested. These probes prove global command availability after stock setup;
the complete unchanged release dogfood remains the gate for the candidate's
first-use journey.
