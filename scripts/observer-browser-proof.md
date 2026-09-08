# Observer browser regression proof

This checks the **built Observer renderer** in Chromium against synthetic
recordings and a controlled local HTTP snapshot endpoint. It covers cropping,
phone overflow, live/replay navigation, polling failure and recovery, stream
allocation, and long recordings. It does not substitute for actual provider
connection/cleanup, CLI/TUI attachment, or export integration acceptance.

```bash
pnpm install --frozen-lockfile
pnpm --filter humanish-observer build
pnpm exec playwright-core install chromium
node scripts/observer-browser-proof.mjs
```

The browser installation uses the repository's resolved `playwright-core`
version. On Linux CI, use `pnpm exec playwright-core install --with-deps chromium`.
An existing Chromium can be selected with `HUMANISH_BROWSER_EXECUTABLE`; the
script also checks Playwright's browser cache and common system paths.

Each invocation writes a new, gitignored `.humanish/observer-browser-proof/`
directory containing an HTML gallery, strict JSON coverage manifest, screenshot
strips, measured DOM state, HTTP receipts, and generated source PNGs. It refuses
to overwrite an existing output directory. The fixtures contain only generated
pixels and fictional participant data. The browser blocks unexpected external
network requests; no credentials or provider setup are used.

The built artifact can be selected explicitly. One case can be rerun while
debugging; unselected cases remain visibly `not-run` in that report:

```bash
node scripts/observer-browser-proof.mjs --artifact observer/dist/index.html --case paused-growth
```

`scripts/observer-browser-coverage.json` is the declared coverage ledger. Every
local case must produce one result; errors fail the command while retaining
evidence. `localCasesPass` describes only those cases. `coverageComplete` remains
false while the manifest lists uncovered or externally required acceptance.
Do not describe a local green report as complete Observer release acceptance.

The intentionally malformed/failed HTTP snapshots exercise the real production
renderer and polling code. The desktop iframe is explicitly a controlled local
surface, so its presence proves viewing transitions and allocation only. Actual
provider reconnection and desktop read-only behavior need separate retained
receipts. The generated fixture is an Observer projection contract fixture,
not a purported capture of a provider wire response.

Geometry checks use decoded image dimensions, computed object fitting, and
clipping ancestors; screenshots contain distinct colored markers at all four
corners for independent visual inspection. The gallery and failed-state JSON
should be reviewed alongside passing assertions. The harness's own baseline
must fail on known regressions rather than adapting expected values to them.

To gate CI, build Observer and run the command after installing the matched
Chromium. Upload only `.humanish/observer-browser-proof/` on success and failure;
that directory is synthetic proof. If an artifact uploader ignores hidden
directories, enable hidden-file inclusion for this exact path, never for all
of `.humanish/` or the checkout.

Current primary reference: [Playwright browser installation](https://playwright.dev/docs/browsers).
