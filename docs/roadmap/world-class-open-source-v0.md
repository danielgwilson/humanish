# World-Class Open-Source V0 Roadmap

Date: 2026-06-01

Status: staged build plan for `mimetic-cli`.

## Target Outcome

A maintainer can install `mimetic-cli` into a normal JavaScript app, let their
coding agent run setup, and get a public-safe persona simulation harness with:

- committed `mimetic/` source plane;
- ignored `.mimetic/` runtime plane;
- `commander` CLI;
- safe `init`;
- synthetic dry-run bundle;
- verifier;
- observer;
- public-safe feedback issue draft;
- clear docs and agent skill.

## Stage 0: Repo Plan And Issue Queue

Status: complete enough to start implementation.

Proof:

- GitHub project `mimetic-cli`;
- seeded issues;
- future-public boundary docs;
- feedback issue-draft doctrine.
- layout/install/goal docs;
- implementation tickets for the install path.

Primary issue queue:

- [#13 package: scaffold npm package and Commander mimetic binary](https://github.com/danielgwilson/mimetic-cli/issues/13)
- [#14 init: scaffold committed mimetic source and ignored .mimetic runtime layout](https://github.com/danielgwilson/mimetic-cli/issues/14)
- [#16 fixtures: create target app fixture for init, dry-run, verify, and observer proof](https://github.com/danielgwilson/mimetic-cli/issues/16)
- [#7 cli: scaffold doctor, run --dry-run, review, verify, runs, and watch](https://github.com/danielgwilson/mimetic-cli/issues/7)
- [#6 core: run IDs, artifact paths, git state, history, and lifecycle primitives](https://github.com/danielgwilson/mimetic-cli/issues/6)
- [#10 observer: static mission-control viewer over fixture bundle](https://github.com/danielgwilson/mimetic-cli/issues/10)
- [#5 feedback: specify public issue-draft CLI command](https://github.com/danielgwilson/mimetic-cli/issues/5)
- [#15 skill: package agent setup guidance for installing Mimetic](https://github.com/danielgwilson/mimetic-cli/issues/15)
- [#17 release: open-source readiness, package metadata, license, and publish dry-run](https://github.com/danielgwilson/mimetic-cli/issues/17)

## Stage 1: Package Scaffold

Build the minimum npm package:

- `package.json`;
- TypeScript config;
- `src/cli.ts`;
- `commander`;
- test runner;
- lint/typecheck/check scripts;
- binary name `mimetic`;
- stable JSON command envelope.

Proof:

```bash
pnpm install
pnpm check
pnpm mimetic -- --help
```

## Stage 2: Project Layout And Init

Implement `mimetic init`:

- creates committed `mimetic/`;
- creates ignored `.mimetic/`;
- writes starter synthetic personas/scenarios/policies;
- patches `package.json` scripts;
- updates `.gitignore`;
- supports `--dry-run`, `--yes`, and `--json`.

Proof:

```bash
pnpm test
pnpm mimetic -- init --dry-run --json
```

Fixture proof should run against a temporary app fixture, not this repo only.

## Stage 3: Run Bundle And Verify

Implement a synthetic dry-run bundle:

- run id;
- manifest;
- scenario/persona selection;
- lifecycle events;
- review skeleton;
- redaction result;
- artifact paths;
- source/git state.

Implement `mimetic verify` over that bundle.

Proof:

```bash
pnpm mimetic -- run --dry-run --json
pnpm mimetic -- verify --run latest --json
```

## Stage 4: Observer

Implement static observer over the bundle:

- summary;
- scenario/persona cards;
- lifecycle;
- evidence placeholders;
- feedback candidates;
- gaps and warnings;
- no mutation of source evidence.

Proof:

```bash
pnpm mimetic -- watch --run latest --no-open
```

If browser verification is added, use screenshots of the observer as proof.

## Stage 5: Feedback Issue Draft

Status: implemented for the synthetic dry-run bundle path.

Implement:

```bash
mimetic feedback draft --run latest --json
mimetic feedback issue --run latest --repo owner/repo --format markdown
mimetic feedback issue-url --run latest --repo owner/repo
```

Rules:

- no GitHub API mutation;
- no tokens;
- no Projects;
- redaction must pass;
- dry-run-only claims are labeled as contract proof, not product proof;
- issue body includes `mimetic_feedback` block.

Proof:

```bash
pnpm mimetic -- feedback issue --run latest --repo example/app --format markdown
```

## Stage 6: Agent Skill

Create a shareable skill package that teaches agents to install and configure
Mimetic in target repos.

It should cover:

- `npm i -D mimetic-cli`;
- `npx mimetic init`;
- committed vs ignored layout;
- public-safety rules;
- creating personas;
- creating scenarios;
- adding E2B/OpenAI env var names without values;
- running doctor/run/watch/verify/feedback issue;
- troubleshooting.

Proof:

- skill package validates;
- fresh-agent fixture follows the skill and reaches dry-run + issue draft.

## Stage 7: Local Browser And First Real Adapter

Only after the package and dry-run path are stable:

- local app target detection;
- Playwright/browser substrate;
- first scripted browser scenario;
- NoBG-style adapter fixture.

Proof:

- real browser screenshots in `.mimetic/runs`;
- observer renders screenshots;
- `verify` validates bundle.

## Non-Goals For V0

- live E2B;
- OpenAI computer-use actor;
- live GitHub mutation;
- hosted queues/databases/webhooks;
- provider spend;
- production deploys;
- real user/persona data;
- Northstar/NoBG/Image Skill private artifacts.
