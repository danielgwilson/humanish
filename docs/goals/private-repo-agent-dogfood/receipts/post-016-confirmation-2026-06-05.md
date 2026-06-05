# Post-0.1.6 Confirmation Receipt: 2026-06-05

## Scope

This receipt covers the confirmatory four-lane dogfood run after PR #91 merged
and `mimetic-cli@0.1.6` published. Repo labels remain redacted as `repo-01`
through `repo-04`.

The run used four lanes because four authorized repos were assigned. There is no
arbitrary run-count cap or desktop-count cap in this goal packet.

## Release Proof Before Rerun

- main merge commit: `770d952`;
- publish workflow: `27026709790`, conclusion `success`;
- npm metadata: `latest: 0.1.6`;
- explicit registry install of `mimetic-cli@0.1.6` exposed `run --app-url` and
  did not show stale `1-4 lanes` help text;
- `mimetic-cli@latest --prefer-online` installed `0.1.6` and showed the same
  help behavior.

## Run Evidence

- run: `oss-meta-2026-06-05T16-25-58-003Z-515846ab`
- mode: `live`
- verification:
  `pnpm mimetic -- verify --run oss-meta-2026-06-05T16-25-58-003Z-515846ab --json`
  passed all checks.

The live bundle readback showed:

- `4/4` top-level lane statuses passed;
- `4/4` target app surfaces running;
- `4/4` nested Mimetic verifications passed;
- `4/4` nested Observers present;
- `4/4` headed desktop visual layouts visible;
- `0` feedback candidates.

## Study-Quality Readback

All four lanes produced app-aware setup-quality evidence.

| Lane | Rating | Signals | App-url proof |
| --- | --- | --- | --- |
| `repo-01` | `high_leverage` | 5/5 | succeeded |
| `repo-02` | `high_leverage` | 5/5 | succeeded |
| `repo-03` | `high_leverage` | 5/5 | succeeded |
| `repo-04` | `high_leverage` | 5/5 | succeeded |

This confirms the stale bare-`npx mimetic` command-resolution failure observed
in the previous run was fixed by forcing actor/bootstrap commands through the
locally installed `mimetic-cli` binary.

## Public-Safety And Cleanup

Run verification passed the public-safety scan. A targeted ignored-artifact grep
over the run found no private repo labels, no E2B stream URLs, no sandbox ID
keys, and no credential assignments.

Provider cleanup after the run found `4` running Mimetic OSS meta-lab desktops,
killed `4/4`, reported `0` cleanup errors, and post-cleanup readback found `0`
matching desktops.

## Remaining Gap

The dogfood loop is now past setup ceremony and stale binary resolution. The
next product gap is stronger provider-backed browser personas that drive
multi-step target-app journeys and produce interaction-level feedback, not only
app-url render proof plus app-aware setup-quality evidence.

No sandbox IDs, stream auth URLs, provider account identifiers, private repo
labels, screenshots, raw transcripts, source snippets, token values, PII, or PHI
are recorded in this receipt.
