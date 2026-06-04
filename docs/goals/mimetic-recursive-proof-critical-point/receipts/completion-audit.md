# Completion Audit

Date: 2026-06-04

Verdict: recursive proof critical point complete for one public-safe lane.

## Independent Audit Result

An independent read-only audit found the recursive proof evidence was real and
surfaced four issues:

- the original arbitrary total run-count cap was a poor spend-control proxy and
  was likely exceeded;
- the transient goal packet was included in the npm package file list;
- local browser proofs retained Chrome profile state under run artifacts;
- `verify` checked screenshot/trace artifact entries but not screenshot URLs
  referenced by `embed.url` or `ui.screenshotUrl`.

Continuation audit also found two stale proof-surface labels:

- live OSS meta-lab bundles still wrote `mode: "dry-run"`;
- public ramp and architecture docs still described live browser proof as
  not-first-class / nested dry-run-only.

Post-audit fixes:

- `package.json` now packages `docs/goals/current.md` instead of all
  `docs/goals/`, and `tests/release.test.ts` enforces that narrower package
  surface.
- Browser profile state is created under the OS temp directory and removed after
  each screenshot capture.
- `verify` now validates local screenshot references from artifact entries,
  screenshot embeds, and UI screenshot URLs.
- The goal packet source-of-truth text no longer depends on a private Codex
  thread.
- E2B provider state was queried by public-safe metadata. Seven running Mimetic
  OSS meta-lab sandboxes were found, all seven were killed, and a follow-up
  provider readback returned zero running Mimetic OSS meta-lab sandboxes.
- `mimetic lab oss` now checks running E2B sandboxes with metadata
  `tool=mimetic-cli&mode=oss-meta-lab` before live launch and fails closed when
  running plus requested headed desktops would exceed
  `MIMETIC_OSS_META_MAX_RUNNING_DESKTOPS` (default 4).
- The original total run-count cap was reclassified as an arbitrary goal-design
  mistake, not a completion invariant. The corrected spend policy uses dollar
  budget, wall-clock budget, max-concurrent paid resources, and cleanup/readback.
- The active goal and packet now explicitly say there is no total-attempt cap;
  only the real spend, time, concurrent-resource, cleanup/readback, and
  proof-quality gates can stop the live loop.
- Redaction now avoids treating Codex command flags such as
  `--ask-for-approval` as OpenAI keys while still redacting real `sk-*` token
  shapes.
- Actor-required retry found two additional harness issues and one external
  blocker: ambient Codex `exec` had stale flag support, `codex exec`
  automation needs `CODEX_API_KEY` inline for the single invocation, and the
  available key then failed a local auth smoke with quota exceeded.
- Remote provider secret handling was tightened so raw provider env names are
  not exposed broadly to target repo scripts. Codex auth is scoped to the actor
  process; GitHub auth is scoped to clone/askpass; E2B API key is not forwarded
  into the sandbox env.
- Host actor plan preflight was hardened so raw cloned repos, `.git` metadata,
  raw Codex last-message output, and schema scratch files live only under
  `.mimetic/tmp` and are deleted after normalization. Durable host-plan run
  artifacts now contain only `actor-plan.json` and sanitized `codex-output.txt`.
- Host Codex plan generation now uses an allowlist environment instead of
  copying the full host env and deleting known secret names.
- Host-plan application no longer sets `ACTOR_STATUS=passed`; host-plan mode is
  useful preflight evidence but cannot satisfy actor-required completion without
  a real remote actor process.
- `mimetic verify` now scans all run text artifacts and rejects raw browser
  profile/store paths and raw clone `.git` paths. Regression tests cover
  browser-profile artifacts and non-bundle `events.ndjson` secret leakage.
- A new actor-required live retry with explicit `gpt-5.4-mini` proved the model
  override reached E2B, but remote Codex still failed with quota exceeded.
- An isolated empty-`CODEX_HOME` smoke and direct OpenAI Responses API preflight
  confirmed the available API-key path is quota blocked; actor-required live
  runs now fail closed before paid E2B launch when the preflight fails.
- Local `codex-exec` fanout no longer rejects lane counts above four. It runs
  requested lanes through bounded concurrency
  `MIMETIC_LOCAL_CODEX_EXEC_MAX_CONCURRENCY` (default 4), which is a resource
  rail rather than a total run-count cap.
- Live OSS meta-lab bundles now write `mode: "live"` when live launch is
  requested, and Observer warnings are mode-aware.
- The captured final proof bundle was corrected to `mode: live`, its Observer
  was rerendered without another paid provider launch, and the same run verified
  green again.
- Public ramp and OSS lab architecture docs now say `--app-url` browser proof is
  live for desktop/mobile render evidence while multi-step autonomous persona
  navigation remains the next gap.
- The remote bootstrap script now supports
  `MIMETIC_OSS_META_ACTOR_FIRST=1`,
  `MIMETIC_OSS_META_REQUIRE_ACTOR=1`, and
  `MIMETIC_OSS_META_ACTOR_TIMEOUT_MS` so a future live run can require terminal
  Codex actor readback and move the actor before deterministic setup/readback.
- Actor-required live run `oss-meta-2026-06-04T09-14-56-290Z-3f979fc9`
  verified successfully as a run bundle and failed closed with verdict
  `blocked` because `actorStatus` was `timed_out` while app/nested Observer
  evidence passed.
- After OpenAI credits and limits were fixed, actor-required live run
  `oss-meta-actor-required-resume-2026-06-04T11-03Z` passed with
  `actorStatus=passed`, `appStatus=running`, `nestedVerifyPassed=true`,
  `nestedObserverPresent=true`, `visualStatus=visible`,
  `visualWindowCount=3`, and `screenshotPresent=true`.
- Verification for `oss-meta-actor-required-resume-2026-06-04T11-03Z` passed
  schema, redaction, review-artifact, public-safety, and local-evidence checks.
- Screenshot inspection confirmed the headed Redux Essentials app windows and
  nested Mimetic Observer with desktop/mobile browser lanes.
- Provider cleanup killed sandbox `i39ry62lz2j5a1h12nkx1`; follow-up provider
  readback returned zero running Mimetic OSS meta-lab sandboxes.

## Invariant Map

| Success invariant | Evidence | Status |
| --- | --- | --- |
| Committed goal packet exists | `docs/goals/mimetic-recursive-proof-critical-point/goal.md`, `state.yaml`, and receipts are tracked on `main` after PR #69 | passed |
| `mimetic run --app-url` captures desktop/mobile browser evidence | `src/run.ts`, `tests/run.test.ts`, `.mimetic/runs/local-browser-app-proof-clean/screenshots/*.png`, `.mimetic/runs/local-browser-app-proof-clean/traces/*.json` | passed |
| `verify` fails when claimed screenshot/trace evidence is missing | `tests/run.test.ts` removes screenshot evidence and mutates embed URL evidence; `verifyRun` checks artifact, embed, and UI screenshot paths | passed |
| OSS meta-lab uses nested app URL proof when target app is running | `src/oss-meta-lab.ts`; final terminal tail includes `mimetic run live`, `sims: 2`, and nested verify passed | passed |
| Bounded live run uses public-safe OSS app target | Final actor-required run used `reduxjs/redux-essentials-example-app`, `--count 1`, and live E2B mode | passed |
| Provider spend/time policy respected | No secret values were printed; exact dollar usage was unavailable from the CLI; wall-clock remained within the authorized window; all running Mimetic OSS meta-lab sandboxes were killed after proof collection | passed with usage note |
| Future provider launch cap guarded | `src/oss-meta-lab.ts` checks running provider sandboxes before launch; `tests/oss-lab.test.ts` covers fail-closed capacity classification | passed |
| Actor API-key quota preflight prevents wasted E2B spend | `src/oss-meta-lab.ts` preflights actor-required API-key/quota path; `oss-meta-actor-preflight-real-2026-06-04T10-44Z` launched zero sandboxes, verified blocked, and provider readback returned zero running sandboxes | passed |
| Durable artifacts contain no secret values, runtime stream auth URLs, private repo labels, PII, PHI, or private source artifacts | `pnpm mimetic -- verify --run oss-meta-actor-required-resume-2026-06-04T11-03Z --json`; broad run-artifact scan and public-surface scan passed | passed |
| Top-level Observer evidence shows E2B desktop lane | `.mimetic/runs/oss-meta-actor-required-resume-2026-06-04T11-03Z/observer/index.html`; screenshot `screenshots/oss-01-desktop.png` | passed |
| Nested Observer exists and contains desktop/mobile browser streams | Final actor-required run completion records nested Observer path, `mimetic run live`, `sims: 2`, and nested verify passed; screenshot visually shows nested desktop/mobile lanes | passed |
| Coding-agent persona discovers, installs, and uses Mimetic | `oss-meta-actor-required-resume-2026-06-04T11-03Z` passed with `actorStatus=passed`; the bootstrap log tail records `mimetic init`, target app startup, nested live Mimetic run, nested verify, nested Observer opening, and visual layout evidence | passed |
| Bundle and review pass schema/redaction/public-safety checks | `pnpm mimetic -- verify --run oss-meta-actor-required-resume-2026-06-04T11-03Z --json` | passed |
| Independent audit maps invariants or names gaps | This receipt plus independent audit result | passed |

## Final Commands

```bash
pnpm test tests/run.test.ts tests/oss-lab.test.ts
MIMETIC_BROWSER_COMMAND='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' pnpm mimetic -- run --app-url http://127.0.0.1:4173 --run-id local-browser-app-proof-clean --json
pnpm mimetic -- verify --run local-browser-app-proof-clean --json
pnpm mimetic -- watch --run oss-meta-2026-06-04T08-33-55-996Z-8854989a --detach --no-open
pnpm mimetic -- verify --run oss-meta-2026-06-04T08-33-55-996Z-8854989a --json
pnpm mimetic -- verify --run oss-meta-2026-06-04T09-14-56-290Z-3f979fc9 --json
pnpm mimetic -- verify --run oss-meta-actor-required-resume-2026-06-04T11-03Z --json
npm pack --dry-run --json --ignore-scripts
pnpm release:check
```

Final release check:

```text
typecheck: passed
tests: 15 files, 102 tests passed
build: passed
public-surface scan: passed
skill check: passed
npm pack dry-run: passed
```

Post-cleanup provider readback:

```text
running Mimetic OSS meta-lab sandboxes: 0
```

## Package Surface

`npm pack --dry-run` includes `docs/goals/current.md` but not
`docs/goals/mimetic-recursive-proof-critical-point/`.

## Completion Decision

The recursive proof critical point is achieved for one public-safe headed OSS
lane. The run proves:

```text
top-level Mimetic Observer
-> headed E2B desktop
-> remote Codex actor terminal with actorStatus=passed
-> public OSS app running
-> nested Mimetic live app-url run
-> nested Observer with desktop/mobile browser evidence
-> verifier/public-safety checks
-> provider cleanup/readback to zero running Mimetic OSS meta-lab sandboxes
```

This is a phase-change proof, not broad platform readiness. Repeated-run
reliability, multi-step autonomous browser-persona navigation, and richer
adapter coverage remain future work.
