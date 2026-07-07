# Implementation Proof

Date: 2026-06-04

## What Changed

- Added `homun run --app-url <loopback-url>` for live browser app surface
  proof.
- The app URL proof captures desktop and mobile browser screenshots plus trace
  JSON artifacts under ignored `.homun/runs/<run-id>/`.
- `homun verify` now checks referenced local screenshot and trace artifacts
  exist and are non-empty.
- `homun lab oss` remote bootstrap now starts the target app before nested
  proof and runs `npx homun run --app-url "$APP_URL" --sims 2` when the app
  is running.

## Commands

```bash
pnpm typecheck
pnpm test tests/run.test.ts tests/oss-lab.test.ts
pnpm check
HOMUN_BROWSER_COMMAND='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' pnpm homun -- run --app-url http://127.0.0.1:4173 --run-id local-browser-app-proof-clean --json
pnpm homun -- verify --run local-browser-app-proof-clean --json
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
  not retain Chrome profile directories inside `.homun/runs/<run-id>/`.

## Local Evidence

Ignored runtime artifacts:

```text
.homun/runs/local-browser-app-proof-clean/run.json
.homun/runs/local-browser-app-proof-clean/review.md
.homun/runs/local-browser-app-proof-clean/observer/index.html
.homun/runs/local-browser-app-proof-clean/screenshots/desktop.png
.homun/runs/local-browser-app-proof-clean/screenshots/mobile.png
.homun/runs/local-browser-app-proof-clean/traces/desktop.json
.homun/runs/local-browser-app-proof-clean/traces/mobile.json
```

## Limits

- This proves browser render evidence and HTTP readiness for desktop/mobile
  surfaces, not full autonomous multi-step persona navigation.
- The live E2B recursive proof is recorded in `receipts/live-run.md`.
