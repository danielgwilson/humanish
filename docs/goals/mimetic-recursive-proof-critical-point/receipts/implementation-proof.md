# Implementation Proof

Date: 2026-06-04

## What Changed

- Added `mimetic run --app-url <loopback-url>` for live browser app surface
  proof.
- The app URL proof captures desktop and mobile browser screenshots plus trace
  JSON artifacts under ignored `.mimetic/runs/<run-id>/`.
- `mimetic verify` now checks referenced local screenshot and trace artifacts
  exist and are non-empty.
- `mimetic lab oss` remote bootstrap now starts the target app before nested
  proof and runs `npx mimetic run --app-url "$APP_URL" --sims 2` when the app
  is running.

## Commands

```bash
pnpm typecheck
pnpm test tests/run.test.ts tests/oss-lab.test.ts
pnpm check
MIMETIC_BROWSER_COMMAND='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' pnpm mimetic -- run --app-url http://127.0.0.1:4173 --run-id local-browser-app-proof-clean --json
pnpm mimetic -- verify --run local-browser-app-proof-clean --json
```

## Results

- Focused tests passed: `tests/run.test.ts` and `tests/oss-lab.test.ts`, 32
  tests.
- Full local check passed: 15 test files, 90 tests, typecheck, and build.
- Local real-browser fixture proof passed with two browser sims.
- Local verify passed and included `local evidence artifacts exist`.
- Live Observer warnings now distinguish verified live evidence from dry-run
  contract evidence.
- The clean local proof stores screenshot/trace/observer evidence only and does
  not retain Chrome profile directories inside `.mimetic/runs/<run-id>/`.

## Local Evidence

Ignored runtime artifacts:

```text
.mimetic/runs/local-browser-app-proof-clean/run.json
.mimetic/runs/local-browser-app-proof-clean/review.md
.mimetic/runs/local-browser-app-proof-clean/observer/index.html
.mimetic/runs/local-browser-app-proof-clean/screenshots/desktop.png
.mimetic/runs/local-browser-app-proof-clean/screenshots/mobile.png
.mimetic/runs/local-browser-app-proof-clean/traces/desktop.json
.mimetic/runs/local-browser-app-proof-clean/traces/mobile.json
```

## Limits

- This proves browser render evidence and HTTP readiness for desktop/mobile
  surfaces, not full autonomous multi-step persona navigation.
- The live E2B recursive proof is recorded in `receipts/live-run.md`.
