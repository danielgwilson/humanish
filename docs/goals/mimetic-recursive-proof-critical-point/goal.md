# Goal: Mimetic Recursive Proof Critical Point

Status date: 2026-06-04

## Objective

Prove one bounded public-safe recursive Mimetic lane where Mimetic observes a
headed E2B desktop in which a Codex-like actor sets up Mimetic in a disposable
public OSS app and produces nested Mimetic browser evidence against the running
app.

## Source Of Truth

- This public-safe goal packet and its receipts.
- `docs/goals/current.md`, especially OSS Lab Health Readback and the next gap
  that provider-backed browser personas must drive the target app.
- `docs/architecture/oss-lab-poc.md` for the existing Observer-of-Observers
  command shape and public-safety rules.
- `docs/principles/self-driving-harness.md` for self-driving harness doctrine.
- `AGENTS.md` public boundary.

## Success Invariants

- A committed goal packet exists at this path with state and receipts.
- `mimetic run --app-url <loopback-url>` captures live desktop and mobile
  browser evidence against a running local app URL.
- `mimetic verify` fails if a run claims screenshot or trace evidence that is
  missing on disk.
- `mimetic lab oss` uses the nested app URL proof when a target app is running,
  rather than relying only on nested dry-run proof.
- A bounded live run uses a public-safe OSS app target and stays within the
  approved dollar and wall-clock budgets.
- Live E2B runs enforce a max-concurrent running-desktop guard and clean up
  disposable sandboxes after proof collection.
- Durable run artifacts contain no secret values, runtime stream auth URLs,
  private repo labels, private screenshots, PII, PHI, or raw private source
  artifacts.
- Provider secrets are not exposed to repo-controlled install, app, or nested
  Mimetic commands; Codex auth is scoped to the single actor invocation and
  GitHub auth is scoped to clone/askpass only.
- Top-level Observer evidence shows the E2B desktop lane.
- Nested Mimetic Observer evidence exists inside the desktop lane and contains
  desktop/mobile browser streams for the target app.
- Coding-agent actor evidence shows the actor materially discovered, installed,
  initialized, configured, or ran Mimetic for the target app. Deterministic
  bootstrap evidence alone does not satisfy this invariant.
- Bundle and review artifacts pass schema, redaction, and public-safety checks.
- An independent audit maps every success invariant to evidence or names it as
  missing, failed, blocked, or still hypothesis.

## Allowed Scope

- Write:
  - `src/run.ts`
  - `src/program.ts`
  - `src/oss-meta-lab.ts`
  - focused tests under `tests/`
  - public-safe docs under `docs/goals/` and existing architecture/product docs
- Read:
  - the full repo
  - ignored `.mimetic/` runtime artifacts for verification only
- Commands:
  - `pnpm install --frozen-lockfile`
  - `pnpm typecheck`
  - `pnpm test ...`
  - `pnpm check`
- `pnpm release:check`
- bounded `pnpm mimetic -- lab oss ...` live runs within the spend policy;
  there is no total-attempt cap for this goal
  - local browser/app smoke commands needed to prove `run --app-url`

## Non-Goals

- Do not claim platform readiness from one green lane.
- Do not build full autonomous LLM persona navigation for every app.
- Do not mutate GitHub issues, projects, target repositories, or deploy targets.
- Do not commit generated `.mimetic/` runtime artifacts.
- Do not use private repos for the first proof lane.
- Do not persist raw provider usage payloads if they contain secrets or account
  identifiers.

## Evaluation Plan

- Unit/contract tests prove `run --app-url` bundle shape, desktop/mobile
  screenshot artifact generation, loopback URL enforcement, and verify
  fail-closed behavior.
- OSS meta-lab tests prove the remote bootstrap calls the nested app URL proof.
- A live bounded run proves headed E2B stream launch, target app setup, nested
  Mimetic run, nested Observer presence, screenshot evidence, and top-level
  Observer rendering.
- Redaction checks prove durable artifacts do not contain known secret patterns,
  E2B stream auth URLs, PII, PHI, or private-source residue.
- Codex actor auth is smoke-tested before paid E2B retry when the actor path is
  the active missing proof.
- Independent audit inspects files and commands rather than trusting the
  builder's narrative.

## Proof Commands

```bash
pnpm typecheck
pnpm test tests/run.test.ts tests/oss-lab.test.ts
pnpm check
pnpm release:check
# Before paid actor-required retries, prove Codex auth can run locally without
# printing secrets. Use CODEX_API_KEY or CODEX_ACCESS_TOKEN inline for one
# invocation when available; do not rely on OPENAI_API_KEY as a generic job env.
MIMETIC_OSS_META_MAX_RUNNING_DESKTOPS=4 \
MIMETIC_E2B_REQUEST_TIMEOUT_MS=30000 \
MIMETIC_E2B_TIMEOUT_MS=3600000 \
MIMETIC_OSS_META_COMPLETION_TIMEOUT_MS=900000 \
MIMETIC_OSS_META_COMPLETION_INTERVAL_MS=10000 \
MIMETIC_OSS_META_ACTOR_FIRST=1 \
MIMETIC_OSS_META_REQUIRE_ACTOR=1 \
MIMETIC_OSS_META_ACTOR_TIMEOUT_MS=240000 \
pnpm mimetic -- lab oss --detach --open --count 1 --repos reduxjs/redux-essentials-example-app
pnpm mimetic -- verify --run oss-meta-2026-06-04T08-33-55-996Z-8854989a --json
```

The live command may be adjusted to another lightweight public OSS app repo if
the selected target cannot install or expose a local app within the spend and
time caps. Record the reason in `state.yaml`.

## Proof Artifacts

- `docs/goals/mimetic-recursive-proof-critical-point/state.yaml`
- `docs/goals/mimetic-recursive-proof-critical-point/receipts/*.md`
- ignored `.mimetic/runs/<run-id>/run.json`
- ignored `.mimetic/runs/<run-id>/review.md`
- ignored `.mimetic/runs/<run-id>/observer/observer-data.json`
- ignored `.mimetic/runs/<run-id>/screenshots/*.png`
- Observer URL opened locally for review

## Known Failure Modes

- Bootstrap-only success with no target app evidence.
- Dry-run-only nested proof.
- Observer shell renders but browser streams are placeholder-only.
- Screenshots referenced in the bundle are missing on disk.
- App repo has no runnable UI script.
- Deterministic bootstrap completes while the coding-agent actor only launches
  after proof collection or never reaches a terminal evidence state.
- Dependency install exceeds wall-clock or spend caps.
- E2B launches but stream URL is persisted into durable artifacts.
- Provider auth exists but is exposed broadly to target repo scripts.
- Codex API key auth reaches Codex but is quota-blocked.
- Public docs accidentally claim full platform readiness from one lane.

## Autonomy Rails

- Work on a branch/worktree.
- Keep commits public-safe.
- Prefer public app repos and synthetic evidence.
- Treat missing proof as blocked/incomplete, not as success.
- Update `state.yaml` after meaningful implementation, proof, and audit slices.

## Provider Spend Policy

- Allowed providers: E2B desktop sandbox and OpenAI/Codex actor flows already
  used by Mimetic.
- Dollar cap: maximum estimated $50 total for this proof.
- Max concurrent paid resources: at most 4 running Mimetic OSS meta-lab
  desktops by default, enforced before live launch.
- Total run count: no arbitrary cap. Do not stop or mark blocked because an
  old attempt count was exceeded; stop only for the dollar cap, wall-clock cap,
  max-concurrent paid-resource cap, missing proof, or real provider/tool
  failure.
- Wall-clock cap: maximum 2 hours.
- Usage receipt path: `docs/goals/mimetic-recursive-proof-critical-point/receipts/`.
- Provider cleanup/readback: after live proof, query running Mimetic OSS
  meta-lab sandboxes by metadata and stop any disposable sandboxes left running.
- Secret scoping: never forward `OPENAI_API_KEY`, `CODEX_API_KEY`,
  `CODEX_ACCESS_TOKEN`, `E2B_API_KEY`, `GH_TOKEN`, or `GITHUB_TOKEN` broadly to
  repo-controlled remote commands. Use Mimetic-private handoff vars, unset them
  from exported env before repo code runs, and inject auth only into the single
  process that requires it.
- If the dollar, wall-clock, or concurrent-resource cap is reached, stop
  launching new provider work and record the blocker. If only the number of
  attempts feels high, clean up/read back provider state and continue while the
  real caps still allow it.

## Stop And Ask

- Any need to inspect or print secret values.
- Any need to use private repos, private screenshots, PII, PHI, raw transcripts,
  or private source artifacts.
- Any target repo commit, push, branch, tag, issue, project, or deploy mutation.
- Any need to exceed the provider caps.
- Any public artifact that would mention private stream URLs or credentials.

## Completion Audit

Before marking the goal complete, produce a requirement-to-evidence table in a
receipt and confirm every success invariant is proven by current disk, command,
browser, or Observer evidence. If any item is missing or indirect, keep the goal
active.
