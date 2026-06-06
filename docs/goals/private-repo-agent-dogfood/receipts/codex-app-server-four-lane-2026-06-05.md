# Codex App-Server Four-Lane Receipt: 2026-06-05

## Scope

This receipt covers the first headed four-lane dogfood run where each redacted
lane used Codex app-server mode as the coding-agent actor surface. The target
repos are intentionally recorded only as `repo-01` through `repo-04`.

The run objective was to verify that Mimetic can watch agents use Mimetic:
each disposable desktop should run a target app, set up app-aware Mimetic
source, run nested Mimetic proof, expose a nested Observer, and persist
public-safe Codex app-server actor evidence.

## Implementation Delta

- Added `completion.meaningfulUse` with a 100-point setup/evidence/actor/product
  surface/feedback rubric.
- Added first-class setup-quality filesystem evidence into the score path.
- Added Codex app-server trace, event, and transcript artifact links to live
  stream artifacts.
- Added public-safe `cwd: "[target-cwd]"` projection and remote-path redaction
  for durable run bundles.
- Added local nested-proof evidence files so public bundles keep proof refs
  without preserving remote sandbox paths.
- Added app-server running heartbeats so active lanes expose actor liveness
  before final summaries are persisted.
- Added Observer rendering for meaningful-use score cards and compact score
  chips.
- Added live-refresh cleanup that can kill in-memory E2B desktop ids even when
  redacted public results omit provider ids.

## Run Evidence

- run: `oss-meta-2026-06-06T00-02-41-550Z-8e6e93f4`
- observer:
  `.mimetic/runs/oss-meta-2026-06-06T00-02-41-550Z-8e6e93f4/observer/index.html`
- bundle:
  `.mimetic/runs/oss-meta-2026-06-06T00-02-41-550Z-8e6e93f4/run.json`
- verification:
  `pnpm mimetic -- verify --run oss-meta-2026-06-06T00-02-41-550Z-8e6e93f4 --json`
  passed all checks.

The verified run bundle readback showed:

- durable bundle `cwd` is projected as `"[target-cwd]"`;
- `4/4` redacted lanes passed;
- `4/4` actor statuses passed;
- `4/4` target app surfaces were running;
- `4/4` local nested-proof files showed nested Mimetic verification passed;
- `4/4` local nested-proof files showed nested Observers were present;
- `4/4` headed visual layouts were visible;
- `4/4` meaningful-use scores were `pass 100/100`;
- `4/4` setup-quality ratings were `high_leverage`;
- `4/4` lanes recorded app-url proof, actor insight, app-aware coverage,
  app-specific personas, and app-specific scenarios.

## Codex App-Server Telemetry

Each lane persisted redacted app-server artifacts:

```text
.mimetic/runs/oss-meta-2026-06-06T00-02-41-550Z-8e6e93f4/codex-app-server/oss-01-desktop-summary.json
.mimetic/runs/oss-meta-2026-06-06T00-02-41-550Z-8e6e93f4/codex-app-server/oss-01-desktop-events.ndjson
.mimetic/runs/oss-meta-2026-06-06T00-02-41-550Z-8e6e93f4/codex-app-server/oss-01-desktop-transcript.txt
```

The same artifact pattern exists for `oss-02-desktop`, `oss-03-desktop`, and
`oss-04-desktop`.

Per-lane projected app-server summary counts:

| Lane | Status | Envelopes | Messages | Command outputs | File changes | Warnings |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| repo-01 | passed | 1580 | 1306 | 13 | 6 | 0 |
| repo-02 | passed | 1665 | 1376 | 18 | 12 | 0 |
| repo-03 | passed | 1318 | 1107 | 12 | 4 | 0 |
| repo-04 | passed | 1819 | 1537 | 15 | 4 | 0 |

These counts are from redacted projected app-server summaries, not raw private
transcript dumps.

## Verification Commands

```bash
pnpm vitest run tests/oss-lab.test.ts tests/run.test.ts tests/oss-remote-telemetry.test.ts
pnpm mimetic -- verify --run oss-meta-2026-06-06T00-02-41-550Z-8e6e93f4 --json
pnpm release:check
```

Results:

- focused tests passed: `3` files, `67` tests;
- exact run verification passed with `codex app-server evidence` and
  `local evidence artifacts exist`;
- release check passed: typecheck, `18` test files / `138` tests, build,
  public-surface scan, skill check, and npm pack dry run.

## Cleanup Readback

After stopping the headed watcher, explicit E2B SDK cleanup found stale
Mimetic OSS meta-lab desktops from interrupted candidate runs, killed `14`
provider sandboxes, and a final provider readback found `0` active sandboxes.
No provider sandbox ids, stream auth URLs, token values, private repo labels,
screenshots, raw private transcripts, PII, PHI, or source snippets are recorded
in this receipt.

## Remaining Gaps

- The current run proves setup, nested app-url proof, app-server telemetry, and
  Observer evidence across four redacted repos. It does not yet prove a fully
  general provider-backed multi-step browser persona engine independent of the
  nested app-url proof mode.
- Cleanup must be hardened so Ctrl-C through package-manager wrappers reliably
  closes live provider sessions without requiring manual SDK cleanup; tracked
  in GitHub issue #99.
- The Observer should continue improving app-server transcript browsing,
  file-tree inspection, and side-panel ergonomics, but those are product
  polish/follow-up gaps rather than blockers for this receipt.
