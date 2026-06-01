# Project Layout Contract

Date: 2026-06-01

Status: target layout for apps that install `mimetic-cli`.

## Decision

Use two roots:

```text
mimetic/   # committed source of simulation intent
.mimetic/  # ignored runtime state, evidence, local overlays, and secrets
```

Do not gitignore all Mimetic state. Personas, scenarios, policies, adapters,
coverage maps, and review vocabulary are the harness. They must be versioned,
reviewed, and reproducible from a clean clone.

Do not commit run bundles, raw screenshots, browser traces, transcripts,
draft issue bodies before verification, local auth, local overrides, or secrets.

## Committed Source Plane

`mimetic/` is the project-owned simulation contract:

```text
mimetic/
  README.md
  config.ts
  personas/
    synthetic-new-user.yaml
    skeptical-power-user.yaml
  scenarios/
    first-run-smoke.yaml
    onboarding-regression.yaml
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

Committed files must be public-safe:

- synthetic personas only;
- synthetic or redacted fixtures only;
- env var names only, never values;
- no PHI, PII, keys, tokens, raw private transcripts, real screenshots, real
  customer data, or real patient data.

Changing a scenario or persona is equivalent to changing a test. It should be
visible in PR review.

## Ignored Runtime Plane

`.mimetic/` is local/generated state:

```text
.mimetic/
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
  local/
  secrets/
```

Default `.gitignore` entry:

```gitignore
.mimetic/
.env*
```

If a target repo already uses `.env.example`, preserve its existing exception.

## Local Overrides

When a team needs private local personas or credentials, use ignored overlays:

```text
.mimetic/local/personas/*.yaml
.mimetic/local/policies/*.yaml
.mimetic/secrets/*
```

The CLI should warn that local overlays cannot be used for reproducible CI or
public issue drafts unless redacted into committed synthetic equivalents.

## CI And Reproducibility

CI should reproduce proof from committed inputs:

- app commit;
- `mimetic-cli` version;
- `mimetic/config.ts`;
- scenario and persona catalog;
- policy files;
- synthetic fixtures;
- declared env var names.

CI should store generated run bundles as artifacts, not commit them.

## Why Not `.mimetic/` For Everything?

A fully ignored `.mimetic/` makes setup feel tidy, but it hides the product
contract. Future agents and contributors cannot see what the harness is meant
to prove, CI cannot validate it from a clean clone, and PR review cannot catch
weakened personas or dropped hard paths.

A partially tracked dotdir is possible but worse UX. Dotdirs read as local,
editors hide them, and negated gitignore rules are easy to break. A visible
`mimetic/` source root plus ignored `.mimetic/` runtime root is clearer.

