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

Status: upgraded from static report to mission-control substrate for synthetic
stream contracts.

Implemented:

- normalized `observer/observer-data.json` view model;
- `events.ndjson` event stream contract;
- stream-shaped sim lanes for UI, CLI, TUI, and Codex UI;
- localhost watch server with no-store polling;
- mission-control grid and focus mode;
- terminal/TUI transcript stage;
- evidence rail for events, artifacts, and gaps;
- public-safe Codex UI stream contract with no raw provider payloads.

Still next:

- real browser actor adapter;
- real PTY capture;
- native Codex app-server adapter;
- screenshot/trace gallery from real products;
- reviewer acceptance gates over live product behavior.

Proof:

```bash
pnpm mimetic -- watch
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

Status: implemented as an installer-visible skills.sh skill under
`skills/mimetic-cli/SKILL.md`.

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

```bash
DISABLE_TELEMETRY=1 npx skills add . --list
```

Future proof: fresh-agent fixture follows the skill and reaches dry-run +
issue draft.

## Stage 6.5: Release Readiness

Status: public package candidate, blocked only on explicit publish approval.

Readiness lives in
[`docs/release/open-source-readiness.md`](../release/open-source-readiness.md).
The package has MIT metadata and public npm package shape. `npm publish`
remains a human release action.

## Stage 6.75: Self-Dogfood Config

Status: implemented for dry-run contract proof.

The repository now includes committed `mimetic/` source files so Mimetic can run
against `mimetic-cli` itself. This makes `doctor` green on the repo, lets
dry-run bundles read and digest `mimetic/personas/synthetic-new-user.yaml` and
`mimetic/scenarios/first-run-smoke.yaml`, and keeps the live Codex TUI actor gap
explicit. The live Codex TUI dogfood path and noninteractive `codex-exec`
fanout hardening are tracked in
[#28](https://github.com/danielgwilson/mimetic-cli/issues/28).

## Stage 6.8: One-Command Watch UX

Status: implemented for synthetic contract-proof stream lanes.

`mimetic watch` now creates a fresh four-lane synthetic run, renders Observer,
starts a localhost watch server, opens the served Observer in the browser, and
keeps the shell attached. The CI-safe form is `mimetic watch --json --no-open`.
`--sims <n>` remains the explicit scale control, and `--run <id>` watches
existing evidence.

## Stage 6.8: Lab Manifests

Status: implemented as the generic source shape for reusable runs.

Mimetic now resolves `.yaml` lab manifests from committed `mimetic/labs/`,
ignored `.mimetic/labs/`, ignored `.mimetic/local/labs/`, or an explicit
`.yaml` path. The human path is `mimetic watch <lab>`; the agent/CI path is
`mimetic lab run <lab> --json --no-open`; discovery is `mimetic lab list` and
`mimetic lab inspect <lab>`.

Private or maintainer-only dogfood belongs in ignored lab manifests plus
explicit `--env-file`; the public package should not hardcode private target
names or require broad inherited job env.

## Stage 6.9: Maintainer OSS Meta-Lab

Status: implemented as repo-owned `mimetic/labs/oss.yaml` plus compatibility
aliases, with a retained disposable smoke harness.

`mimetic watch oss` opens the top-level Observer for authorized-repo meta-sims.
Each lane is assigned a GitHub `owner/repo` slug from `--repos` or repeated
`--repo` values and carries a headed E2B desktop for setting up Mimetic inside
that repo, starting the target app where feasible, and keeping the nested
Observer visible.
Default public targets should be apps, CLIs, or agent-facing tools with
observable user surfaces. Frameworks, starters, and utility libraries are
acceptable only when the explicit scenario is developer-experience testing.
When live keys are present, Mimetic launches E2B desktops, uploads the locally
packed Mimetic package, starts visible bootstrap terminals, clones each assigned
repo inside the desktop, runs nested Mimetic setup/proof commands, opens
desktop/mobile app windows plus the nested Observer in the sandbox browser, and
starts a nonblocking Codex actor attempt. Attached watch mode overlays live E2B
stream URLs only in memory; durable run artifacts keep screenshots/status, not
auth-bearing URLs. Private repos are maintainer-only, require an authorized
runtime GitHub token, and redact repo labels in durable artifacts by default.

`mimetic lab run oss-smoke` keeps the earlier clone/discard proof loop: shallow
clone lightweight public GitHub repositories into ignored `.mimetic/tmp`, apply
Mimetic setup in disposable clones, run the four-lane synthetic Observer proof,
verify it, record git-status evidence, write an ignored
`.mimetic/lab/oss/<run-id>/` report, and remove clones by default.

Proof:

```bash
pnpm mimetic -- watch oss --detach --open --repos CorentinTh/it-tools,drawdb-io/drawdb
pnpm mimetic -- lab run oss --dry-run --json --no-open --repos CorentinTh/it-tools,drawdb-io/drawdb
pnpm mimetic -- lab run oss-smoke --limit 1 --json
```

Next substrate work: upgrade nested app-url render proof into provider-backed
browser personas that drive the target app and add richer process/filesystem
telemetry for Codex actor health.

## Stage 7: Local Browser And First Real Adapter

Only after the package and dry-run path are stable:

- local app target detection;
- Playwright/browser substrate;
- first scripted browser scenario;
- browser-app adapter fixture.

Proof:

- real browser screenshots in `.mimetic/runs`;
- observer renders screenshots;
- `verify` validates bundle.

## Non-Goals For V0

- live E2B as required first-run behavior;
- OpenAI computer-use actor;
- live GitHub mutation;
- hosted queues/databases/webhooks;
- provider spend as required first-run behavior;
- production deploys;
- real user/persona data;
- private upstream artifacts.
