# Meaningful Loop Receipt: 2026-06-05

## Scope

This receipt covers the follow-up observe -> improve -> observe loop after the
first formal private-repo dogfood run showed most lanes were setup-complete but
ceremonial. Repo labels remain redacted as `repo-01` through `repo-04`.

This run used four lanes because four authorized repos were assigned. There is
no arbitrary run-count cap or desktop-count cap in this goal packet.

## Improvements Before Rerun

- Hardened the remote actor prompt to require app-aware coverage maps,
  coverage matrices, personas, desktop/mobile scenarios, and explicit product
  friction or `none observed`.
- Added `studyQuality` telemetry for setup snapshots, including structural
  signals for coverage customization, persona customization, scenario
  customization, actor insight, and app-url proof state.
- Added feedback candidates for absent or ceremonial study quality.
- Split app-url proof into honest proof versus blocked proof, so mentioning
  `--app-url` no longer counts as successful app proof.
- Made app-url blocker detection tolerate markdown such as `does **not**
  expose --app-url`.
- Tightened redacted-run persistence so private repo names are scrubbed from
  actor tails and setup-quality artifacts.
- Hid provider sandbox IDs from `--redact-repos --json` results.
- Removed the hidden max-desktop-cap rail from goal docs and state. Spend
  control is dollar, wall-clock, timeout, cleanup/readback, and public-safety
  gates.

## Run Evidence

- run: `oss-meta-2026-06-05T08-00-44-050Z-c8e0daeb`
- mode: `live`
- observer:
  `.homun/runs/oss-meta-2026-06-05T08-00-44-050Z-c8e0daeb/observer/index.html`
- bundle:
  `.homun/runs/oss-meta-2026-06-05T08-00-44-050Z-c8e0daeb/run.json`
- verification:
  `pnpm homun -- verify --run oss-meta-2026-06-05T08-00-44-050Z-c8e0daeb --json`
  passed all checks.

The live JSON result showed:

- `4/4` redacted assignments;
- `4/4` actors passed;
- `4/4` target app surfaces running;
- `4/4` headed desktop visual layouts visible;
- no provider sandbox IDs in the redacted JSON result.

## Study-Quality Readback

Setup-quality artifact readback found all four lanes at:

- setup status: `passed`;
- study rating: `high_leverage`;
- app-url proof check: `false`;
- app-url proof detail: actor evidence reports that app-url proof was blocked;
- signals:
  - `appUrlProofBlocked: true`;
  - `appUrlProofMentioned: false`;
  - `actorInsightCaptured: true`;
  - `coverageCustomized: true`;
  - `personaCustomized: true`;
  - `scenarioCustomized: true`.

This is a good result, not a fully green platform result: the actors moved
beyond ceremonial setup into app-aware study design and feedback, but they also
found that the currently published install path is behind the source branch.

## Feedback Candidates

The rerun generated four Homun-owned feedback candidates:

- `published-cli-app-url-oss-01-desktop`;
- `published-cli-app-url-oss-02-desktop`;
- `published-cli-app-url-oss-03-desktop`;
- `published-cli-app-url-oss-04-desktop`.

All four are classified as `harness` owner, `adapter-hardening` next state, with
summary `Published Homun install path blocked app-url proof`.

## Public-Safety And Cleanup

Artifact scan over the ignored run directory checked `18` text files and found:

- private repo term hits: `0`;
- stream URL hits: `0`;
- sandbox ID key hits: `0`.

Provider cleanup after the run found `4` running Homun OSS meta-lab desktops,
killed `4/4`, reported `0` cleanup errors, and post-cleanup readback found `0`
matching desktops.

## Release Follow-Up

The dogfood loop found a real external blocker: published
`homun@0.1.4` does not yet expose the branch `run --app-url` path and
still advertises an older lane-count constraint. The current branch bumps the
package to `0.1.5` and updates package/skill docs so the next publish can make
the consumer path match source truth.

Consumer install proof from a locally packed `0.1.5` tarball passed:

- installed package version: `0.1.5`;
- `homun run --help` includes `--app-url`;
- stale `1-4 lanes` help text is absent.

No sandbox IDs, stream auth URLs, provider account identifiers, private repo
labels, screenshots, raw transcripts, source snippets, token values, PII, or
PHI are recorded in this receipt.
