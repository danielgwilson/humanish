# Contributing

Thanks for helping make Humanish better.

## Ground Rules

- Follow [engineering judgment](AGENTS.md#engineering-judgment): prefer simple,
  idiomatic implementations and reuse established components. Validate the changed
  behavior and material risks; keep required CI and release gates.
- Keep examples synthetic and public-safe.
- Do not commit `.env*`, `.npmrc`, `.humanish/`, generated run bundles, provider
  credentials, private screenshots, raw transcripts, or customer data.
- Prefer small PRs with explicit proof commands.
- Keep product-specific route names, milestones, and vocabulary in adapters.
- For changes to credentials, provider spend, hosted execution or GitHub mutation,
  state the relevant authority and failure boundaries. Use dry runs where useful;
  they do not establish live behavior.

## Local Setup

```bash
pnpm install
pnpm check
pnpm public-surface:scan
```

## Useful Commands

```bash
pnpm humanish -- --help
pnpm humanish -- watch --json --no-open
pnpm humanish -- verify --run latest --json
pnpm pack:dry-run
```

## Pull Requests

PRs should include:

- a concise summary;
- why the design is the simplest adequate option, when adding architectural complexity;
- proof commands and outcomes;
- any remaining gaps;
- confirmation that fixtures and examples are synthetic or redacted.
