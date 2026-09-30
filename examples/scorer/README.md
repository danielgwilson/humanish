# Score a run with your own rubric

[scorer.mjs](scorer.mjs) is a scorer module: humanish calls its `score` over the finished
evidence of a computer-use, shared-world or terminal run and stores the result as
`bundle.adapterScore`, under your namespace. A module may also export `deriveFeedback` and
`deriveArtifacts`; the `AdapterScorerModule` type describes all three.

[run.mjs](run.mjs) attaches the same module to a dry run of one computer-use lab in two ways:

- from a library caller, as `runLab(config, { scorer: { score } })`;
- from the CLI, as `humanish lab run lab.yaml --dry-run --scorer scorer.mjs`.

A dry run needs no keys, desktop or running app. Each run's bundle carries the score, and
`verifyRun` checks it. The CLI run also records which module it loaded, as
`bundle.scorerProvenance`.

## Run from an npm installation

```bash
npm init -y
npm install humanish
node node_modules/humanish/examples/scorer/run.mjs
```

It creates a temporary project directory, prints both run ids with their scores, and exits
non-zero if either run lacks a verified score.

A scorer is executable code that runs in the humanish process. Review it as code, not as
configuration; the CLI prints the same warning when it loads one.
