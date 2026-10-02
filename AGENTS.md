# AGENTS.md

humanish runs persona studies: AI participants use a target app, CLI or agent-facing flow on
hosted or local desktops, and every run leaves a verifiable evidence bundle. Run bundles are the
source of truth; the Observer is their review surface.

Sub-guides take precedence inside their directories: [observer/](https://github.com/danielgwilson/humanish/blob/main/observer/AGENTS.md),
[tui/](https://github.com/danielgwilson/humanish/blob/main/tui/AGENTS.md), [site/](https://github.com/danielgwilson/humanish/blob/main/site/AGENTS.md). The reasoning behind the rules below is in
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
pnpm release:check               # check + API proof + public-surface scan + skill check + pack; CI runs this
```

`pnpm check` runs format:check, lint (oxlint, type-aware), knip, prose:check, vocabulary:check,
typecheck, the vitest suite, the TUI tests, build, the startup proofs and a TUI smoke test. After
changing a CLI option, run `pnpm docs:generate`; CI fails on a stale `site/content/docs/cli.mdx`.
Observer changes also need `pnpm build` and the four `observer:*:proof` scripts, which CI's observer
job runs in Chromium. `pnpm api:proof` (after `pnpm build`) installs the packed tarball in a
temporary project, compares its export names with `tests/golden/public-api.json` and runs
`examples/`. After an intended export change, run `pnpm api:proof --update` and review the golden
diff.

Three counts are held to caps in package.json: oxlint warnings (`lint`, `--max-warnings`), comment
prose (`prose:check`) and the retired words lane, seat, role, sim and study in `src/` identifiers
and file names (`vocabulary:check`). Each checker fails when a count is above its cap or below it,
so the PR that reduces a count lowers its cap to the new count; the failure names the flag and the
value. A count with no flag fails too, naming the flag to add. CI's `caps` workflow fails a PR that
raises or removes a cap against the base branch, unless the PR has the `raise-cap` label and a
`Cap raise:` line in its body that says why.

## Layout

[ARCHITECTURE.md](ARCHITECTURE.md#find-the-code-for-each-part-of-the-system) maps each folder to
the file to read first. Keep these layout rules:

- `src/index.ts` is the package's only library export surface. `src/cli.ts` is its bin.
- `src/guest-runtime-main.ts`, `src/guest-runtime-revision.ts` and `src/guest-media-worker.ts`
  stay at the root of `src/`. `scripts/guest-runtime-package.mjs` and the image recipes in
  `runtime/` address their `dist/` output by file name. The rest of the guest runtime is in
  `src/guest/`.

## Conventions

- TypeScript ESM with strict settings. No `any`; narrow `unknown` at the boundary.
- Keep files under about 700 lines and functions under about 150 (oxlint warns past both). Split
  when it helps a reader; do not add to `src/routes/computer-use/route.ts` or
  `src/actors/computer-use/loop.ts` when a smaller module fits.
- Comments say why the code is the way it is. History, incident narratives, issue archaeology and
  PR numbers go in the commit message. `TODO(#123)` may link an open issue. No all-caps emphasis,
  and no em dashes (`—`, or two hyphens between spaces): use a colon, a comma or two sentences.
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

- Read the files in [CONTRIBUTING.md's reading order](CONTRIBUTING.md#read-these-in-order), then
  the current task; read the contract for the boundary you are changing. Historical plans do not
  authorize work.
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
