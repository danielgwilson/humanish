# Project Layout

`humanish init` gives a project two roots:

```text
humanish/   # committed study source
.humanish/  # ignored runtime state, evidence and local overrides
```

## Committed study source: `humanish/`

`init` writes:

```text
humanish/
  README.md
  labs/
    first-run.yaml          # keyless preview
    try-live.yaml           # first live study
    cua-browser.yaml        # computer-use participants on a hosted desktop
    local-browser.yaml      # computer-use participants on a local desktop
    lobby-trivia-3player.yaml
  personas/
    synthetic-new-user.yaml
    skeptical-power-user.yaml
  scenarios/
    first-run-smoke.yaml
    onboarding-regression.yaml
  coverage-map.md
  coverage-matrix.md
```

Labs select their subject, actors, personas, scenarios, tasks, budgets and
policies. Personas and scenarios are referenced by id. An adopter scorer is an
`.mjs` module that a lab names under `review.scorer.ref`.

Keep this directory reviewable and reproducible from a clean clone. Everything in
it is public-safe: synthetic personas and fixtures, env var names without values.

## Ignored runtime state: `.humanish/`

```text
.humanish/
  runs/           # run bundles, screenshots, transcripts, Observer output
  labs/           # private labs; a committed lab with the same id wins
  local/labs/     # machine-local labs
  local/personas/ # created by init, not read yet; personas resolve from humanish/personas/
  cache/ tmp/ logs/
```

Never commit run bundles, raw screenshots, transcripts, local overrides or
secrets. `init` adds `.humanish/` to `.gitignore`.

## Formats

- `.yaml` for human-authored study source: labs, personas, scenarios.
  Prefer `.yaml` over `.yml`.
- `.mjs` for executable adopter scorers.
- `.json` for generated artifacts and synthetic fixtures; `.ndjson` for
  appendable event and transcript streams.
- `.yml` only where an outside tool expects it, such as
  `.github/workflows/*.yml`.
