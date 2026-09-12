# Run a local app through its state contract

This complete library example starts a synthetic loopback HTTP app, reads its
state with a `CuaExecutor`, sends a greeting through its action endpoint, and
verifies the resulting Humanish run. It uses a deterministic `CuaProvider` with
no model calls, API keys, browser, screenshots or E2B resources. It demonstrates
the integration; it does not test persona behavior or the quality of an app's UI.

## Run from an npm installation

Use Node.js 20.3 or later (`AbortSignal.any`), in a new directory:

```bash
npm init -y
npm install humanish
node node_modules/humanish/docs/architecture/examples/state-driven-local-app/runner.mjs
```

The package includes both [runner.mjs](runner.mjs) and [app.mjs](app.mjs).
No checkout, TypeScript loader or initialization command is needed. Each
invocation starts a fresh app and writes a new run under `.humanish/runs/` in
your current directory. Run the last command again for an independent repeat.
Add `.humanish/` to your project's `.gitignore` before adapting this example to
real app data; running the library directly does not create that ignore rule.

Expected output includes `goal_satisfied`, `sandboxCreated: false`, zero
screenshots, a successful `verification`, and a synthetic app receipt with
`greeted: true` and `messages: 1`. The final cleanup line shows
`serverClosed: true`; `finally` closes the server even when the run or verification
fails. The evidence remains on disk.

Review the bundle and its sharing grade:

```bash
npx humanish verify --run latest --json
npx humanish review --run latest --json
```

`appState` drives the loop in memory and is not persisted in the actor trace.
This example separately prints only its own synthetic counters. A successful
verification describes the evidence bundle, not persona efficacy or human
task completion. The reported cost basis comes from executing only local code
and loopback requests; absent model usage is not treated as a billing receipt.

## Adapt the two ports

In `runner.mjs`, replace `createAppContractExecutor` with your trusted bridge to
your app's `getState()` and actions. Here those calls use `GET /state` and
`POST /chat`; a browser bridge could call `window.app` through `page.evaluate`.
Map supported actions explicitly and reject unsupported ones. Forward the
optional execution signal and check it before dispatching an input.

Replace the deterministic provider if you want a model to choose actions from
`request.observation.appState`. Keep `requiresFrame: false` for a state-only
provider. Your replacement owns its model credentials and costs. The
`openai-computer-use` actor id selects the registered CUA route; the injected
`buildProvider` chooses the actual provider, so this example never invokes OpenAI.

The runner shows both required discriminant checks: `parseLabConfig` receives
an object containing `schema: LAB_CONFIG_SCHEMA` and is narrowed on `.ok`;
`runLab` is narrowed on `backend === "cua"` before inspecting its result.
Supplying both `buildExecutor` and `buildProvider` selects the library-assisted
route. It is not a config-only CLI actor or an out-of-tree actor registration API.

Both JavaScript files carry JSDoc types against the public `humanish` exports.
To check an installed copy against its packaged declarations:

```bash
npm install --save-dev typescript @types/node@20
npx tsc --allowJs --checkJs --noEmit --strict --skipLibCheck --types node --target ES2022 --module NodeNext --moduleResolution NodeNext node_modules/humanish/docs/architecture/examples/state-driven-local-app/*.mjs
```

See the [state-driven executor guide](../../state-driven-executor.md) for progress
projection limits, runtime-only state, unpinned local-app provenance, and the
fail-closed guards on this route.
