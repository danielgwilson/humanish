# Open-Source Install Experience

Date: 2026-06-01

Status: product target for the first world-class `homun` implementation.

## Product Promise

Drop Homun into an app and let a coding agent set up realistic persona
simulations, run them safely, watch them in a polished observer, and turn
friction into public-safe issue drafts.

The first experience should feel like a mature one-command simulation harness,
but with an open-source-safe package shape:

```bash
npm i -D homun
npx homun init
npm run homun:doctor
npm run homun:watch
npm run homun:verify
npx homun feedback issue --run latest --repo example/app --format markdown
```

## Two-Part Distribution

### NPM Package

The npm package owns executable behavior:

- binary: `homun`;
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
npx skills add danielgwilson/homun --skill homun
```

Installable repo skill: [`skills/homun/SKILL.md`](../../skills/homun/SKILL.md).

The skill should teach the user's coding agent how to:

- install `homun`;
- run `homun init`;
- inspect the target app's routes and dev command;
- create synthetic personas and scenarios;
- create public-safe `homun/labs/*.yaml` lab manifests;
- keep private/local labs under ignored `.homun/labs/*.yaml` or
  `.homun/local/labs/*.yaml`;
- configure local app targets;
- document E2B and OpenAI env var names without storing values;
- use `--env-file <path>` for explicit local env hydration without persisting
  values into artifacts;
- run `doctor`, `watch`, `verify`, and `feedback issue`;
- avoid PII, PHI, secrets, real customer data, and private artifacts.

The skill should not hide critical behavior in chat memory. It should point to
repo-owned `homun/` files and package-owned docs.

## Project File Formats

New projects should get a boring, legible format stack:

- `.yaml` for human-authored Homun source such as personas, scenarios,
  policies, labs, and review vocabulary;
- `.ts` for executable integration such as `homun/config.ts` and adapters;
- `.json` and `.ndjson` for generated run artifacts, Observer data, review
  output, event streams, and synthetic fixtures.

Use `.yml` only where an outside ecosystem convention already expects it, for
example GitHub Actions workflows. Do not scaffold `.yml` for Homun source and
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
schema: homun.lab.v2
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

1. `homun/labs/<id>.yaml` for committed, reproducible labs.
2. `.homun/labs/<id>.yaml` for ignored local labs.
3. `.homun/local/labs/<id>.yaml` for ignored machine-specific overlays.
4. explicit `.yaml` path, for example
   `.homun/labs/local-dogfood.yaml`.

Private repo targets, local env references, and maintainer dogfood variants
belong in ignored lab manifests and should be invoked with explicit
`--env-file`; do not make them package defaults.

## `homun init`

`homun init` should:

1. Detect package manager and app framework when possible.
2. Create committed starter files under `homun/`.
3. Create ignored runtime state under `.homun/`.
4. Add `.homun/` and secret/local overlays to `.gitignore`.
5. Patch `package.json` scripts only after showing the intended diff or when
   `--yes` is passed.
6. Create only synthetic public-safe personas and scenarios.
7. Write credential references as env var names only.
8. Run a dry-run verification if dependencies are available.

Suggested scripts:

```json
{
  "scripts": {
    "homun": "homun",
    "homun:doctor": "homun doctor",
  "homun:run": "homun run --dry-run",
  "homun:watch": "homun watch",
  "homun:lab:list": "homun lab list",
  "homun:watch:ci": "homun watch --json --no-open",
  "homun:verify": "homun verify"
  }
}
```

## Command Ladder

| Command | Purpose | First version should |
| --- | --- | --- |
| `homun init` | Set up project-owned harness files | Scaffold committed `homun/`, ignored `.homun/`, package scripts |
| `homun doctor` | Explain readiness | Check config, gitignore, app target, browser, env var names, redaction policy |
| `homun run --dry-run` | Prove contract without app/browser/keys | Write synthetic run bundle |
| `homun verify` | Validate bundle and public-safety gates | Fail closed on schema/evidence/redaction errors |
| `homun review` | Build review packet from evidence | Summarize verdicts without inventing product proof |
| `homun watch` | Run sims and watch the observer | Create a fresh four-lane bundle, render Observer, open it, and keep the shell attached |
| `homun watch [lab]` | Run a named lab and watch it | Resolve committed or ignored `.yaml` lab manifests, then open/follow Observer |
| `homun watch --json --no-open` | Agent/CI proof path | Create the same bundle and Observer artifacts without browser open or attached watch server |
| `homun lab list` | Discover available labs | List committed labs and ignored local labs with origin labels |
| `homun lab inspect <lab>` | Read a lab manifest | Print the parsed lab config, origin, path, and warnings without executing |
| `homun lab preflight <lab>` | Check lab readiness before spend | Validate routing and optionally probe declared targets from a hosted desktop without launching actors |
| `homun lab run <lab>` | Run a lab manifest | Human or JSON execution path for synthetic, OSS meta, and smoke labs |
| `homun lab run oss` | Maintainer dogfood example | Open the Observer-of-Observers with headed desktop lanes assigned by `--repos`, target app windows, nested Observers, runtime-only stream URLs, and redacted durable evidence for token-backed runs |
| `homun lab run oss-smoke` | Maintainer smoke example | Shallow clone lightweight GitHub repos, run setup/proof/verify, report, and remove clones |
| `homun feedback issue` | Produce public-safe issue draft | Print Markdown or prefilled issue URL, no GitHub API mutation |

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
`homun/scenarios/*.yaml`:

```yaml
schema: homun.scenario.v1
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

`homun run --app-url <loopback-url>` uses the first executable browser
scenario it finds. If no executable browser steps exist, Homun falls back to
the built-in two-step browser persona proof and says so in warnings/review.

Live E2B desktop labs are an optional advanced path. Target projects that need
them should install `@e2b/desktop` explicitly instead of receiving that
substrate as part of the default Homun package install. When a GitHub token is
present, repo labels are redacted in durable artifacts by default; live stream
auth URLs are used only by the attached watch server and are not persisted.
