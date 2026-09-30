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

## Make your first change

This walkthrough changes the persona a computer-use lane gets when neither the lane nor the actor
names one. It runs offline and spends nothing.

1. Change the `"cua-operator"` fallback in `composeLaneInstructions`
   (`src/routes/computer-use/lane-plan.ts`).
2. Run `pnpm vitest run tests/lane-persona-fallback.test.ts`. It fails because it asserts the old
   id. Update the assertion once the new id is what you want.
3. Copy `humanish/labs/dwell-window-todomvc.yaml` to `.humanish/local/labs/walkthrough.yaml`.
   Change its `id` to `walkthrough` and delete its `persona:` line.
4. Run `pnpm humanish run walkthrough --dry-run --no-open`. Read `.humanish/runs/latest.json` for
   the run id, then check `persona.id` in `.humanish/runs/<runId>/run.json`.
5. Run `pnpm humanish verify --run latest`, then `pnpm format` and `pnpm check`.

Common changes touch these tests and contracts:

| Change                    | Tests                                                                        | Contract or doc to update                                          |
| ------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| A lab manifest field      | `tests/lab/config.test.ts`, the route's tests                                | `docs/contracts/schemas.md`, `site/content/docs/lab-manifests.mdx` |
| A CLI option              | the command's tests under `tests/cli/`                                       | Run `pnpm docs:generate` to update `site/content/docs/cli.mdx`     |
| A `run.json` field        | the route's tests; rerun them with `-u` to update `tests/golden/routes/`     | `docs/contracts/run-bundle.md`                                     |
| Observer data             | `tests/observer/data-contract.test.ts` with `UPDATE_OBSERVER_DATA_GOLDENS=1` | `docs/architecture/observer.md`                                    |
| Observer UI               | `observer/tests/` and the four `observer:*:proof` scripts                    | `observer/AGENTS.md`                                               |
| A route's behavior        | `tests/routes/<route>/`, `tests/lab/task-route-preflight.test.ts`            | the support matrix in `docs/ramp/README.md`                        |
| An actor                  | `tests/actors/`, `tests/actors/conformance.test.ts`                          | `docs/architecture/actor-contract.md`                              |
| Redaction or share safety | `tests/evidence/`, `tests/run/transient-comms-secrets.test.ts`               | `docs/contracts/policy.md`                                         |
| Study analysis            | `tests/analysis/`                                                            | `docs/contracts/study-analysis.md`                                 |
| A public export           | `pnpm build` and `pnpm api:proof` (`--update` to accept)                     | `tests/golden/public-api.json`                                     |
| An example                | `pnpm build` and `pnpm api:proof`, which runs every example                  | `examples/README.md`                                               |

Three folders hold fixtures. `tests/fixtures/` holds test inputs, `humanish/fixtures/` holds the
synthetic apps this repo's own labs start, and the root `fixtures/` holds synthetic apps and cases
that several tests and scripts copy, such as `fixtures/minimal-app/`.

## Pull Requests

PRs should include:

- a concise summary;
- why the design is the simplest adequate option, when adding architectural complexity;
- proof commands and outcomes;
- any remaining gaps;
- confirmation that fixtures and examples are synthetic or redacted.
