# Contributing

Thanks for helping make humanish better.

## Read these in order

1. [README.md](README.md): what humanish does and how a user runs a study.
2. This file: the ground rules, the commands and what a pull request needs.
3. [ARCHITECTURE.md](ARCHITECTURE.md): `humanish run <lab>` traced through the code, the code map
   and the invariants a change must keep.
4. [CONTEXT.md](CONTEXT.md): the domain terms and the field spellings that map to them.
5. [docs/ramp/README.md](docs/ramp/README.md), for depth: current state, how to pick work and the
   quality bar.

[docs/README.md](docs/README.md) sorts the rest of `docs/` into guides, reference, design records
and history.

## Ground Rules

- Follow [engineering principles](docs/principles/engineering.md): prefer simple,
  idiomatic implementations and reuse established components. Validate the changed
  behavior and material risks; keep required CI and release gates.
- Keep examples synthetic and public-safe.
- Do not commit `.env*`, `.npmrc`, `.humanish/`, generated run bundles, provider
  credentials, private screenshots, raw transcripts, or customer data.
- Prefer small PRs with explicit proof commands.
- Keep a target product's page names, milestones, and vocabulary in adapters.
- For changes to credentials, provider spend, hosted execution or GitHub mutation,
  state the relevant authority and failure boundaries. Use dry runs where useful;
  they do not establish live behavior.

## Local Setup

Use Node.js 22.19 or newer and pnpm 12; `packageManager` in `package.json` pins the pnpm version.

```bash
pnpm install
pnpm vitest run tests/<file>   # one test file: the fast loop
pnpm format                    # oxfmt; run before every commit
pnpm check                     # the full local gate
pnpm release:check             # what CI runs; run it before opening a pull request
```

Two kinds of change need one more step:

- After changing a CLI option, run `pnpm docs:generate`. CI fails on a stale
  `site/content/docs/cli.mdx`.
- After changing what `src/index.ts` exports, run `pnpm build`, then `pnpm api:proof --update`, and
  review the diff to `tests/golden/public-api.json`. `pnpm api:proof` also runs `examples/` against
  the packed package.

`pnpm format` rewrites files with oxfmt. `pnpm check` fails on unformatted files.
It also caps two counts in package.json: oxlint warnings (`lint`) and prose in `src/`
comments (`prose:check`: issue references, `FIX-N` tags, all-caps emphasis). The caps only
go down; lower one in the PR that reduces its count. `pnpm knip` fails on unused files,
dependencies and exports, and on import cycles other than the two listed in `knip.jsonc`.

## Useful Commands

```bash
pnpm humanish --help
pnpm humanish watch --json --no-open
pnpm humanish verify --run latest --json
pnpm pack:dry-run
```

## Pull Requests

PRs should include:

- a concise summary;
- why the design is the simplest adequate option, when adding architectural complexity;
- proof commands and outcomes;
- any remaining gaps;
- confirmation that fixtures and examples are synthetic or redacted.
