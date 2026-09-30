# AGENTS.md

humanish runs persona studies: AI participants use a target app, CLI or agent-facing flow on
hosted or local desktops, and every run leaves a verifiable evidence bundle. Run bundles are the
source of truth; the Observer is their review surface.

Sub-guides take precedence inside their directories: [observer/](observer/AGENTS.md),
[tui/](tui/AGENTS.md), [site/](site/AGENTS.md). The reasoning behind the rules below is in
[docs/principles/engineering.md](docs/principles/engineering.md). [CONTEXT.md](CONTEXT.md) defines
the domain terms, and [docs/decisions/](docs/decisions/README.md) records the decisions that
shape the code.

## Commands

Node >= 22.19.0, pnpm 12 (`packageManager` pins the version).

```bash
pnpm install
pnpm humanish <command>          # run the CLI from source (tsx src/cli.ts)
pnpm vitest run tests/<file>     # one test file
pnpm format                      # oxfmt; run before every commit
pnpm check                       # the full local gate (below)
pnpm release:check               # check + public-surface scan + skill check + pack; CI runs this
```

`pnpm check` runs format:check, lint (oxlint, type-aware), knip, prose:check, typecheck, the
vitest suite, the TUI tests, build, the startup proofs and a TUI smoke test. After changing a
CLI option, run `pnpm docs:generate`; CI fails on a stale `site/content/docs/cli.mdx`. Observer
changes also need `pnpm build` and the four `observer:*:proof` scripts, which CI's observer job
runs in Chromium.

Two counts are capped in package.json and only go down: oxlint warnings (`--max-warnings`) and
comment prose (`prose:check`). Lower a cap in the PR that reduces its count.

## Layout

| Path                                                                        | What it holds                                                                                                                                                                     |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cli.ts`, `src/index.ts`                                                | The package bin and its only library export surface                                                                                                                               |
| `src/cli/`                                                                  | Command registration (`program.ts`), argv, env files, keys, telemetry                                                                                                             |
| `src/lab/`                                                                  | Lab manifests: parsing (`config.ts`, `keys.ts`), discovery, preflight, personas, tasks, and `engine.ts`, whose `selectLabBackend` picks the route                                 |
| `src/routes/`                                                               | One folder per route: `computer-use/`, `shared-world/`, `terminal/`, `scripted-browser.ts`                                                                                        |
| `src/actors/`                                                               | What drives a participant: the contract and registry, `computer-use/` (loop, OpenAI provider), `codex/`, `local-agent/`, and the Claude, pi, scripted-browser and terminal actors |
| `src/substrates/`                                                           | Where participants run: `e2b/` hosted desktops and `local/` Firecracker and Lima VMs                                                                                              |
| `src/run/`                                                                  | Run bundles: types (`bundle.ts`), the dry run (`dry-run.ts`), `verifyRun` (`verify.ts`), paths, status, index, costs, reclaim                                                     |
| `src/evidence/`                                                             | Redaction, screenshots, recordings and artifact references                                                                                                                        |
| `src/analysis/`, `src/comms/`, `src/feedback/`, `src/observer/`, `src/tui/` | Study analysis, email capture, feedback and export, the Observer's host side, the CLI side of `humanish tui`                                                                      |
| `src/browser-control/`                                                      | The host-guest browser control protocol                                                                                                                                           |
| `src/guest-*.ts`                                                            | The guest runtime. These stay at the root of `src/`: the guest image launches `guest-runtime-main.js` by path                                                                     |
| `observer/`, `tui/`, `site/`                                                | Workspaces: the Observer artifact, the Ink app, humanish.dev                                                                                                                      |
| `humanish/`                                                                 | The repo's own study source: labs, personas, scenarios, fixtures                                                                                                                  |
| `runtime/`                                                                  | Desktop and browser image recipes (Python build scripts)                                                                                                                          |
| `scripts/`                                                                  | Proof and release scripts run by package.json                                                                                                                                     |
| `docs/contracts/`                                                           | Bundle and schema contracts; documented fields are API                                                                                                                            |
| `tests/`                                                                    | vitest suites mirroring `src/`; `tests/fixtures/` and `tests/golden/` hold inputs and expected output                                                                             |

## Conventions

- TypeScript ESM with strict settings. No `any`; narrow `unknown` at the boundary.
- Keep files under about 700 lines and functions under about 150 (oxlint warns past both). Split
  when it helps a reader; do not add to `cli/program.ts` or `lab/config.ts` when a smaller
  module fits.
- Comments say why the code is the way it is. History, incident narratives, issue archaeology and
  PR numbers go in the commit message. `TODO(#123)` may link an open issue. No all-caps emphasis.
  `prose:check` counts violations in `src/`.
- Tests assert behavior. Do not pin prose in docs or comments with `toContain`. The default test
  timeout is 20 s. Provider-API fixtures come from captured wire shapes.
- New dependencies go in the pnpm catalog (`pnpm-workspace.yaml`) when more than one workspace
  uses them. Stay on the latest release; a comment next to the entry gives the reason for any
  older pin. knip fails on unused files, dependencies and exports.
- CLI results are truthful: reject unsupported execution before side effects, and keep useful
  evidence when a run is interrupted. Documented bundle schemas and artifact paths are contracts.

## Public Boundary

Assume this repository is public.

- Never commit or publish secrets, PII/PHI, private customer data, private source, or raw
  private transcripts or screenshots. Public examples are synthetic or redacted. Do not copy
  credential files or secret values into evidence, comments, docs, issues or PRs.
- Authorized local studies may keep private evidence in gitignored `.humanish/` under the
  capture and redaction rules. Local capture is not publication permission. See the
  [invariants](docs/principles/invariants-and-defaults.md) and the
  [public-readiness standard](docs/release/public-readiness-standard.md).
- Do not commit `.env*`, `.npmrc`, run bundles, runtime caches or packed tarballs.
- Naming the owner's other projects, products or domains in public material needs explicit
  sign-off. Use fictional examples. Named public third-party OSS study subjects are fine.

## Working

- Start from the [ramp](docs/ramp/README.md) and the current task; read the contract for the
  boundary you are changing. Historical plans do not authorize work.
- Keep `main` clean: one worktree and branch per task, reviewable commits, squash merges.
- Before adding a service, protocol, mode or framework, state the concrete need in the PR.
  Prefer removing an unnecessary mechanism to documenting around it.
- Verify in proportion to the change. Runtime changes need an execution check; claims of live
  behavior need a retained run bundle, since dry runs do not establish live behavior. PRs say
  what changed, what was checked and what was not.
- With shipping authority: push, open the PR, address checks, merge when green, fast-forward
  main and remove the worktree and branch. Releases follow the
  [release procedure](docs/release/open-source-readiness.md). Stay on `0.x` until the maintainer
  chooses 1.0; the minor after `0.99.0` is `0.100.0`.
