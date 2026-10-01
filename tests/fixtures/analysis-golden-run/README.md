# analysis-golden-run

`run.json` is the bundle `runDryRun` wrote for `fixtures/minimal-app` with run id
`analysis-golden`, on the code at the commit that added it. `tests/analysis/analyze-golden.test.ts`
replaces the dry run's `run.json` with this file, so the analysis golden
(`tests/golden/analysis/analyze-study.json`) moves only when analysis code or this file changes.
Dry-run wording is pinned by `tests/golden/routes/preview-dry-run.json` and
`tests/golden/labs/first-run.json`.

Regenerate it only when the bundle schema changes so that this file no longer parses as a bundle.
