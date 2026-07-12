# Project Layout Contract

Date: 2026-06-01

Status: target layout for apps that install `humanish`.

## Decision

Use two roots:

```text
humanish/   # committed source of simulation intent
.humanish/  # ignored runtime state, evidence, local overlays, and secrets
```

Do not gitignore all Humanish state. Labs, personas, scenarios, policies,
adapters, coverage maps, and review vocabulary are the harness. They must be
versioned, reviewed, and reproducible from a clean clone.

Do not commit run bundles, raw screenshots, browser traces, transcripts,
draft issue bodies before verification, local auth, local overrides, or secrets.

## Committed Source Plane

`humanish/` is the project-owned simulation contract:

```text
humanish/
  README.md
  config.ts
  personas/
    synthetic-new-user.yaml
    skeptical-power-user.yaml
  scenarios/
    first-run-smoke.yaml
    onboarding-regression.yaml
  labs/
    first-run.yaml
  policies/
    redaction.yaml
    network.yaml
    credentials.example.yaml
  adapters/
    app.ts
  review/
    vocabulary.yaml
    milestones.yaml
  coverage-map.md
  coverage-matrix.md
  fixtures/
    synthetic-login-state.json
```

## Humanish Format Stack

Use formats based on who edits the file and how it is consumed:

- `.yaml` for human-authored Humanish source: personas, scenarios, policies,
  labs, review vocabulary, and review milestones. Prefer `.yaml` over `.yml`
  for Humanish-owned source files.
- `.ts` for executable project integration: `humanish/config.ts`, adapters,
  route catalogs, app launch plans, and logic that benefits from imports or
  type checking.
- `.json` for generated machine artifacts and synthetic fixtures: run bundles,
  observer data, review JSON, latest/history pointers, and fixture records.
- `.ndjson` for appendable event or transcript streams.
- `.yml` is acceptable for ecosystem files that conventionally use it, such as
  `.github/workflows/*.yml`; do not use `.yml` for Humanish-owned authored
  source.

Do not convert personas or scenarios to JSON because parser implementation is
easier. Keep authored simulation intent readable, then validate it through
schemas and CLI checks. TOML is not part of the current Humanish stack; add it
only if a concrete scalar global-config need appears that is better served by
TOML than YAML, TypeScript, or JSON.

Committed files must be public-safe:

- synthetic personas only;
- synthetic or redacted fixtures only;
- env var names only, never values;
- no PHI, PII, keys, tokens, raw private transcripts, real screenshots, real
  customer data, or real patient data.

Changing a scenario or persona is equivalent to changing a test. It should be
visible in PR review.

## Ignored Runtime Plane

`.humanish/` is local/generated state:

```text
.humanish/
  runs/
    <run-id>/
      run.json
      review.md
      review.json
      observer/
      screenshots/
      traces/
      terminal/
      feedback/
  cache/
  tmp/
  logs/
  labs/
  local/
    labs/
    personas/
    policies/
  secrets/
```

Default `.gitignore` entry:

```gitignore
.humanish/
.env*
```

If a target repo already uses `.env.example`, preserve its existing exception.

## Local Overrides

When a team needs private local personas or credentials, use ignored overlays:

```text
.humanish/local/personas/*.yaml
.humanish/local/policies/*.yaml
.humanish/local/labs/*.yaml
.humanish/labs/*.yaml
.humanish/secrets/*
```

Committed `humanish/labs/*.yaml` should be useful to anyone with a clean clone.
Ignored `.humanish/labs/*.yaml` and `.humanish/local/labs/*.yaml` are for
machine-specific or private dogfood labs. The CLI should warn that local
overlays cannot be used for reproducible CI or public issue drafts unless
redacted into committed synthetic equivalents.

## CI And Reproducibility

CI should reproduce proof from committed inputs:

- app commit;
- `humanish` version;
- `humanish/config.ts`;
- scenario and persona catalog;
- lab manifest;
- policy files;
- synthetic fixtures;
- declared env var names.

CI should store generated run bundles as artifacts, not commit them.

## Why Not `.humanish/` For Everything?

A fully ignored `.humanish/` makes setup feel tidy, but it hides the product
contract. Future agents and contributors cannot see what the harness is meant
to prove, CI cannot validate it from a clean clone, and PR review cannot catch
weakened personas or dropped hard paths.

A partially tracked dotdir is possible but worse UX. Dotdirs read as local,
editors hide them, and negated gitignore rules are easy to break. A visible
`humanish/` source root plus ignored `.humanish/` runtime root is clearer.
