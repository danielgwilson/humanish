# Autonomous OSS Lab Loop

Date: 2026-06-02

Status: operator runbook for long-running Codex goal sessions.

## Mission

Make `mimetic-cli` a self-driving, self-improving open-source harness. The
closed loop is:

```text
OSS setup trial
-> run bundle / Observer proof
-> review and verify
-> public-safe feedback
-> issue/spec/implementation
-> rerun and compare
```

Success is not "an agent tried something." Success is a repeatable lab where
multiple Codex lanes try Mimetic on real public OSS repos, produce durable
evidence, classify failures, open or update deduped tickets in this repo, fix
the highest-leverage harness gaps, and rerun until the setup experience gets
better.

## Current Read

As of the 2026-06-02 autonomous loop:

- `main` is at `c34fbbb` with core run primitive contracts merged in #47.
- The local integration checkout is
  `/home/azureuser/claude/mimetic-cli-repo/mimetic-cli`.
- Branch work should happen under
  `/home/azureuser/claude/mimetic-cli-repo/worktrees/<slug>`.
- The workspace-level `AGENTS.md` above the repo defines main/worktree/env
  discipline. The repo-level `AGENTS.md` defines public-safety and acceptance
  rules.
- Completed live-lab hardening includes:
  - `#36`: Codex exec actor path.
  - `#35`: OSS lab E2B stream rendering fallback.
  - `#28`: live running Observer snapshots for local Codex actors.
  - `#45`: JSON OSS meta-lab exits after live result.
  - `#6`: core run IDs, artifact paths, git-state, latest/history, lifecycle,
    and timing primitive contracts.
- Remaining open queue:
  - `#11`: credential, network, spend, redaction, and assisted-run boundaries.
  - `#9`: adapter fixture parity for terminal/product evidence.
  - `#8`: adapter dry-run fixture parity for post-auth-return evidence.
  - `#4`: contract schemas across run bundle, adapter, actor, substrate,
    evidence, review, verification, policy, and feedback.
  - `#3`: doctrine / feedback-loop proof verification.
  - `#2`: review packet 0.
  - `#1`: public boundary verification.

## Official Codex Notes

Official Codex docs currently say:

- use `AGENTS.md` for durable repo guidance, including layout, commands,
  conventions, constraints, and done/verification rules:
  <https://developers.openai.com/codex/learn/best-practices#make-guidance-reusable-with-agentsmd>
- keep one thread per coherent unit of work, use worktrees for active work, and
  use subagents for bounded exploration, tests, or triage:
  <https://developers.openai.com/codex/learn/best-practices#organize-long-running-work-with-session-controls>
- use `/goal` for longer tasks with a persistent objective and measurable
  completion criteria:
  <https://developers.openai.com/codex/prompting#goal-mode>
- `/goal <objective>` sets the goal; `/goal` views it; `/goal pause`,
  `/goal resume`, and `/goal clear` manage it. Goal text must fit within the
  CLI limit, so put longer operating details in this file and point at it:
  <https://developers.openai.com/codex/cli/slash-commands#set-or-view-a-task-goal-with-goal>

For this repo, that means: keep `AGENTS.md` concise, keep this file as the
long-running loop contract, make each goal measurable, and stop only at green
proof or a documented blocker.

## Operating Rails

- Treat public safety as architecture.
- Never commit PII, PHI, secrets, keys, private logs, raw provider payloads,
  raw private transcripts, private screenshots, or generated run bundles.
- Do not print values from `env/.env.local`.
- Target OSS repositories are disposable subjects. Do not commit, push, tag,
  open PRs, or file issues in those repositories.
- GitHub issue creation is allowed only in `danielgwilson/mimetic-cli`, only
  for public-safe, deduped, evidence-linked findings.
- Keep local `main` clean. Do not feature-work on local `main`.
- Runtime evidence belongs under ignored `.mimetic/`.

## Cold Start

From the wrapper directory:

```bash
cd /home/azureuser/claude/mimetic-cli-repo
set -a
source env/.env.local >/dev/null 2>&1
set +a

cd mimetic-cli
git fetch --prune origin
git checkout main
git pull --ff-only
git status --short --branch
git worktree add ../worktrees/<slug> -b codex/<slug> main
cd ../worktrees/<slug>
pnpm install --frozen-lockfile
```

Only report whether `OPENAI_API_KEY` and `E2B_API_KEY` are present or missing.
Never report their values.

## Baseline Proof

Run these before feature work when the loop starts from a fresh main:

```bash
pnpm check
pnpm public-surface:scan
pnpm mimetic -- doctor --json
pnpm mimetic -- lab oss --dry-run --json --no-open \
  --repos developit/mitt,lukeed/clsx,sindresorhus/is-plain-obj,ai/nanoid
pnpm mimetic -- lab oss-smoke --json \
  --repos developit/mitt,lukeed/clsx,sindresorhus/is-plain-obj,ai/nanoid
```

If baseline fails, fix baseline before live provider work unless the failure is
clearly caused by the live work itself.

## Live OSS Lab

Primary trial set:

```bash
pnpm mimetic -- lab oss \
  --json \
  --no-open \
  --repos developit/mitt,lukeed/clsx,sindresorhus/is-plain-obj,ai/nanoid \
  --count 4
```

Expected shape:

- top-level Observer-of-Observers bundle under `.mimetic/runs/<run-id>/`;
- one headed E2B lane per assigned public repo when keys are available;
- visible remote bootstrap terminal per lane;
- nested Mimetic setup/proof commands inside each disposable public repo;
- nested Observer opened inside the E2B browser where the substrate permits it;
- JSON command exits after the completed result.

If live provider substrate fails, still improve the dry-run, smoke harness,
Observer fallback, docs, tests, or issue queue.

## Feedback And Tickets

For every meaningful failure or friction:

1. Link to local ignored evidence path, run id, command, and public repo slug.
2. Classify owner: harness, observer, actor runtime, E2B substrate, target repo,
   docs/skill, policy, or unknown.
3. Deduplicate against open and recently closed issues before creating a new
   issue.
4. Include acceptance proof commands.
5. Include public-safety notes and avoid raw logs if they might contain secrets,
   private paths, or hosted stream tokens.

Create a new issue only when the work is independently closable.

## Implementation Priority

1. Keep OSS lab evidence self-classifying without a human watching streams.
2. Wire accepted core primitives into emitted run bundles so source/git state
   stops using placeholders.
3. Define remaining v1 contracts in `docs/contracts/**`.
4. Turn repeated setup friction into public-safe issue drafts and then fixes.
5. Rerun the same repo set and compare before/after evidence.

## Pasteable Goal

Use this from the wrapper directory when starting a fresh autonomous run:

```text
/goal Own mimetic-cli following docs/operations/autonomous-oss-lab-loop.md from a fresh branch worktree under /home/azureuser/claude/mimetic-cli-repo/worktrees. Keep /home/azureuser/claude/mimetic-cli-repo/mimetic-cli as clean local main; only fetch/ff it, never feature-work there. Source env/.env.local without printing values. Run baseline proof, OSS dry-run, OSS smoke, and when keys/substrate allow a live E2B/Codex OSS lab across developit/mitt,lukeed/clsx,sindresorhus/is-plain-obj,ai/nanoid. Inspect evidence, dedupe public-safe issues, implement the highest-leverage accepted harness gaps from the open queue, rerun relevant proof after each fix, never mutate target OSS repos, never commit secrets/private artifacts, and stop only with green tests/proof or a documented blocker with evidence.
```

## Done When

A long-running autonomous session is successful when it leaves:

- a clean main checkout fast-forwarded to the accepted result;
- work committed on non-main branches or merged PRs;
- command-level proof for every implementation change;
- at least one OSS lab dry-run or smoke report;
- live E2B evidence if keys and provider substrate worked;
- public-safe GitHub issues or comments for deduped lab findings;
- a concise final status with changed files, proof commands, open risks, and
  next loop recommendation.
