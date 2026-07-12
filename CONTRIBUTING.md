# Contributing

Thanks for helping make Humanish better.

## Ground Rules

- Keep examples synthetic and public-safe.
- Do not commit `.env*`, `.npmrc`, `.humanish/`, generated run bundles, provider
  credentials, private screenshots, raw transcripts, or customer data.
- Prefer small PRs with explicit proof commands.
- Keep product-specific route names, milestones, and vocabulary in adapters.
- If a change touches credentials, provider spend, hosted execution, or GitHub
  mutation, document the stop conditions and use dry-run proof first.

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
- proof commands and outcomes;
- any remaining gaps;
- confirmation that fixtures and examples are synthetic or redacted.
