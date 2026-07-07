# Continuation Receipt: Actor Proof And Public-Safety Hardening

Date: 2026-06-04

## Purpose

Continue the recursive proof goal after removing arbitrary run-count caps. The
remaining hard requirement is coding-agent-authored Homun setup/use evidence;
deterministic bootstrap evidence alone is not enough.

## Host Actor Preflight

Run:

```text
host-plan-preflight-10-2026-06-04
```

Command shape:

```bash
HOMUN_OSS_META_HOST_CODEX_ACTOR=1 \
HOMUN_OSS_META_REQUIRE_ACTOR=1 \
HOMUN_OSS_META_ACTOR_FIRST=1 \
E2B_API_KEY=fake-e2b-key-for-host-plan-preflight \
pnpm homun -- lab oss --json --no-open --detach --no-redact-repos \
  --count 1 --repos reduxjs/redux-essentials-example-app \
  --run-id host-plan-preflight-10-2026-06-04
```

Result:

- host Codex authored a public-safe plan with 2 personas and 2 scenarios;
- fake E2B launch failed as expected;
- `pnpm homun -- verify --run host-plan-preflight-10-2026-06-04 --json`
  passed;
- durable host-actor files are limited to `actor-plan.json` and sanitized
  `codex-output.txt`;
- no raw cloned repo, `.git`, raw `codex-last-message.json`, or raw schema file
  remains under the run artifact.

Important correction:

- host-plan mode is useful preflight evidence only;
- applying a host plan no longer sets `ACTOR_STATUS=passed`;
- required actor completion still needs a real remote actor process to pass.

## Public-Safety Hardening

Implemented:

- Host actor public repo clones now happen under `.homun/tmp/host-actors/...`
  and are removed in `finally`.
- Raw Codex last-message output is written to temp only; durable run artifacts
  persist normalized `actor-plan.json` plus sanitized `codex-output.txt`.
- Host Codex env handling is now allowlist-based instead of copying the full
  host env and deleting known secret names.
- `homun verify` now walks run text artifacts and public-proof paths, not only
  `run.json` and `review.md`.
- The verifier rejects browser-profile/raw-browser paths such as `profiles/`,
  `Cookies`, `Login Data`, `Local Storage`, `Preferences`, `Secure Preferences`,
  and raw clone `.git` paths.
- Stale runtime-only profile/raw-clone artifacts were removed from `.homun/runs`
  so they cannot be accidentally attached as public proof.

Proof:

```text
pnpm typecheck: passed
pnpm test tests/oss-lab.test.ts tests/run.test.ts: 2 files, 42 tests passed
pnpm public-surface:scan: passed
pnpm release:check: passed, 15 files / 100 tests
```

Additional verified runs after the wider public-safety scanner:

```text
local-browser-app-proof-clean: verify passed
oss-meta-2026-06-04T08-33-55-996Z-8854989a: verify passed
oss-meta-actor-required-2026-06-04T10-30Z: verify passed
host-plan-preflight-10-2026-06-04: verify passed
```

## Live Actor-Required Attempts

### Default Remote Actor Model

Run:

```text
oss-meta-actor-required-2026-06-04T10-30Z
```

Result:

```text
mode: live
verdict: blocked
appStatus: running
nestedVerifyPassed: true
nestedObserverPresent: true
visualStatus: visible
actorStatus: failed
actor model from log: gpt-5.5
actor failure: Quota exceeded. Check your plan and billing details.
```

Provider cleanup:

```text
killed sandbox: [redacted-sandbox-id]
running Homun OSS meta-lab sandboxes after cleanup: 0
```

### Explicit Lower-Cost Actor Model

Local scoped smoke:

```text
CODEX_API_KEY inline, model gpt-5.4-mini: passed
```

Patch:

- remote actor command now passes `-m ${HOMUN_OSS_META_ACTOR_MODEL:-gpt-5.4-mini}`;
- `HOMUN_OSS_META_ACTOR_MODEL` is forwarded as a public-safe control flag.

Run:

```text
oss-meta-actor-required-mini-2026-06-04T10-37Z
```

Result:

```text
mode: live
verdict: blocked
appStatus: running
nestedVerifyPassed: true
nestedObserverPresent: true
visualStatus: visible
actorStatus: failed
actor model from log: gpt-5.4-mini
actor failure: Quota exceeded. Check your plan and billing details.
```

Provider cleanup:

```text
killed sandbox: [redacted-sandbox-id]
running Homun OSS meta-lab sandboxes after cleanup: 0
```

## Current Read

The deterministic recursive lane is still strong: the public OSS app starts,
nested Homun runs live desktop/mobile browser proof, nested verify passes,
nested Observer exists, visual desktop layout is visible, screenshots are
captured, and public-safety verification passes.

The stronger goal remains open because the remote coding-agent actor cannot
complete: `codex exec` starts in E2B with both `gpt-5.5` and `gpt-5.4-mini`, but
the API-key path fails with quota exceeded before it can materially inspect,
install, initialize, configure, or run Homun.

Follow-up isolated auth checks:

- `codex exec` with an empty `CODEX_HOME` and `CODEX_API_KEY` only failed,
  proving the earlier local Codex smoke had relied on local account auth rather
  than a transferable API-key-only path.
- Direct OpenAI Responses API preflight with the same key returned
  `insufficient_quota`.

New guard:

- actor-required live runs now preflight the OpenAI API-key/quota path before
  launching paid E2B desktops;
- failed preflight records a blocked Observer lane and launches zero sandboxes.

Proof run:

```text
oss-meta-actor-preflight-real-2026-06-04T10-44Z
```

Result:

```text
verdict: blocked
stream status: blocked
current step: Waiting for Codex actor API quota/auth preflight before launching reduxjs/redux-essentials-example-app.
sandboxes launched: 0
verify: passed
provider readback: 0 running Homun OSS meta-lab sandboxes
```

Do not mark the goal complete until a new actor-required run has:

- `review.verdict = pass`;
- stream status `passed`;
- `completion.actorStatus = passed`;
- nested live app proof and nested Observer still present;
- durable public-safe actor evidence showing material Homun setup/use;
- provider cleanup/readback to zero running sandboxes.
