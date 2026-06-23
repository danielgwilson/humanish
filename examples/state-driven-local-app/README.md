# state-driven local-app example

This is a minimal, runnable state-driven `local-app` example for npm consumers.
It mirrors the library route described in
[`docs/architecture/state-driven-executor.md`](../../docs/architecture/state-driven-executor.md)
without depending on the repo's unpublished test suite.

The example drives a synthetic already-running local app through an in-process
state contract:

```ts
app.getState();
app.sendChat(text);
```

It uses `runLab` with both CUA hooks:

- `buildExecutor` supplies a custom `CuaExecutor` that observes `appState` and
  executes actions through the local app contract.
- `buildProvider` supplies a non-vision `CuaProvider` that reasons over
  `req.observation.appState` instead of screenshots.

Because the executor and provider are caller-supplied, this route creates **no
E2B desktop**, uses **no vision model**, and requires **no OpenAI or E2B keys**.
The run still keeps Mimetic's lab composition: personas, Observer bundle shape,
actor trace, redaction notes, and `verifyRun`.

## Run from this repository

```bash
pnpm install
pnpm build
npx tsx examples/state-driven-local-app/run-state-driven-local-app.ts
```

Expected output includes:

```json
{
  "ok": true,
  "completionReason": "goal_satisfied",
  "proof": "result.sandbox === undefined; No E2B sandbox was created.",
  "verify": true
}
```

## Copy into an npm consumer project

Install Mimetic and `tsx`, then copy `run-state-driven-local-app.ts` into your
project:

```bash
npm i -D mimetic-cli tsx
npx tsx run-state-driven-local-app.ts
```

Replace the synthetic `createSyntheticLocalApp()` with a bridge to your actual
already-running app, for example a thin Playwright `page.evaluate` wrapper around
`window.app.getState()` and `window.app.sendChat(text)`. Keep the same safety
shape: do not persist raw app state, use synthetic data, and keep public-bound
artifacts redacted.
