# Actor-Required Live Attempt Receipt

Date: 2026-06-04

## Purpose

Close the gap between deterministic bootstrap proof and the stronger recursive
goal: a coding-agent persona must materially drive Homun setup/use, and the
top-level run must not pass unless that actor evidence reaches a terminal
successful state.

## Code Fixes Before Attempt

- Added `HOMUN_OSS_META_ACTOR_FIRST=1` to start the Codex actor before
  deterministic setup/readback.
- Added `HOMUN_OSS_META_REQUIRE_ACTOR=1` and
  `HOMUN_OSS_META_ACTOR_TIMEOUT_MS` to require terminal actor readback.
- Forwarded those public-safe env flags into E2B sandboxes.
- Wrapped Codex execution in `script -q -e -c` when available so Codex gets a
  pseudo-terminal instead of failing on non-terminal stdin.
- Fixed the actor wrapper to exit with the Codex command exit code instead of
  printing `actor_exit` and returning success.

## Attempts

### Env Forwarding Failure

Run:

```text
oss-meta-2026-06-04T09-10-05-777Z-cd724665
```

Result:

- bundle verified and app/nested Observer proof passed;
- actor flags were not forwarded into the sandbox;
- actor remained a nonblocking afterthought;
- provider cleanup killed one matching sandbox and read back zero remaining.

### Actor Exit-Code Wrapper Failure

Run:

```text
oss-meta-2026-06-04T09-11-57-391Z-4a200c56
```

Result:

- bundle verified and app/nested Observer proof passed;
- actor log readback showed the actor command exited nonzero;
- wrapper still returned success, so `actorStatus` was incorrectly recorded as
  `passed`;
- provider cleanup killed one matching sandbox and read back zero remaining.

### Honest Actor-Required Blocker

Run:

```text
oss-meta-2026-06-04T09-14-56-290Z-3f979fc9
```

Result:

```text
mode: live
verdict: blocked
appStatus: running
nestedVerifyPassed: true
visualStatus: visible
actorStatus: timed_out
reason: Required Codex actor evidence did not reach a passed terminal status.
```

Verification:

```bash
pnpm homun -- verify --run oss-meta-2026-06-04T09-14-56-290Z-3f979fc9 --json
```

Result:

```text
ok: true
run schema: passed
redaction: passed
review artifacts: present
public-safety scan: passed
local evidence artifacts exist: passed
```

Ignored runtime evidence:

```text
.homun/runs/oss-meta-2026-06-04T09-14-56-290Z-3f979fc9/run.json
.homun/runs/oss-meta-2026-06-04T09-14-56-290Z-3f979fc9/review.md
.homun/runs/oss-meta-2026-06-04T09-14-56-290Z-3f979fc9/observer/index.html
.homun/runs/oss-meta-2026-06-04T09-14-56-290Z-3f979fc9/observer/observer-data.json
.homun/runs/oss-meta-2026-06-04T09-14-56-290Z-3f979fc9/screenshots/oss-01-desktop.png
```

Visual inspection:

- Redux Essentials app was visible in desktop and compact browser windows.
- Nested Homun Observer was visible and showed desktop/mobile browser lanes.
- Top-level run correctly stayed blocked because actor evidence timed out.

Provider cleanup:

```text
running Homun OSS meta-lab sandboxes after cleanup: 0
```

### Current Codex Exec Flag Failure

Run:

```text
oss-meta-2026-06-04T09-29-51-133Z-f9623e2f
```

Result:

- app surface, nested live Homun proof, nested verify, nested Observer, and
  visible headed layout all passed;
- required actor evidence failed because the remote actor selected the
  ambient/preinstalled `codex` binary and passed a stale `--ask-for-approval`
  option to `codex exec`;
- top-level verdict correctly stayed `blocked`;
- provider cleanup killed one matching sandbox and read back zero remaining.

Fix:

- remote actor command now pins `npx -y @openai/codex@latest exec`;
- remote actor command uses the current noninteractive
  `--dangerously-bypass-approvals-and-sandbox` option inside the disposable E2B
  sandbox;
- tests assert the remote bootstrap script does not depend on ambient `codex`
  and does not pass `--ask-for-approval`.

### Codex Exec Auth Mapping Failure

Run:

```text
oss-meta-2026-06-04T09-32-34-182Z-a4eb76ef
```

Result:

- app surface, nested live Homun proof, nested verify, nested Observer, and
  visible headed layout all passed;
- pinned Codex exec launched successfully, but failed with missing bearer auth;
- official Codex docs state that noninteractive `codex exec` API-key automation
  uses `CODEX_API_KEY` for the single invocation, not job-wide
  `OPENAI_API_KEY`;
- top-level verdict correctly stayed `blocked`;
- provider cleanup killed one matching sandbox and read back zero remaining.

Fix:

- remote actor command now maps Homun-private Codex auth to `CODEX_API_KEY`
  and/or `CODEX_ACCESS_TOKEN` inline only for the single `codex exec`
  invocation, matching the official Codex
  noninteractive auth guidance:
  <https://developers.openai.com/codex/noninteractive#use-api-key-auth>.

### Local Codex API Quota Blocker

Before launching another paid E2B desktop, a local `codex exec` smoke was run
with `CODEX_API_KEY` set inline and no secret output.

Result:

```text
exit_status: 1
blocker: Quota exceeded. Check plan and billing details.
```

Read:

- the actor command shape is now aligned with current Codex CLI docs and local
  help output;
- the remaining blocker is external Codex/OpenAI API quota for the key
  available to this run;
- no more paid live desktops should be launched for actor-required proof until
  the quota/key issue is fixed or a different authorized Codex auth method is
  provided.

### Local Codex User Auth Smoke

A second local smoke ran `codex exec` with API-key env vars unset and local user
auth allowed.

Result:

```text
exit_status: 0
last_message: HOMUN_USER_AUTH_OK
```

Read:

- local Codex account auth works for this workstation;
- no `CODEX_ACCESS_TOKEN` is present in the local env, so that working account
  auth does not automatically transfer to a remote E2B desktop;
- copying local `auth.json` into E2B is not a public-safe default and was not
  attempted.

### Secret-Scoping Patch

The remote sandbox no longer receives raw provider secret names broadly.

Current contract:

- E2B API key is used only by the host-side E2B API call and is not forwarded
  into the sandbox env.
- OpenAI/Codex actor auth is forwarded under Homun-private env names, moved
  into shell-local variables, then removed from exported env before repo clone,
  dependency install, app startup, and nested Homun commands.
- Codex auth is injected only into the single `codex exec` actor process as
  `CODEX_API_KEY` and/or `CODEX_ACCESS_TOKEN`.
- GitHub token, when present, is forwarded under a Homun-private env name and
  scoped only to `git clone` / askpass.
- Tests assert this contract in `tests/oss-lab.test.ts`.

### Continuation: Public-Safety And Actor Model Patch

Run:

```text
host-plan-preflight-10-2026-06-04
```

Result:

- host Codex actor plan generation succeeded in fake-E2B preflight;
- durable host-plan run artifacts verified public-safe;
- raw repo clone, `.git` metadata, raw Codex last-message output, and schema
  scratch files were moved to `.homun/tmp` and deleted;
- host-plan application no longer sets `ACTOR_STATUS=passed`.

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
actor model: gpt-5.5
actor failure: Quota exceeded. Check your plan and billing details.
```

Provider cleanup:

```text
running Homun OSS meta-lab sandboxes after cleanup: 0
```

Patch:

- local scoped `CODEX_API_KEY` smoke passed for explicit `gpt-5.4-mini`;
- remote actor command now passes
  `-m ${HOMUN_OSS_META_ACTOR_MODEL:-gpt-5.4-mini}`;
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
actor model: gpt-5.4-mini
actor failure: Quota exceeded. Check your plan and billing details.
```

Provider cleanup:

```text
running Homun OSS meta-lab sandboxes after cleanup: 0
```

### API-Key-Only Preflight Guard

Follow-up local checks showed the earlier "local Codex API smoke" was not a
pure API-key proof: with an empty `CODEX_HOME`, `codex exec` failed before
producing output. A direct OpenAI Responses API request with the same key
returned `insufficient_quota`.

Patch:

- actor-required OSS meta-lab runs now preflight the OpenAI API-key/quota path
  before launching paid E2B desktops;
- when the preflight fails, the run records a blocked Observer lane and does not
  launch E2B.

Run:

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

## Current Read

The deterministic recursive proof lane is solid and the harness now fails closed
when actor-required evidence does not pass. The active stronger goal remains
open because the remote E2B Codex actor cannot yet complete with the available
API quota, even after explicitly selecting `gpt-5.4-mini`. Future actor-required
live runs should not spend E2B until the actor API-key preflight passes.

Best next target: provide a usable `CODEX_API_KEY` quota or
`CODEX_ACCESS_TOKEN` auth path, run a local auth smoke without printing secrets,
then rerun the actor-required lane. If auth is fixed and the actor still fails,
continue debugging the noninteractive actor completion path from the new
terminal evidence.
