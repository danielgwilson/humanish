# Canonical Main App-Target Proof Receipt

Date: 2026-06-04

## Purpose

Record the post-merge canonical `main` proof run so the current local checkout
contains inspectable ignored run artifacts for the final recursive app-target
evidence.

## Run

Run id:

```text
oss-meta-app-target-main-2026-06-04T19-18Z
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
  --run-id oss-meta-app-target-main-2026-06-04T19-18Z \
  --no-redact-repos \
  --json
```

Provider env was sourced from the local-only env file for the command; no secret
values were printed or committed.

## Result

```text
ok: true
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
Packed local mimetic-cli package for sandbox install.
Launched 1/1 live E2B desktop stream.
Started 1/1 visible bootstrap terminal.
Classified 1/1 bootstrap terminal state from remote public-safe evidence.
Detected 1/1 target app HTTP-ready surface from remote public-safe evidence.
Detected 1/1 headed desktop visual layout from remote public-safe evidence.
Captured 1/1 E2B desktop screenshot fallback.
Persisted 2 public-safe local actor evidence artifacts.
```

## Verification

Command:

```bash
pnpm mimetic -- verify --run oss-meta-app-target-main-2026-06-04T19-18Z --json
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

Ignored runtime evidence in canonical `main`:

```text
.mimetic/runs/oss-meta-app-target-main-2026-06-04T19-18Z/run.json
.mimetic/runs/oss-meta-app-target-main-2026-06-04T19-18Z/review.md
.mimetic/runs/oss-meta-app-target-main-2026-06-04T19-18Z/review.json
.mimetic/runs/oss-meta-app-target-main-2026-06-04T19-18Z/events.ndjson
.mimetic/runs/oss-meta-app-target-main-2026-06-04T19-18Z/observer/index.html
.mimetic/runs/oss-meta-app-target-main-2026-06-04T19-18Z/observer/observer-data.json
.mimetic/runs/oss-meta-app-target-main-2026-06-04T19-18Z/screenshots/oss-01-desktop.png
.mimetic/runs/oss-meta-app-target-main-2026-06-04T19-18Z/actor-evidence/oss-01-desktop-actor-last-message-tail.txt
.mimetic/runs/oss-meta-app-target-main-2026-06-04T19-18Z/actor-evidence/oss-01-desktop-actor-log-tail.txt
```

Visual screenshot inspection showed two Todo app browser surfaces and the nested
Mimetic Observer in the E2B desktop.

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

This is the current canonical local proof receipt for the recursive critical
point. It proves the merged code path, not only the pre-merge feature worktree.
