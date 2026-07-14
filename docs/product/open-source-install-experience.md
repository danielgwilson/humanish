# Open-Source Install Experience

Date: 2026-06-01

Status: product target for the first world-class `humanish` implementation.

Safety amendment (2026-07-14): the `0.15.1` package binds managed run and
output storage to validated physical paths, treats provider IDs persisted in a
run bundle as evidence rather than cleanup authority, and disables live OSS
meta-lab execution until repository-derived instructions have an isolated
credential boundary. The historical product target below remains useful for
intent and sequencing, but current behavior is defined by the README and
[`docs/goals/current.md`](../goals/current.md).

## Product Promise

Drop Humanish into an app and let a coding agent set up realistic persona
simulations, run them safely, watch them in a polished observer, and turn
friction into public-safe issue drafts.

The first experience should feel like a mature one-command simulation harness,
but with an open-source-safe package shape:

```bash
npm i -D humanish
npx humanish init
npm run humanish:doctor
npm run humanish:watch
npm run humanish:verify
npx humanish feedback issue --run latest --repo example/app --format markdown
```

## Two-Part Distribution

### NPM Package

The npm package owns executable behavior:

- binary: `humanish`;
- CLI framework: `commander`;
- commands: `init`, `doctor`, `run`, `watch`, `review`, `verify`,
  `lab`, `feedback`;
- schemas and validators;
- synthetic starter templates;
- observer static assets;
- artifact and run-bundle utilities;
- redaction and public issue-draft generation.

### Agent Skill

The agent skill owns installation guidance and repo adaptation:

```bash
npx skills add danielgwilson/humanish --skill humanish
```

Installable repo skill: [`skills/humanish/SKILL.md`](../../skills/humanish/SKILL.md).

The skill should teach the user's coding agent how to:

- install `humanish`;
- run `humanish init`;
- inspect the target app's routes and dev command;
- create synthetic personas and scenarios;
- create public-safe `humanish/labs/*.yaml` lab manifests;
- keep private/local labs under ignored `.humanish/labs/*.yaml` or
  `.humanish/local/labs/*.yaml`;
- configure local app targets;
- document E2B and OpenAI env var names without storing values;
- use `--env-file <path>` for explicit local env hydration without persisting
  values into artifacts;
- run `doctor`, `watch`, `verify`, and `feedback issue`;
- avoid PII, PHI, secrets, real customer data, and private artifacts.

The skill should not hide critical behavior in chat memory. It should point to
repo-owned `humanish/` files and package-owned docs.

## Project File Formats

New projects should get a boring, legible format stack:

- `.yaml` for human-authored Humanish source such as personas, scenarios,
  policies, labs, and review vocabulary;
- `.ts` for executable integration such as `humanish/config.ts` and adapters;
- `.json` and `.ndjson` for generated run artifacts, Observer data, review
  output, event streams, and synthetic fixtures.

Use `.yml` only where an outside ecosystem convention already expects it, for
example GitHub Actions workflows. Do not scaffold `.yml` for Humanish source and
do not use TOML unless a future scalar global-config case clearly needs it.

## First-Run Principles

- No keys required for the first wow moment.
- No live GitHub mutation.
- No hosted queues or private infrastructure.
- No real customer/user/patient data.
- No generated personas from tickets, logs, transcripts, screenshots, or
  production analytics.
- Safe dry-run should produce a valid synthetic run bundle and observer view.
- The user should see what changed in git.

## Lab Manifest Shape

Labs are the public-safe way to name a reusable simulation run. A starter app
gets a committed synthetic lab:

```yaml
schema: humanish.lab.v2
id: first-run
title: First-run synthetic Observer
description: Public-safe starter lab that generates a synthetic run bundle and Observer without provider spend.
subject:
  source: this-repo
actors:
  - type: synthetic-persona
    count: 4
scenario:
  mode: dry-run
defaults:
  open: true
```

Resolution order:

1. `humanish/labs/<id>.yaml` for committed, reproducible labs.
2. `.humanish/labs/<id>.yaml` for ignored local labs.
3. `.humanish/local/labs/<id>.yaml` for ignored machine-specific overlays.
4. explicit `.yaml` path, for example
   `.humanish/labs/local-dogfood.yaml`.

Private repo targets, local env references, and maintainer dogfood variants
belong in ignored lab manifests and should be invoked with explicit
`--env-file`; do not make them package defaults.

## `humanish init`

`humanish init` should:

1. Detect package manager and app framework when possible.
2. Create committed starter files under `humanish/`.
3. Create ignored runtime state under `.humanish/`.
4. Add `.humanish/` and secret/local overlays to `.gitignore`.
5. Patch `package.json` scripts only after showing the intended diff or when
   `--yes` is passed.
6. Create only synthetic public-safe personas and scenarios.
7. Write credential references as env var names only.
8. Run a dry-run verification if dependencies are available.

Suggested scripts:

```json
{
  "scripts": {
    "humanish": "humanish",
    "humanish:doctor": "humanish doctor",
  "humanish:run": "humanish run --dry-run",
  "humanish:watch": "humanish watch",
  "humanish:lab:list": "humanish lab list",
  "humanish:watch:ci": "humanish watch --json --no-open",
  "humanish:verify": "humanish verify"
  }
}
```

## Command Ladder

| Command | Purpose | First version should |
| --- | --- | --- |
| `humanish init` | Set up project-owned harness files | Scaffold committed `humanish/`, ignored `.humanish/`, package scripts |
| `humanish doctor` | Explain readiness | Check config, gitignore, app target, browser, env var names, redaction policy |
| `humanish run --dry-run` | Prove contract without app/browser/keys | Write synthetic run bundle |
| `humanish verify` | Validate bundle and public-safety gates | Fail closed on schema/evidence/redaction errors |
| `humanish review` | Build review packet from evidence | Summarize verdicts without inventing product proof |
| `humanish watch` | Run sims and watch the observer | Create a fresh four-lane bundle, render Observer, open it, and keep the shell attached |
| `humanish watch [lab]` | Run a named lab and watch it | Resolve committed or ignored `.yaml` lab manifests, then open/follow Observer |
| `humanish watch --json --no-open` | Agent/CI proof path | Create the same bundle and Observer artifacts without browser open or attached watch server |
| `humanish lab list` | Discover available labs | List committed labs and ignored local labs with origin labels |
| `humanish lab inspect <lab>` | Read a lab manifest | Print the parsed lab config, origin, path, and warnings without executing |
| `humanish lab preflight <lab>` | Check lab readiness before spend | Validate routing and optionally probe declared targets from a hosted desktop without launching actors |
| `humanish lab run <lab>` | Run a lab manifest | Human or JSON execution path for synthetic, OSS meta, and smoke labs |
| `humanish lab run oss` | Maintainer contract example | Render a dry-run Observer-of-Observers contract for selected repo labels; live execution fails closed pending credential isolation |
| `humanish lab run oss-smoke` | Maintainer smoke example | Shallow clone lightweight GitHub repos, run setup/proof/verify, report, and remove clones |
| `humanish feedback issue` | Produce public-safe issue draft | Print Markdown or prefilled issue URL, no GitHub API mutation |

## Live Capability Ladder

Live execution should be staged after the dry-run path is boring:

1. Synthetic dry-run bundle.
2. Local app reachability and browser smoke.
3. Scripted browser scenario.
4. Observer over real screenshots/traces.
5. Computer-use / OpenAI actor.
6. E2B substrate.
7. Multi-persona matrix.
8. Optional maintainer-only issue sync tooling.

Do not make E2B, OpenAI, or GitHub credentials part of the first successful
run.

For step 3, app-specific browser scenarios are authored as `.yaml` source under
`humanish/scenarios/*.yaml`:

```yaml
schema: humanish.scenario.v1
id: core-browser-flow
title: Core browser flow
persona: synthetic-new-user
goal: Reach the first meaningful product state with synthetic data.
mode: browser
browser:
  startPath: /
  steps:
    - id: open-home
      label: Open the app
      action: goto
      path: /
      expect:
        text: "Get started"
    - id: submit-primary-action
      label: Submit the primary action
      action: click
      selector: "button[type='submit']"
      expect:
        stateChanged: true
```

`humanish run --app-url <loopback-url>` uses the first executable browser
scenario it finds. If no executable browser steps exist, Humanish falls back to
the built-in two-step browser persona proof and says so in warnings/review.

Live E2B desktop labs are an optional advanced path. Target projects that need
them should install `@e2b/desktop` explicitly instead of receiving that
substrate as part of the default Humanish package install. When a GitHub token is
present, repo labels are redacted in durable artifacts by default; live stream
auth URLs are used only by the attached watch server and are not persisted.
