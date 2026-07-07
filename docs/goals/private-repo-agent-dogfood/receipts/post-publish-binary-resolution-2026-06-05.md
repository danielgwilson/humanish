# Post-Publish Binary Resolution Receipt: 2026-06-05

## Scope

This receipt covers the first full dogfood rerun after `homun@0.1.5`
published to npm. Repo labels remain redacted as `repo-01` through `repo-04`.

The run used four lanes because four authorized repos were assigned. There is no
arbitrary run-count cap or desktop-count cap in this goal packet.

## Preflight

- provider readback before launch: `0` matching running desktops;
- npm latest version before launch: `0.1.5`;
- credentials were loaded from an ignored env file without printing values;
- command used redacted repo output and detached headed Observer mode.

## Run Evidence

- run: `oss-meta-2026-06-05T16-07-27-703Z-1ce7e253`
- mode: `live`
- verification:
  `pnpm homun -- verify --run oss-meta-2026-06-05T16-07-27-703Z-1ce7e253 --json`
  passed all checks.

The live bundle readback showed:

- `4/4` top-level lane statuses passed;
- `4/4` target app surfaces running;
- `4/4` nested Homun verifications passed;
- `4/4` nested Observers present;
- `4/4` headed desktop visual layouts visible.

## Study-Quality Readback

All four lanes produced app-aware setup-quality evidence.

| Lane | Rating | Signals | App-url proof |
| --- | --- | --- | --- |
| `repo-01` | `high_leverage` | 5/5 | succeeded |
| `repo-02` | `high_leverage` | 5/5 | succeeded |
| `repo-03` | `high_leverage` | 4/5 | blocked |
| `repo-04` | `high_leverage` | 5/5 | succeeded |

The remaining blocker was not that `0.1.5` lacked `run --app-url` globally.
The failing lane used a bare `npx homun` command path and reported a stale or
wrong binary that did not expose `--app-url`. The durable fix is to make the
meta-lab actor/bootstrap path use the locally installed `homun` binary:
`npx --no-install homun ...`, with explicit package fallback only for
one-shot proof commands.

## Feedback Candidates

The rerun generated one remaining Homun-owned feedback candidate:

- `published-cli-app-url-oss-03-desktop`.

That candidate is classified as `harness` owner, `adapter-hardening` next state.

## Public-Safety And Cleanup

Artifact scan over the ignored run directory checked `18` text files and found:

- private repo term hits: `0`;
- stream URL hits: `0`;
- sandbox ID key hits: `0`.

Provider cleanup after the run found `4` running Homun OSS meta-lab desktops,
killed `4/4`, reported `0` cleanup errors, and post-cleanup readback found `0`
matching desktops.

## Branch Fix

The current branch prepares `0.1.6` and hardens meta-lab command resolution:

- actor instructions identify package `homun` and binary `homun`;
- actor and deterministic bootstrap commands use `npx --no-install homun`;
- one-shot package proof uses `npx --yes --package homun@latest homun`;
- feedback acceptance proof is non-interactive;
- OSS lab tests assert the local-bin command path.

`pnpm release:check` passed for `0.1.6`: typecheck, 17 test files / 120 tests,
build, public-surface scan, skill check, and npm pack dry run.

No sandbox IDs, stream auth URLs, provider account identifiers, private repo
labels, screenshots, raw transcripts, source snippets, token values, PII, or PHI
are recorded in this receipt.
