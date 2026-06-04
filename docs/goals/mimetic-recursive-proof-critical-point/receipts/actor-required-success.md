# Actor-Required Success Receipt

Date: 2026-06-04

## Purpose

Re-run the previously blocked actor-required lane after OpenAI credits and
limits were fixed. This receipt proves the stronger recursive goal condition:
the headed E2B lane does not pass until the remote coding-agent actor reaches a
passed terminal status and the nested Mimetic app proof still passes.

## Run

Run id:

```text
oss-meta-actor-required-resume-2026-06-04T11-03Z
```

Command shape:

```bash
MIMETIC_OSS_META_MAX_RUNNING_DESKTOPS=4 \
MIMETIC_E2B_REQUEST_TIMEOUT_MS=30000 \
MIMETIC_E2B_TIMEOUT_MS=3600000 \
MIMETIC_OSS_META_COMPLETION_TIMEOUT_MS=900000 \
MIMETIC_OSS_META_COMPLETION_INTERVAL_MS=10000 \
MIMETIC_OSS_META_ACTOR_FIRST=1 \
MIMETIC_OSS_META_REQUIRE_ACTOR=1 \
MIMETIC_OSS_META_ACTOR_TIMEOUT_MS=240000 \
MIMETIC_OSS_META_ACTOR_MODEL=gpt-5.4-mini \
pnpm mimetic -- lab oss --detach --open \
  --count 1 \
  --repos reduxjs/redux-essentials-example-app \
  --run-id oss-meta-actor-required-resume-2026-06-04T11-03Z \
  --no-redact-repos \
  --json
```

Provider env was sourced from the local-only env file for the command; no secret
values were printed or committed.

## Result

```text
ok: true
run verdict: pass
repo: reduxjs/redux-essentials-example-app
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
OpenAI actor API-key preflight passed for gpt-4.1-mini.
Launched 1/1 live E2B desktop stream.
Classified 1/1 bootstrap terminal state from remote public-safe evidence.
Detected 1/1 target app HTTP-ready surface from remote public-safe evidence.
Detected 1/1 headed desktop visual layout from remote public-safe evidence.
Captured 1/1 E2B desktop screenshot fallback.
```

## Verification

Command:

```bash
pnpm mimetic -- verify --run oss-meta-actor-required-resume-2026-06-04T11-03Z --json
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
.mimetic/runs/oss-meta-actor-required-resume-2026-06-04T11-03Z/run.json
.mimetic/runs/oss-meta-actor-required-resume-2026-06-04T11-03Z/review.md
.mimetic/runs/oss-meta-actor-required-resume-2026-06-04T11-03Z/review.json
.mimetic/runs/oss-meta-actor-required-resume-2026-06-04T11-03Z/events.ndjson
.mimetic/runs/oss-meta-actor-required-resume-2026-06-04T11-03Z/observer/index.html
.mimetic/runs/oss-meta-actor-required-resume-2026-06-04T11-03Z/observer/observer-data.json
.mimetic/runs/oss-meta-actor-required-resume-2026-06-04T11-03Z/screenshots/oss-01-desktop.png
```

Visual inspection of the screenshot showed:

- headed Redux Essentials app window;
- compact/mobile Redux Essentials app window;
- nested Mimetic Observer with desktop and mobile browser lanes;
- nested Observer status complete.

## Cleanup

Sandbox cleanup:

```text
killed sandbox: i39ry62lz2j5a1h12nkx1
```

Provider readback:

```text
running Mimetic OSS meta-lab sandboxes: 0
```

## Read

The explicit actor-authored proof gap is now closed for one public-safe
phase-change lane. This proves the requested recursive harness shape once:

```text
top-level Mimetic Observer
-> headed E2B desktop
-> remote Codex actor terminal
-> public OSS app running
-> nested Mimetic live app-url run
-> nested Observer with desktop/mobile browser evidence
```

This does not claim broad platform readiness or autonomous multi-step product
journey coverage. Those remain next adapter slices after this critical-point
proof.
