# Formal Run Receipt: 2026-06-05

## Scope

This receipt covers the first formal actor-required four-lane private-repo
dogfood run for Mimetic. Repo labels are redacted as `repo-01` through
`repo-04`.

## Provider And Auth Preflight

- Env-name preflight found `GH_TOKEN`, `E2B_API_KEY`, and `OPENAI_API_KEY`
  without printing values.
- Credential-isolated GitHub read preflight passed `4/4` assigned repos.
- OpenAI actor preflight passed for the run-selected actor model.
- Live provider scope stayed within the packet rails: E2B Desktop, OpenAI/Codex,
  and GitHub read access; max concurrent E2B desktops was `4`.

## Run Evidence

- run: `oss-meta-2026-06-05T07-02-38-522Z-ea401be2`
- mode: `live`
- observer: `.mimetic/runs/oss-meta-2026-06-05T07-02-38-522Z-ea401be2/observer/index.html`
- bundle: `.mimetic/runs/oss-meta-2026-06-05T07-02-38-522Z-ea401be2/run.json`
- verification: `pnpm mimetic -- verify --run oss-meta-2026-06-05T07-02-38-522Z-ea401be2 --json` passed all checks.

Verification checks that passed:

- `run.json` exists;
- run schema is `mimetic.run-bundle.v1`;
- redaction status passed;
- review artifacts exist;
- public-safety scan passed;
- referenced local evidence artifacts exist.

## Lane Evaluation

| Lane | Terminal State | Setup Quality | App Proof | Actor Evidence | Meaningful Use | Feedback Classification |
|---|---:|---:|---:|---:|---|---|
| `repo-01` | passed | 5/5 checks passed | running app, nested verify, nested Observer, visible layout | present | ceremonial | not captured automatically |
| `repo-02` | passed | 5/5 checks passed | running app, nested verify, nested Observer, visible layout | present | ceremonial | not captured automatically |
| `repo-03` | passed | 5/5 checks passed | running app, nested verify, nested Observer, visible layout | present | useful | actionable Mimetic-owned proof-path confusion |
| `repo-04` | passed | 5/5 checks passed | running app, nested verify, nested Observer, visible layout | present | ceremonial | actionable Mimetic-owned proof-path confusion |

Setup-quality checks per lane:

- `mimetic/config.ts` exists;
- 2 persona files detected;
- 2 scenario files detected;
- `package.json` exposes a Mimetic script;
- `.gitignore` ignores `.mimetic/`.

Raw private previews were intentionally suppressed for this token-backed private
run, so persona/scenario content quality was not committed. The meaningful-use
ratings above are based on public-safe actor evidence and setup-quality shape.

## Findings

- The system can now run four redacted headed E2B lanes against authorized
  private repos and collect nested Observer proof without persisting private
  repo names or stream URLs.
- All four lanes successfully installed/configured Mimetic enough to produce
  setup-quality filesystem artifacts and nested proof.
- The strongest product leverage is still limited. Most actor work was setup
  and Observer rendering, not rich target-specific user-study design.
- Two lanes reported or implied confusion around the live app proof path,
  treating Observer rendering or `watch --sims` as sufficient proof even though
  `run --app-url` is the command for live app evidence.
- The detached run did not persist cleanup handles in `run.json`; provider
  cleanup required a separate metadata readback.

## Mimetic-Owned Follow-Up

Implemented locally in the current branch:

- fixed the pnpm workspace-root Mimetic install path by using an explicit
  workspace-root dev dependency install;
- replaced a private repo slug in tests with synthetic fixture labels;
- strengthened the Mimetic skill, agent resource prompt, README command table,
  and remote actor prompt to distinguish `run --app-url` proof from Observer
  rendering;
- expanded feedback-candidate detection for actor claims that the published CLI
  does not expose `run --app-url`.

Filed:

- GitHub issue #88: provider cleanup receipts and meaningful-use scoring for
  OSS meta-lab.

Existing:

- GitHub issue #86 remains the pnpm workspace-root blocker until the local fix
  is merged and verified in CI.

## Provider Cleanup

- Provider readback before cleanup found `4` running Mimetic OSS meta-lab
  sandboxes.
- Cleanup killed `4/4`.
- Cleanup errors: `0`.
- Provider readback after cleanup found `0` running Mimetic OSS meta-lab
  sandboxes.

No sandbox IDs, stream auth URLs, provider account identifiers, private repo
labels, screenshots, raw transcripts, source snippets, token values, PII, or
PHI are recorded in this receipt.

## Current Completion Status

The formal run itself produced sufficient public-safe evidence for setup,
actor, app, Observer, verification, and cleanup. Goal completion is still
pending final code/doc verification, public-safety scans, release gates, PR/CI,
and an invariant-by-invariant completion audit after the Mimetic-owned local
fixes are merged or otherwise proven current.
