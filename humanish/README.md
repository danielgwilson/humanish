# humanish/ in this repository

This directory is the committed study source for the humanish repository, which
studies humanish itself. `humanish init` creates the same layout in other projects.

- `labs/*.yaml`: lab manifests. Run one with `humanish lab run <lab>` or
  `humanish watch <lab>`.
- `personas/*.yaml`: persona definitions that labs reference by id.
- `scenarios/*.yaml`: scenario definitions, including executable browser steps
  under `browser.steps`.
- `fixtures/`: synthetic apps that labs start, such as the shared-world app.
- `coverage-map.md`, `coverage-matrix.md`: which product surfaces the labs cover.

Everything here is public: synthetic personas and fixtures, env var names without
values. Run bundles, screenshots, transcripts and local overrides go to the
gitignored `.humanish/`.

Authored source uses `.yaml`. Generated artifacts and fixtures use `.json` or
`.ndjson`. `.yml` is kept for outside tools such as GitHub Actions.
