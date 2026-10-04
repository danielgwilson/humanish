# Contributing

Thanks for helping make humanish better.

## Make your first change

Set up a checkout first ([Local Setup](#local-setup)). This walkthrough changes the persona id a computer-use participant gets when neither the
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
4. Run `mkdir -p .humanish/local/studies`, then copy `humanish/studies/dwell-window-todomvc.yaml`
   to `.humanish/local/studies/walkthrough.yaml`. Change its `id` to `walkthrough` and delete its
   `persona:` line.
5. Run `pnpm humanish run walkthrough --dry-run --no-open`. It prints the run id on its `run:`
   line. Check `persona.id` in `.humanish/runs/<runId>/run.json`.
6. Run `pnpm humanish verify --run latest`, then `pnpm format` and `pnpm release:check`.

## Look up how the code works

Open these when a step needs them:

- [README.md](README.md): what humanish does and how a user runs a study.
- [ARCHITECTURE.md](ARCHITECTURE.md): `humanish run <study>` traced through the code, the code map
  and the invariants a change must keep.
- [CONTEXT.md](CONTEXT.md): the domain terms and the field spellings that map to them.
- [docs/ramp/README.md](docs/ramp/README.md): current state, how to pick work and the quality bar.
- [docs/README.md](https://github.com/danielgwilson/humanish/blob/main/docs/README.md): the rest
  of `docs/`, sorted into guides, reference, design records and history.

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

`release:check` runs `pnpm check` (format, lint, knip, the prose, vocabulary and site CSS caps, typecheck,
the test suites, build and the startup proofs), then `api:proof`, `public-surface:scan`,
`skill:check` and `npm pack --dry-run`. On a 16-core Linux machine it takes about 6 minutes, 4 of
them in `pnpm check`. The test step prints nothing for a few minutes while it runs. `skill:check`
runs the pinned `skills` devDependency, so it needs no network after `pnpm install`.

Name a local experiment `*.scratch.test.ts`. vitest skips that suffix, so the file never runs in
the suite or in CI.

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

`pnpm format` rewrites files with oxfmt. `pnpm check` fails on unformatted files. It also holds four
counts to caps: oxlint warnings (`lint`, capped in package.json), prose in comments and test names
under `src/`, `tests/`, `scripts/`, `tui/`, `observer/` and `site/`'s source files, and in the root
guides, `docs/` outside `docs/history/` and the site's docs pages (`prose:check`: issue references,
`FIX-N` tags, all-caps emphasis, em dashes, invariant numbers, review labels, contrast frames in
docs and the other kinds listed at the top of `scripts/check-code-prose.mjs`, which also counts the
text of `src/` string literals), and identifiers and file names in `src/` outside the exempt
contract modules that still say a retired participant word (lane, seat, role or sim) or lab
(`vocabulary:check`), and hex colors written into rules, classes no site component names, and px
font sizes, spacing and radii written into rules instead of read from the scale tokens, in the site
and Observer stylesheets (`site-css:check`).
A study is what a user designs and runs, and a run is one execution of it; lab is the old name for a
study. The last three read their caps from `scripts/caps.json`. Each check fails when its count
rises above the cap and also when it falls below it, so the PR that reduces a count lowers the cap
in the same commit; the failure message names the cap and the new value. A count with no cap fails
as well. CI's `caps` workflow (`scripts/check-cap-direction.mjs`) also fails a PR that raises or
removes a cap against the base branch, unless the PR has the `raise-cap` label and a `Cap raise:`
line in its body that says why. `pnpm lint` prints the warnings that already exist, several hundred
of them; that is expected. `pnpm knip` fails on unused files, dependencies and exports, and on any
import cycle.

## Useful Commands

```bash
pnpm humanish --help
pnpm humanish watch --json --no-open
pnpm humanish verify --run latest --json
pnpm pack:dry-run
```

## Find the tests for a change

Common changes touch these tests and contracts:

| Change                    | Tests                                                                                                                                                        | Contract or doc to update                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| A study file field        | `tests/study/config.test.ts`, the route's tests. Its cases pin each study's warnings, so a new warning fails cases that expect none                          | `site/content/docs/study-files.mdx` (docs:check fails without a row), `docs/contracts/schemas.md` |
| A CLI option              | the command's tests under `tests/cli/`                                                                                                                       | Run `pnpm docs:generate` to update `site/content/docs/cli.mdx`                                    |
| A `run.json` field        | the route's tests; rerun them with `-u` to update `tests/golden/routes/` and `tests/golden/failures/<route>/`                                                | `docs/contracts/run-bundle.md`                                                                    |
| An actor trace field      | `tests/actors/`, `tests/actors/conformance.test.ts`, then the route goldens with `-u`                                                                        | `docs/contracts/schemas.md#actor-trace`, `docs/architecture/actor-contract.md`                    |
| Observer data             | `tests/observer/data-contract.test.ts` with `UPDATE_OBSERVER_DATA_GOLDENS=1`                                                                                 | `docs/architecture/observer.md`                                                                   |
| Observer UI               | `observer/tests/` and the four `observer:*:proof` scripts                                                                                                    | `observer/README.md`                                                                              |
| A route's behavior        | the route's folder in `tests/routes/` (the scripted route's main suite is `tests/routes/scripted/route.test.ts`), `tests/study/task-route-preflight.test.ts` | the support matrix in `docs/ramp/README.md`                                                       |
| An actor                  | `tests/actors/`, `tests/actors/conformance.test.ts`                                                                                                          | `docs/architecture/actor-contract.md`                                                             |
| Redaction or share safety | `tests/evidence/`, `tests/run/transient-comms-secrets.test.ts`                                                                                               | `docs/contracts/policy.md`                                                                        |
| Study analysis            | `tests/analysis/`                                                                                                                                            | `docs/contracts/study-analysis.md`                                                                |
| A public export           | `pnpm build` and `pnpm api:proof` (`--update` to accept)                                                                                                     | `tests/golden/public-api.json`, and a doc comment on the declaration                              |
| An example                | `pnpm build` and `pnpm api:proof`, which runs every example                                                                                                  | `examples/README.md`                                                                              |

Six folders hold fixtures:

- `tests/fixtures/`: test inputs.
- `humanish/fixtures/`: the synthetic apps this repo's own studies start.
- `fixtures/`: synthetic apps and cases that several tests and scripts copy, such as
  `fixtures/minimal-app/`.
- `adapters/fixtures/`: the adapter evidence shapes `tests/study/adapter-fixtures.test.ts` checks.
- `bench/fixtures/`: the TodoMVC patch and license `bench/todomvc-edit-study.md` uses.
- `scripts/fixtures/`: a synthetic two-person video room, a proof target for camera and
  microphone runs.

### Find the test folders outside the `src/` mirror

Most of `tests/` mirrors `src/`. Seven folders sit outside that mirror. `tests/admission/` pins what the CLI and the
library do when they refuse a study before a run starts, `tests/scripts/` tests `scripts/`, and `tests/bench/` tests the
benchmark scorer in `bench/` against recorded runs.
`tests/surface/` checks the README, the site, `site/public/llms.txt`, the agent skill and the package
against the shipped CLI. `tests/helpers/`, `tests/fixtures/` and `tests/golden/` hold shared test
code, inputs and goldens.

## Keep releases compatible

The [compatibility policy](README.md#check-the-compatibility-policy-before-upgrading) covers CLI
commands and flags, study file fields, the run bundle, `--json` output, exit and error codes, and
the library exports. A change to any of them follows three rules:

- To remove a name, deprecate it first. The deprecated name keeps working for at least 30 days
  and through at least one minor release, and the release notes say when it was deprecated.
- Hold a removal or another breaking change for the next batched breaking release. That minor
  release carries every breaking change at once, and its notes carry a migration table: each old
  form, its new form and the change to make.
- The study file schema (`humanish.study.v3`) and the run bundle schema
  (`humanish.run-bundle.v1`) are versioned. A breaking change to either one bumps its version;
  an additive optional field does not.

## Pull Requests

PRs should include:

- a concise summary;
- why the design is the simplest adequate option, when adding architectural complexity;
- proof commands and outcomes;
- any remaining gaps;
- confirmation that fixtures and examples are synthetic or redacted.
