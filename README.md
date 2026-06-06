# mimetic-cli

Open-source-safe persona simulation for apps, CLIs, and agent-facing product
flows.

Mimetic gives a project a repeatable way to ask: what happens when realistic
synthetic users, with different goals and tolerances, try to use this thing?
It creates committed simulation source under `mimetic/`, ignored run evidence
under `.mimetic/`, a watchable Observer UI, verification gates, and public-safe
feedback drafts.

![Mimetic Observer mission control showing synthetic lanes, filesystem evidence, terminal status, nested app proof, and public-safe review state](https://unpkg.com/mimetic-cli@latest/docs/assets/mimetic-oss-lab-observer.png?v=0.1.8)

## Install

```bash
npm i -D mimetic-cli
npx mimetic init --yes
npx mimetic watch
```

The package is `mimetic-cli`; the installed binary is `mimetic`. For a one-shot
command before installation, use `npx --package mimetic-cli mimetic ...` so npm
does not resolve an unrelated package named `mimetic`.

For coding agents, install the repo skill first:

```bash
npx skills add danielgwilson/mimetic-cli --skill mimetic-cli
```

The skill lives at [`skills/mimetic-cli/SKILL.md`](skills/mimetic-cli/SKILL.md)
for skills.sh discovery.

## Public-Safety Boundary

Mimetic is designed for public repositories and public issue queues.

Do not commit, emit, paste, preserve, or generate PII, PHI, secrets, keys,
tokens, raw private transcripts, private screenshots, private customer data,
private patient data, or private source snippets.

Use synthetic personas, synthetic examples, redacted evidence pointers, and
env var names without values. Generated run bundles belong under ignored
`.mimetic/`.

**What the automated gate enforces.** `mimetic verify` scans public-bound
artifacts and fails closed on secret, key, and token shapes and on known local
path shapes. It does not yet detect free-form PII or PHI such as names, emails,
phone numbers, dates of birth, or medical identifiers. Keeping those out depends
on using synthetic data and on review, so `redaction: passed` means the
automated secret and path scan found no matches, not that the artifact was
certified free of PII or PHI. A first-class PII/PHI detector is on the roadmap
([#108](https://github.com/danielgwilson/mimetic-cli/issues/108)).

## How It Works

```text
mimetic/      committed source plane: labs, personas, scenarios, policy, adapters
.mimetic/    ignored runtime plane: runs, Observer output, reviews, local state
```

The first-run path does not require credentials:

```bash
npx mimetic doctor
npx mimetic watch
npx mimetic verify --run latest --json
npx mimetic feedback issue --run latest --repo owner/repo --format markdown
```

`mimetic watch` starts a fresh four-lane synthetic run, renders the Observer,
opens it in the browser, serves it over localhost, and keeps the shell attached.
After `mimetic init`, named lab manifests can be run the same way:

```bash
npx mimetic watch first-run
npx mimetic lab list
npx mimetic lab inspect first-run
```

The CI-safe equivalent is:

```bash
npx mimetic watch --json --no-open
```

## Commands

| Command | Purpose |
| --- | --- |
| `mimetic init` | Scaffold committed `mimetic/` source and ignored `.mimetic/` runtime state. |
| `mimetic doctor` | Explain readiness and missing setup. |
| `mimetic run --dry-run` | Generate a synthetic run bundle without browser, keys, or provider spend. |
| `mimetic run --app-url http://127.0.0.1:<port>` | Capture live desktop/mobile browser evidence against a running local app. |
| `mimetic watch [lab]` | Run sims or a named lab, open Observer, and keep watching. |
| `mimetic lab list` | List committed and ignored lab manifests. |
| `mimetic lab inspect <lab>` | Show the source manifest for a lab without running it. |
| `mimetic lab run <lab>` | Run a lab manifest in human or JSON mode. |
| `mimetic verify` | Validate a run bundle and public-safety gates. |
| `mimetic review` | Read review evidence for a run. |
| `mimetic runs` | List local runs and latest pointers. |
| `mimetic feedback issue` | Print a public-safe GitHub issue draft without API mutation. |
| `mimetic lab run oss` | Repo-maintainer dogfood example: Observer-of-Observers for headed authorized-repo app setup attempts. |
| `mimetic lab run oss-smoke` | Repo-maintainer dogfood example: disposable clone smoke test against public OSS repos. |

## Lab Manifests

Labs are authored as `.yaml` source:

```text
mimetic/labs/*.yaml          committed public-safe labs
.mimetic/labs/*.yaml         ignored local labs
.mimetic/local/labs/*.yaml   ignored private or machine-specific labs
```

Committed labs should be useful to anyone who clones the project. Private repo
targets, token-backed provider settings, and local-only dogfood variants belong
in ignored `.mimetic/` lab manifests and can be run explicitly:

```bash
npx mimetic watch .mimetic/labs/local-dogfood.yaml --env-file .mimetic/local/provider.env
npx mimetic lab run .mimetic/labs/local-dogfood.yaml --json --no-open
```

`--env-file` loads values for the current process only. Mimetic reports loaded
env var names, never values, and does not persist those values into run bundles
or Observer data.

## Browser Scenario Manifests

`mimetic run --app-url http://127.0.0.1:<port>` looks for executable browser
steps in committed `mimetic/scenarios/*.yaml`. If none are present, Mimetic
falls back to the built-in two-step browser persona proof. Browser steps are
public-safe source, so use synthetic fixture values and committed relative app
paths only.

```yaml
schema: mimetic.scenario.v1
id: todo-onboarding
title: Todo onboarding
persona: synthetic-new-user
goal: Create the first synthetic todo and verify the list updates.
mode: browser
browser:
  startPath: /
  steps:
    - id: open-home
      label: Open the todo app
      action: goto
      path: /
      expect:
        text: Add todo
    - id: enter-todo
      label: Enter synthetic todo text
      action: fill
      selector: input[name="todo"]
      value: Synthetic onboarding task
    - id: create-todo
      label: Create the todo
      action: click
      selector: button[type="submit"]
      expect:
        text: Synthetic onboarding task
        stateChanged: true
```

Supported actions are `goto`, `fill`, `click`, `assertText`, `waitForText`,
and `waitForSelector`. Supported expectations are `text`, `selectorVisible`,
`urlIncludes`, and `stateChanged`. Generated traces are stored as JSON under
`.mimetic/runs/<run>/traces/` and summarized in the Observer.

## Maintainer OSS Meta-Lab Example

This repository includes an experimental authorized-repo dogfood lab:

```bash
pnpm mimetic -- watch oss
pnpm mimetic -- lab run oss --repos CorentinTh/it-tools,drawdb-io/drawdb,maciekt07/TodoApp,lissy93/dashy
```

Default lab targets are intentionally app/tool-like repos with visible,
locally runnable user surfaces. Avoid libraries and frameworks for public
dogfood unless the scenario is explicitly testing developer experience.

With `E2B_API_KEY` and `OPENAI_API_KEY` present, Mimetic launches headed E2B
desktop lanes, uploads the local package tarball, clones each assigned
repository inside the sandbox, initializes Mimetic, runs nested proof commands,
starts the target app when a runnable script is present, opens desktop/mobile
app windows plus the nested Observer in the sandbox browser, and starts a
nonblocking Codex actor attempt.
Install the optional desktop substrate first:

```bash
npm i -D @e2b/desktop
```

The contract-safe path for agents and CI is:

```bash
pnpm mimetic -- lab run oss --dry-run --json --no-open
```

The `oss` lab accepts GitHub `owner/repo` slugs. Private repositories are
maintainer-only and should be supplied from ignored local lab manifests with an
authorized `GH_TOKEN` or `GITHUB_TOKEN` loaded via `--env-file`. When a GitHub
token is present, durable run artifacts redact repo labels by default; pass
`--no-redact-repos` only for public-safe repo selections. Live E2B stream URLs
are runtime-only for the attached Observer server and are not persisted to
`run.json` or `observer-data.json`. Local bundles remain ignored under
`.mimetic/`; do not publish private screenshots, logs, or upstream details.

## Development

```bash
pnpm install
pnpm check
pnpm public-surface:scan
pnpm pack:dry-run
```

Local dogfood:

```bash
pnpm mimetic:watch
pnpm mimetic:verify
pnpm mimetic:feedback
pnpm mimetic:lab:list
```

## Docs

- [Ramp for future contributors and agents](docs/ramp/README.md)
- [Current goals](docs/goals/current.md)
- [Project layout](docs/architecture/project-layout.md)
- [Observer architecture](docs/architecture/observer.md)
- [Actor contract (pluggable harnesses)](docs/architecture/actor-contract.md)
- [OSS lab POC](docs/architecture/oss-lab-poc.md)
- [Feedback contract](docs/contracts/feedback.md)
- [Open-source install experience](docs/product/open-source-install-experience.md)
- [Self-driving harness principles](docs/principles/self-driving-harness.md)
- [World-class open-source v0 roadmap](docs/roadmap/world-class-open-source-v0.md)
- [Open-source release readiness](docs/release/open-source-readiness.md)
- [Public readiness standard](docs/release/public-readiness-standard.md)

## Release Status

This package is prepared for public npm packaging, but publication is still a
human release action. Do not run `npm publish` unless the maintainer explicitly
approves it in the current context.
