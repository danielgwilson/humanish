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

[docs/README.md](https://github.com/danielgwilson/humanish/blob/main/docs/README.md) sorts the rest of `docs/` into guides, reference, design records
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
pnpm install --frozen-lockfile # as CI installs
pnpm vitest run tests/<file>   # while editing: one test file, a few seconds
pnpm docs:check                # after editing a doc: paths, anchors, symbols, the CLI reference
pnpm format                    # oxfmt; run before every commit
pnpm release:check             # once before pushing: the gate CI's test job runs
```

`release:check` runs `pnpm check` (format, lint, knip, the prose and vocabulary caps, typecheck,
the test suites, build and the startup proofs), then `api:proof`, `public-surface:scan`,
`skill:check` and `npm pack --dry-run`. On a 16-core Linux machine it takes about 6 minutes, 4 of
them in `pnpm check`. The test step prints nothing for a few minutes while it runs. `skill:check`
calls `npx skills`, so it needs network access.

CI (`.github/workflows/ci.yml`) runs six jobs on every pull request and every push to `main`:

| Job                          | What it runs                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `test` (Node 22.19.0 and 24) | `pnpm release:check`                                                                                                               |
| `site`                       | `pnpm docs:check`, then the site's typecheck, `registry:check` and build                                                           |
| `observer`                   | `pnpm build`, the Observer's typecheck and tests, `pnpm browser-control:proof` and the four `observer:*:proof` scripts in Chromium |
| `tui`                        | The TUI's typecheck and tests                                                                                                      |
| `guest-desktop`              | Builds the guest image and runs `pnpm guest-desktop:proof`, only when guest files change                                           |
| `secret-scan`                | gitleaks over the full git history                                                                                                 |

Two kinds of change need one more step:

- After changing a CLI option, run `pnpm docs:generate`. `pnpm docs:check` fails on a stale
  `site/content/docs/cli.mdx`.
- After changing what `src/index.ts` exports, run `pnpm build`, then `pnpm api:proof --update`, and
  review the diff to `tests/golden/public-api.json`. `pnpm api:proof` also runs `examples/` against
  the packed package.

`pnpm format` rewrites files with oxfmt. `pnpm check` fails on unformatted files.
It also holds three counts to caps in package.json: oxlint warnings (`lint`), prose in `src/`
comments (`prose:check`: issue references, `FIX-N` tags, all-caps emphasis), and identifiers in
`src/` outside the exempt contract modules that still say lane, seat, role, sim or study
(`vocabulary:check`). Each check fails when its count rises above the cap and also when it falls
below it, so the PR that reduces a count lowers the cap in the same commit; the failure message
names the flag and the new value. `pnpm lint` prints the warnings that already exist, several
hundred of them; that is expected. `pnpm knip` fails on unused files,
dependencies and exports, and on any import cycle.

## Useful Commands

```bash
pnpm humanish --help
pnpm humanish watch --json --no-open
pnpm humanish verify --run latest --json
pnpm pack:dry-run
```

## Make your first change

This walkthrough changes the persona id a computer-use participant gets when neither the
participant nor its actor names one. It runs offline and spends nothing. Two tests pin the id, and
the steps below update both.

1. Change `FALLBACK_PERSONA_ID` (`src/routes/computer-use/participant-prompt.ts`) from
   `"cua-operator"` to a new id.
2. Run `pnpm vitest run tests/routes/computer-use/lane-persona-fallback.test.ts`. It fails because
   it asserts the old id. Update the assertion once the new id is what you want.
3. Run `pnpm vitest run tests/routes/computer-use/local-vm.golden.test.ts`. It fails because the
   local VM golden, `tests/golden/routes/computer-use-local-vm-live.json`, records the persona id.
   Rerun it with `-u` to rewrite the golden, then check with `git diff tests/golden/` that only
   the persona id changed.
4. Run `mkdir -p .humanish/local/labs`, then copy `humanish/labs/dwell-window-todomvc.yaml` to
   `.humanish/local/labs/walkthrough.yaml`. Change its `id` to `walkthrough` and delete its
   `persona:` line.
5. Run `pnpm humanish run walkthrough --dry-run --no-open`. It prints the run id on its `run:`
   line. Check `persona.id` in `.humanish/runs/<runId>/run.json`.
6. Run `pnpm humanish verify --run latest`, then `pnpm format` and `pnpm release:check`.

Common changes touch these tests and contracts:

| Change                    | Tests                                                                                                                                                      | Contract or doc to update                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| A lab manifest field      | `tests/lab/config.test.ts`, the route's tests. Its cases pin each lab's warnings, so a new warning fails cases that expect none                            | `docs/contracts/schemas.md`, `site/content/docs/lab-manifests.mdx`             |
| A CLI option              | the command's tests under `tests/cli/`                                                                                                                     | Run `pnpm docs:generate` to update `site/content/docs/cli.mdx`                 |
| A `run.json` field        | the route's tests; rerun them with `-u` to update `tests/golden/routes/` and `tests/golden/failures/<route>/`                                              | `docs/contracts/run-bundle.md`                                                 |
| An actor trace field      | `tests/actors/`, `tests/actors/conformance.test.ts`, then the route goldens with `-u`                                                                      | `docs/contracts/schemas.md#actor-trace`, `docs/architecture/actor-contract.md` |
| Observer data             | `tests/observer/data-contract.test.ts` with `UPDATE_OBSERVER_DATA_GOLDENS=1`                                                                               | `docs/architecture/observer.md`                                                |
| Observer UI               | `observer/tests/` and the four `observer:*:proof` scripts                                                                                                  | `observer/AGENTS.md`                                                           |
| A route's behavior        | the route's folder in `tests/routes/` (the scripted route's main suite is `tests/routes/scripted/route.test.ts`), `tests/lab/task-route-preflight.test.ts` | the support matrix in `docs/ramp/README.md`                                    |
| An actor                  | `tests/actors/`, `tests/actors/conformance.test.ts`                                                                                                        | `docs/architecture/actor-contract.md`                                          |
| Redaction or share safety | `tests/evidence/`, `tests/run/transient-comms-secrets.test.ts`                                                                                             | `docs/contracts/policy.md`                                                     |
| Study analysis            | `tests/analysis/`                                                                                                                                          | `docs/contracts/study-analysis.md`                                             |
| A public export           | `pnpm build` and `pnpm api:proof` (`--update` to accept)                                                                                                   | `tests/golden/public-api.json`                                                 |
| An example                | `pnpm build` and `pnpm api:proof`, which runs every example                                                                                                | `examples/README.md`                                                           |

Three folders hold fixtures. `tests/fixtures/` holds test inputs, `humanish/fixtures/` holds the
synthetic apps this repo's own labs start, and the root `fixtures/` holds synthetic apps and cases
that several tests and scripts copy, such as `fixtures/minimal-app/`.

### Find the test folders outside the `src/` mirror

Most of `tests/` mirrors `src/`. Six folders sit outside that mirror. `tests/admission/` pins what the CLI and the
library do when they refuse a lab before a run starts, and `tests/scripts/` tests `scripts/`.
`tests/surface/` checks the README, the site, `site/public/llms.txt`, the agent skill and the package
against the shipped CLI. `tests/helpers/`, `tests/fixtures/` and `tests/golden/` hold shared test
code, inputs and goldens.

## Pull Requests

PRs should include:

- a concise summary;
- why the design is the simplest adequate option, when adding architectural complexity;
- proof commands and outcomes;
- any remaining gaps;
- confirmation that fixtures and examples are synthetic or redacted.
