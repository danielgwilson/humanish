# Actor Evidence App-Target Success Receipt

Date: 2026-06-04

## Purpose

Prove the recursive Mimetic lane against a more appropriate public app target:
a locally runnable Todo app with visible desktop/mobile user surfaces, not a
framework, starter, or library-style developer target. This receipt also records
the hardened actor-evidence artifact path.

## Run

Run id:

```text
oss-meta-actor-evidence-todoapp-2026-06-04T12-03Z
```

Command shape:

```bash
MIMETIC_E2B_REQUEST_TIMEOUT_MS=30000 \
MIMETIC_E2B_TIMEOUT_MS=3600000 \
MIMETIC_OSS_META_COMPLETION_TIMEOUT_MS=900000 \
MIMETIC_OSS_META_COMPLETION_INTERVAL_MS=10000 \
MIMETIC_OSS_META_ACTOR_FIRST=1 \
MIMETIC_OSS_META_REQUIRE_ACTOR=1 \
MIMETIC_OSS_META_ACTOR_TIMEOUT_MS=480000 \
MIMETIC_OSS_META_ACTOR_MODEL=gpt-5.4-mini \
pnpm mimetic -- lab oss --detach --open \
  --count 1 \
  --repos maciekt07/TodoApp \
  --run-id oss-meta-actor-evidence-todoapp-2026-06-04T12-03Z \
  --no-redact-repos \
  --json
```

Provider env was sourced from the local-only env file for the command; no secret
values were printed or committed.

## Result

```text
ok: true
run verdict: pass
repo: maciekt07/TodoApp
actorStatus: passed
appStatus: running
completionStatus: passed
nestedVerifyPassed: true
nestedObserverPresent: true
visualStatus: visible
visualWindowCount: 3
screenshotPresent: true
observer opened: true
```

The run warnings confirmed:

```text
OpenAI actor API-key preflight passed.
Packed local Mimetic package for sandbox install.
Launched 1/1 live E2B desktop stream.
Classified 1/1 bootstrap terminal state from remote public-safe evidence.
Detected 1/1 target app HTTP-ready surface from remote public-safe evidence.
Detected 1/1 headed desktop visual layout from remote public-safe evidence.
Captured 1/1 E2B desktop screenshot fallback.
Persisted 2 public-safe local actor evidence artifacts.
```

## Verification

Command:

```bash
pnpm mimetic -- verify --run oss-meta-actor-evidence-todoapp-2026-06-04T12-03Z --json
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
.mimetic/runs/oss-meta-actor-evidence-todoapp-2026-06-04T12-03Z/run.json
.mimetic/runs/oss-meta-actor-evidence-todoapp-2026-06-04T12-03Z/review.md
.mimetic/runs/oss-meta-actor-evidence-todoapp-2026-06-04T12-03Z/review.json
.mimetic/runs/oss-meta-actor-evidence-todoapp-2026-06-04T12-03Z/events.ndjson
.mimetic/runs/oss-meta-actor-evidence-todoapp-2026-06-04T12-03Z/observer/index.html
.mimetic/runs/oss-meta-actor-evidence-todoapp-2026-06-04T12-03Z/observer/observer-data.json
.mimetic/runs/oss-meta-actor-evidence-todoapp-2026-06-04T12-03Z/screenshots/oss-01-desktop.png
.mimetic/runs/oss-meta-actor-evidence-todoapp-2026-06-04T12-03Z/actor-evidence/oss-01-desktop-actor-last-message-tail.txt
.mimetic/runs/oss-meta-actor-evidence-todoapp-2026-06-04T12-03Z/actor-evidence/oss-01-desktop-actor-log-tail.txt
```

Visual inspection of the screenshot showed:

- a desktop Todo app browser window at `localhost:5173`;
- a compact/mobile Todo app browser window at `localhost:5173`;
- a nested Mimetic Observer window with desktop/mobile browser lanes;
- nested Observer completion at 100 percent.

## Actor Evidence

The persisted public-safe actor tail showed the coding-agent persona:

- installed `mimetic-cli` as a dev dependency with npm;
- ran `npx mimetic init --yes`;
- started the target app at `http://127.0.0.1:5173/`;
- ran the strongest available public npm path with `npx mimetic watch --sims 2`;
- produced and verified a local Mimetic Observer bundle;
- stopped the app server after the proof.

The deterministic bootstrap used the locally packed branch package and did run
the nested live app-url proof against the running Todo app, then verified and
opened the nested Observer inside the E2B desktop.

## Cleanup

Sandbox cleanup:

```text
killed sandbox: [redacted-sandbox-id]
```

Provider readback:

```text
running Mimetic OSS meta-lab sandboxes: 0
```

## Read

The recursive proof critical point is now proven against a public app target
with visible user surfaces and durable public-safe actor evidence artifacts.
This is a stronger final receipt than the earlier Redux proof because it avoids
using a framework/example app as the headline target.

One release/discovery gap remains: the published `mimetic-cli@0.1.4` package
used by the remote actor did not expose the branch's app-url-capable path, so
the actor used `mimetic watch --sims 2` while the deterministic bootstrap used
the locally packed branch package for the nested live app-url proof. The next
public release should close that gap so the public npm install path matches this
branch proof.
