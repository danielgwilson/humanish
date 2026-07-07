# Goal: Private Repo Agent Dogfood Study

Status date: 2026-06-05

## Objective

Run a bounded, public-safe dogfood study where one agent-like lane per
Daniel-authorized private repo tries to install, configure, and use Homun;
then evaluate the resulting filesystem state, generated Homun artifacts,
Observer evidence, agent feedback, and product-specific leverage.

This is a study-and-improvement loop, not a green-run vanity target. Missing,
blocked, failed, or low-quality setup is a valid result when backed by evidence.

## Source Of Truth

- This goal packet.
- `docs/goals/current.md`.
- `docs/goals/homun-recursive-proof-critical-point/goal.md`.
- `docs/architecture/oss-lab-poc.md`.
- `docs/principles/self-driving-harness.md`.
- `docs/product/open-source-install-experience.md`.
- `AGENTS.md` public boundary.
- GitHub issue #86 for the known pnpm workspace-root bootstrap failure mode.

Private repo labels, private screenshots, private source snippets, raw private
logs, and private run commands must not be committed. Use redacted labels such
as `repo-01` through `repo-04` in committed receipts.

The initial readiness receipt is orientation only. It does not satisfy the
completion invariants for a future `/goal`; the formal goal run must generate
current `.homun/` evidence and a fresh completion audit.

## Success Invariants

- A current ignored env file supplies `GH_TOKEN`, `E2B_API_KEY`, and
  `OPENAI_API_KEY` or equivalent provider auth without printing values.
- The four Daniel-authorized private repo slugs are supplied through current
  command context or ignored local lab source, not committed docs.
- If those exact slugs are not supplied in the current thread or an ignored
  local manifest, stop instead of inferring them from memory, docs, or prior
  receipts.
- GitHub access preflight passes for all assigned private repos through
  credential-isolated anonymous-first, token-second auth.
- A headed E2B Observer-of-Observers run starts up to four desktop lanes, with
  repo labels redacted in durable artifacts.
- Each lane has a terminal state: `passed`, `failed`, `blocked`, or
  `timed_out`, with a public-safe reason.
- Each lane records whether the target app reached a local running URL and
  whether nested Homun proof reached `run --app-url` style browser evidence.
- Each lane records setup-quality filesystem evidence: `homun/config.ts`,
  persona files, scenario files, package script, runtime ignore, and tree
  snapshot status.
- Each lane records agent evidence: actor status, actor log tail or last
  message tail when public-safe, and whether the actor materially discovered,
  installed, initialized, configured, ran, or improved Homun.
- Each lane gets a meaningful-use assessment:
  - `none`: setup did not reach usable Homun proof;
  - `ceremonial`: setup/init ran but personas/scenarios were generic or not
    connected to the target app;
  - `useful`: personas/scenarios or feedback were plausibly target-specific;
  - `high-leverage`: the actor used Homun evidence to find or articulate a
    concrete product or Homun improvement.
- Agent feedback is classified as actionable, duplicate, vague, unsafe for
  public filing, or not captured.
- For Homun-owned blockers, either implement a scoped fix with tests or file
  a public-safe GitHub issue. Do not mutate target repos.
- Any implementation changes run relevant tests and, before merge/release
  claims, `pnpm release:check`.
- After every live provider run, kill disposable E2B sandboxes and record
  cleanup/readback in a receipt.
- The completion audit maps every invariant to current environment evidence or
  names it as missing, failed, blocked, or still hypothesis.

## Allowed Scope

Read:

- The full `homun` repo.
- Ignored `.homun/` runtime artifacts for verification.
- Local env var names, never values.
- Authorized disposable private repo clones inside E2B or ignored runtime
  workspaces only.

Write:

- `docs/goals/private-repo-agent-dogfood/**`.
- Public-safe docs under existing `docs/` paths when needed.
- Homun source and focused tests only when needed to unblock the study:
  - `src/oss-meta-lab.ts`
  - `src/run.ts`
  - `src/program.ts`
  - `src/labs.ts`
  - `src/observer*.ts`
  - focused tests under `tests/`
- GitHub issues in `danielgwilson/homun` only after public-safety review.

Runtime/local-only:

- `.homun/` run artifacts.
- `.homun/local/labs/*.yaml` ignored private lab manifests.
- `.homun/local/private-dogfood/**` ignored private review notes if raw
  private details are unavoidable. Do not quote those details in committed
  receipts.

## Non-Goals

- Do not commit target repo changes.
- Do not push, open PRs, file issues, or deploy in target repos.
- Do not claim platform readiness from one study.
- Do not persist private repo names in committed docs or public artifacts.
- Do not persist private screenshots, raw private source snippets, raw private
  transcripts, PII, PHI, secrets, keys, runtime stream auth URLs, or provider
  account identifiers.
- Do not make production network calls beyond the local dev servers and the
  authorized providers named in the spend policy.
- Do not treat deterministic bootstrap success as actor success.

## Evaluation Plan

1. Preflight local state:
   - confirm `main` is current or use a clean feature worktree;
   - confirm env names load from the ignored env file;
   - confirm provider auth and GitHub clone access without printing values.
2. Run a four-lane private dogfood trial with redacted durable repo labels.
3. Inspect top-level Observer evidence and nested lane evidence.
4. For each lane, fill the lane evaluation table in a receipt:
   - clone/auth result;
   - app status and URL class;
   - nested Homun run/verify/Observer status;
   - setup-quality checks;
   - generated Homun file presence and quality class;
   - actor evidence captured;
   - meaningful-use rating;
   - feedback classification;
   - blocker or next fix.
5. If evidence is insufficient because Homun lacks a safe telemetry surface,
   implement the smallest public-safe telemetry improvement and rerun the
   relevant proof.
6. If a lane fails because of a Homun-owned bootstrap issue, implement or
   ticket it, then rerun only as much as needed to prove the issue class.
7. Run an independent audit pass before completion.

## Proof Commands

Use exact private repo slugs only in ignored local commands, not committed
receipts.

```bash
pnpm release:check
git diff --check
```

Private four-lane study command shape:

```bash
HOMUN_OSS_META_ACTOR_FIRST=1 \
HOMUN_OSS_META_REQUIRE_ACTOR=1 \
HOMUN_OSS_META_ACTOR_TIMEOUT_MS=480000 \
HOMUN_OSS_META_ACTOR_MODEL=gpt-5.4-mini \
HOMUN_OSS_META_COMPLETION_TIMEOUT_MS=900000 \
pnpm homun -- watch oss \
  --env-file <ignored-env-file> \
  --repo <authorized-private-repo-1> \
  --repo <authorized-private-repo-2> \
  --repo <authorized-private-repo-3> \
  --repo <authorized-private-repo-4> \
  --count 4 \
  --detach \
  --no-open \
  --json
```

Human-watched equivalent:

```bash
pnpm homun -- watch oss \
  --env-file <ignored-env-file> \
  --repo <authorized-private-repo-1> \
  --repo <authorized-private-repo-2> \
  --repo <authorized-private-repo-3> \
  --repo <authorized-private-repo-4> \
  --count 4 \
  --open
```

## Proof Artifacts

- `.homun/runs/<run-id>/run.json`
- `.homun/runs/<run-id>/review.json`
- `.homun/runs/<run-id>/review.md`
- `.homun/runs/<run-id>/events.ndjson`
- `.homun/runs/<run-id>/observer/index.html`
- `.homun/runs/<run-id>/observer/observer-data.json`
- `.homun/runs/<run-id>/setup-quality/*.json`
- `docs/goals/private-repo-agent-dogfood/receipts/*.md`
- Public-safe GitHub issues in `homun` for Homun-owned defects.

Prior readiness receipts can guide the run, but completion requires proof
artifacts from the current goal execution. Do not mark complete from receipt
prose alone.

## Known Failure Modes

- Bootstrap-only success: deterministic setup passes but actor evidence is
  missing or non-material.
- Dry-run-only success: synthetic proof exists without target-app evidence.
- Observer-only success: UI renders but no nested run or setup quality exists.
- Transcript-only success: actor says it used Homun without filesystem,
  bundle, verify, or Observer evidence.
- Generic scenario success: personas/scenarios exist but are not meaningfully
  connected to the app under test.
- Private leakage: committed receipt includes private repo labels, private
  source snippets, private screenshots, stream auth URLs, or secrets.
- Workspace-root install failure: package-manager bootstrap fails before
  Homun init, as tracked in issue #86.
- Over-aggregation: four-lane summary hides a single failed or weak lane.
- Unclean cleanup: E2B sandboxes remain running after proof collection.

## Autonomy Rails

- Act as product lead, tech lead, ops lead, and critic.
- Use subagents for independent review or narrow code exploration when useful,
  but do not delegate the immediate critical path.
- Work in a feature worktree for code/doc changes.
- Keep commits scoped and public-safe.
- Update `state.yaml` and add receipts after meaningful slices.
- Prefer fixing small Homun-owned harness defects immediately when they block
  the study; file issues for larger defects.
- Treat blocked lanes as evidence, not as permission to lower the bar.
- Before marking complete, perform a requirement-to-evidence audit.

## Provider Spend Policy

Using the `/goal` that points at this file authorizes only:

- E2B Desktop sandboxes for Homun OSS meta-lab lanes.
- OpenAI/Codex API calls for agent-like actor attempts and bounded local
  evaluation.
- GitHub HTTPS clone/API reads for authorized private repos and public-safe
  Homun issue management.

Spend rails:

- Stop before estimated incremental provider spend exceeds USD 30.
- Stop after 3 wall-clock hours of live provider work unless Daniel extends it.
- No arbitrary run-count cap or desktop-count cap.
- Kill disposable E2B sandboxes after every live run and record cleanup
  readback.
- Record provider usage as public-safe estimates or CLI summaries only; do not
  persist raw provider account payloads or secrets.

If the dollar or wall-clock cap is hit, stop live runs, clean up providers,
write a receipt, and report the remaining proof gap.

## Stop And Ask

Stop before:

- editing `.env` or credential files;
- the exact four authorized private repo slugs are not supplied in current
  command context or an ignored local manifest;
- printing, committing, or pasting secret values;
- committing private repo labels or private source snippets;
- persisting private screenshots or raw private transcripts;
- production deploys, public tunnels, payments, or target-repo mutations;
- destructive git/filesystem operations;
- increasing provider spend, wall-clock, or concurrency caps;
- changing the goal from study/evaluation into broad product rewrite.

## Completion Audit

Completion requires a final receipt that maps every success invariant to
current evidence. If any invariant lacks evidence, mark it as missing, failed,
blocked, or hypothesis. Do not call the goal complete from progress percentage,
agent narration, or a single green lane.
