# Provider Browser Persona Receipt: 2026-06-05

## Scope

This receipt covers the first public-safe proof slice where `mimetic run
--app-url` drives a bounded two-step browser persona journey, then the OSS
meta-lab proves that path inside a headed E2B desktop against a public app
target.

The public target was `maciekt07/TodoApp`. No private repos, private source
snippets, private screenshots, raw transcripts, provider sandbox ids, stream
auth URLs, token values, PII, PHI, or secret values are recorded here.

## Implementation Delta

- Added `playwright-core` and upgraded `run --app-url` from render-only
  screenshot proof to a desktop/mobile two-step browser persona journey.
- Added `mimetic.browser-persona-trace.v1` traces with per-step status,
  action, reason, URL, duration, and screenshot path.
- Added per-step screenshot artifacts:
  `step-01-load` and `step-02-interact` for desktop and mobile surfaces.
- Added visible-state change detection after the primary action.
- Kept generated browser proof restricted to loopback URLs.
- Added a fixture-only test driver so unit tests can assert bundle shape without
  depending on a local browser binary.
- Fixed browser executable resolution so command names such as `google-chrome`
  are resolved to an executable path before Playwright launch.
- Added provider metadata cleanup/readback for stale OSS meta-lab sandboxes and
  `mimetic lab cleanup oss`.
- Added signal cleanup coverage for attached watch mode.

## Local Browser Proof

Run:

```text
browser-2026-06-06T02-57-15-842Z-8315e202
```

After the blocked-trace hardening patch, the current implementation was rerun
and verified with:

```text
browser-current-proof-2026-06-05
```

Command shape:

```bash
MIMETIC_BROWSER_COMMAND="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
pnpm mimetic -- run --app-url http://127.0.0.1:4173 --sims 2 --json
pnpm mimetic -- verify --run browser-2026-06-06T02-57-15-842Z-8315e202 --json
pnpm mimetic -- watch --run browser-2026-06-06T02-57-15-842Z-8315e202 --no-open --json
```

Readback:

- `2/2` browser simulations passed;
- desktop and mobile streams used `browser-persona-two-step`;
- each stream captured `step-01-load` and `step-02-interact` screenshots;
- desktop trace schema: `mimetic.browser-persona-trace.v1`;
- mobile trace schema: `mimetic.browser-persona-trace.v1`;
- both traces recorded `goto` followed by `fill-and-click-primary`;
- both traces recorded `Primary action changed visible page state.`;
- `mimetic verify` passed schema, redaction, review artifact,
  public-safety, local evidence, and Codex app-server evidence checks;
- Observer rendered from the verified run bundle.

## Provider Attempt And Fix

First headed E2B attempt:

```text
oss-meta-2026-06-06T02-59-54-106Z-0151d43b
```

The lane failed usefully. The target app started, but nested Mimetic proof
failed because Playwright was given `executablePath: "google-chrome"` instead
of a resolved executable path.

Provider cleanup after this failed attempt:

```text
killed: 1
matched: 1
remaining: 0
errors: 0
```

The code now resolves browser command names through `command -v` before passing
them to Playwright.

## Provider Proof

Successful headed E2B run:

```text
oss-meta-2026-06-06T03-05-38-681Z-a8ca327a
```

Command shape:

```bash
pnpm mimetic -- watch oss --repo maciekt07/TodoApp --count 1
pnpm mimetic -- verify --run oss-meta-2026-06-06T03-05-38-681Z-a8ca327a --json
pnpm mimetic -- lab cleanup oss --json
```

Readback:

- `1/1` headed E2B desktop lane passed;
- target app responded at `http://localhost:5173`;
- nested Mimetic proof ran in live mode;
- nested verification passed;
- nested Observer was present;
- top-level Observer opened in headed watch mode;
- remote headed desktop visual layout was visible;
- `3` Chrome windows were detected in the desktop environment;
- `mimetic verify` passed schema, redaction, review artifact, public-safety,
  local evidence, and Codex app-server evidence checks;
- top-level run preserved only redacted bootstrap evidence and local proof
  summaries.

Provider cleanup after the successful attempt:

```text
killed: 1
matched: 1
remaining: 0
errors: 0
```

## Honest Finding

The public target lane still produced a feedback candidate:

```text
repo-01 Mimetic setup was ceremonial
```

That is a valid product signal. The nested browser proof now works, but the
agent/setup-quality path can still create starter Mimetic files without
meaningful app-specific personas, scenarios, and coverage. This should remain
visible as feedback rather than being hidden behind a green run.

## Verification Commands

```bash
pnpm vitest run tests/run.test.ts tests/oss-lab.test.ts tests/program.test.ts
pnpm typecheck
pnpm mimetic -- verify --run browser-2026-06-06T02-57-15-842Z-8315e202 --json
pnpm mimetic -- verify --run oss-meta-2026-06-06T03-05-38-681Z-a8ca327a --json
pnpm mimetic -- lab cleanup oss --json
```

Results:

- focused tests passed: `3` files, `74` tests;
- typecheck passed;
- local browser-persona run verification passed;
- current-code local browser-persona verification passed;
- provider OSS meta-lab run verification passed;
- provider cleanup readback found `0` remaining matching desktops.

## Remaining Gaps

- This is a bounded two-step generic browser persona, not a full app-specific
  scenario-manifest engine.
- Top-level OSS meta-lab evidence currently records nested verification and
  local proof summary, but not the full nested trace payload from inside E2B.
- The public target run exposed setup ceremony; Mimetic should keep improving
  app-aware persona/scenario authoring and meaningful-use scoring.
- This proves one public provider-backed lane. Broader platform readiness still
  requires repeated runs across more public app/tool targets.
