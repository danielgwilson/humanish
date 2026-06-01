# Goal: Mimetic CLI Open-Source V0

## Objective

Build the first open-source-safe `mimetic-cli` v0 slice: npm package scaffold,
`commander` CLI, safe `init`, committed `mimetic/` source layout, ignored
`.mimetic/` runtime layout, synthetic dry-run bundle, verifier, static observer
stub, and public-safe feedback issue draft.

## Source Of Truth

- `docs/product/open-source-install-experience.md`
- `docs/architecture/project-layout.md`
- `docs/roadmap/world-class-open-source-v0.md`
- `docs/contracts/feedback.md`
- `docs/architecture/github-feedback-loop.md`
- GitHub issues in the `mimetic-cli` project

Primary implementation tickets:

- [#13 package scaffold](https://github.com/danielgwilson/mimetic-cli/issues/13)
- [#14 init layout](https://github.com/danielgwilson/mimetic-cli/issues/14)
- [#16 fixture app](https://github.com/danielgwilson/mimetic-cli/issues/16)
- [#7 CLI dry-run/review/verify/watch](https://github.com/danielgwilson/mimetic-cli/issues/7)
- [#6 core primitives](https://github.com/danielgwilson/mimetic-cli/issues/6)
- [#10 observer](https://github.com/danielgwilson/mimetic-cli/issues/10)
- [#5 public feedback issue draft](https://github.com/danielgwilson/mimetic-cli/issues/5)
- [#15 agent skill](https://github.com/danielgwilson/mimetic-cli/issues/15)
- [#17 release readiness](https://github.com/danielgwilson/mimetic-cli/issues/17)

## Allowed Scope

Allowed write paths:

- `package.json`
- `pnpm-lock.yaml`
- `tsconfig*.json`
- `src/**`
- `tests/**`
- `fixtures/**`
- `templates/**`
- `docs/**`
- `.github/**`
- `.gitignore`
- `README.md`
- `AGENTS.md`

Allowed operations:

- create feature worktrees under `../worktrees/`;
- use `pnpm` and Node tooling;
- add dev dependencies needed for CLI, tests, schemas, and observer;
- create and merge scoped PRs after proof;
- update GitHub issues with proof comments.

## Non-Goals

- live E2B execution;
- OpenAI/computer-use actor;
- live GitHub issue creation or Project mutation from the public CLI;
- hosted queues, databases, webhooks, or private infrastructure;
- provider spend;
- deploys;
- production data;
- private source-system artifact imports;
- real PII, PHI, secrets, keys, tokens, screenshots, transcripts, customer data,
  or patient data.

## Proof Commands

Use the strongest available set as the package is scaffolded:

```bash
pnpm install
pnpm check
pnpm test
pnpm typecheck
pnpm mimetic -- --help
pnpm mimetic -- init --dry-run --json
pnpm mimetic -- run --dry-run --json
pnpm mimetic -- verify --run latest --json
pnpm mimetic -- feedback issue --run latest --repo example/app --format markdown
```

Before scripts exist, use:

```bash
git diff --check
ruby -ryaml -e 'ARGV.each { |f| YAML.load_file(f); puts "ok #{f}" }' .github/labels.yml .github/ISSUE_TEMPLATE/*.yml
```

## Proof Artifacts

- PR URLs;
- command outputs summarized in PR bodies or issue comments;
- `.mimetic/runs/<run-id>` local/CI artifact paths;
- generated observer path or screenshot when available;
- feedback issue draft markdown;
- verification JSON.

Do not commit generated run bundles.

## Autonomy Rails

- Work in small PRs.
- Keep committed examples synthetic and public-safe.
- Treat docs/contracts as source of truth before implementation.
- Update issue comments with proof when closing work.
- Use Projects as cockpit only; issue bodies and PR proof are canonical.
- Prefer dry-run and fixture proof before live substrate work.

## Stop And Ask

Stop before:

- adding or reading `.env*` or secret files;
- using production data, PHI, PII, real customer data, or real patient data;
- adding live GitHub mutation to the public CLI;
- introducing E2B, OpenAI, provider spend, public tunnels, payments, deploys, or
  hosted infra;
- touching destructive git/filesystem operations;
- widening scope from v0 dry-run/open-source setup into live agent execution.

## Completion Audit

Do not mark complete until every requirement below maps to evidence:

- npm package scaffold exists;
- `mimetic` binary uses `commander` and has useful help;
- `mimetic init` can scaffold a target fixture safely;
- committed `mimetic/` and ignored `.mimetic/` layout is implemented;
- dry-run bundle is generated from synthetic inputs;
- `verify` validates the bundle;
- observer can render a bundle or a documented stub;
- `feedback issue` emits public-safe issue markdown with no GitHub mutation;
- docs and skill guidance explain installation and setup;
- proof commands pass;
- no sensitive/private data is committed.

## Suggested Slash Goal

```text
/goal Follow docs/goals/mimetic-cli-open-source-v0/goal.md as the source of truth; implement the first open-source-safe Mimetic CLI v0 in small PRs; keep changes scoped to the allowed paths; update receipts after each meaningful slice; run the listed proof commands as they become available; pause before secrets, PII, PHI, provider spend, E2B/OpenAI live runs, deploys, hosted infra, live GitHub mutation from the public CLI, destructive operations, or scope expansion.
```
