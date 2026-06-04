# Open-Source Install Experience

Date: 2026-06-01

Status: product target for the first world-class `mimetic-cli` implementation.

## Product Promise

Drop Mimetic into an app and let a coding agent set up realistic persona
simulations, run them safely, watch them in a polished observer, and turn
friction into public-safe issue drafts.

The first experience should feel like a mature one-command simulation harness,
but with an open-source-safe package shape:

```bash
npm i -D mimetic-cli
npx mimetic init
npm run mimetic:doctor
npm run mimetic:watch
npm run mimetic:verify
npx mimetic feedback issue --run latest --repo example/app --format markdown
```

## Two-Part Distribution

### NPM Package

The npm package owns executable behavior:

- binary: `mimetic`;
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
npx skills add danielgwilson/mimetic-cli --skill mimetic-cli
```

Installable repo skill: [`skills/mimetic-cli/SKILL.md`](../../skills/mimetic-cli/SKILL.md).

The skill should teach the user's coding agent how to:

- install `mimetic-cli`;
- run `mimetic init`;
- inspect the target app's routes and dev command;
- create synthetic personas and scenarios;
- create public-safe `mimetic/labs/*.yaml` lab manifests;
- keep private/local labs under ignored `.mimetic/labs/*.yaml` or
  `.mimetic/local/labs/*.yaml`;
- configure local app targets;
- document E2B and OpenAI env var names without storing values;
- use `--env-file <path>` for explicit local env hydration without persisting
  values into artifacts;
- run `doctor`, `watch`, `verify`, and `feedback issue`;
- avoid PII, PHI, secrets, real customer data, and private artifacts.

The skill should not hide critical behavior in chat memory. It should point to
repo-owned `mimetic/` files and package-owned docs.

## Project File Formats

New projects should get a boring, legible format stack:

- `.yaml` for human-authored Mimetic source such as personas, scenarios,
  policies, labs, and review vocabulary;
- `.ts` for executable integration such as `mimetic/config.ts` and adapters;
- `.json` and `.ndjson` for generated run artifacts, Observer data, review
  output, event streams, and synthetic fixtures.

Use `.yml` only where an outside ecosystem convention already expects it, for
example GitHub Actions workflows. Do not scaffold `.yml` for Mimetic source and
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
schema: mimetic.lab.v1
id: first-run
kind: synthetic
title: First-run synthetic Observer
description: Public-safe starter lab that generates a synthetic run bundle and Observer without provider spend.
sims: 4
defaults:
  dryRun: true
  open: true
```

Resolution order:

1. `mimetic/labs/<id>.yaml` for committed, reproducible labs.
2. `.mimetic/labs/<id>.yaml` for ignored local labs.
3. `.mimetic/local/labs/<id>.yaml` for ignored machine-specific overlays.
4. explicit `.yaml` path, for example
   `.mimetic/labs/local-dogfood.yaml`.

Private repo targets, local env references, and maintainer dogfood variants
belong in ignored lab manifests and should be invoked with explicit
`--env-file`; do not make them package defaults.

## `mimetic init`

`mimetic init` should:

1. Detect package manager and app framework when possible.
2. Create committed starter files under `mimetic/`.
3. Create ignored runtime state under `.mimetic/`.
4. Add `.mimetic/` and secret/local overlays to `.gitignore`.
5. Patch `package.json` scripts only after showing the intended diff or when
   `--yes` is passed.
6. Create only synthetic public-safe personas and scenarios.
7. Write credential references as env var names only.
8. Run a dry-run verification if dependencies are available.

Suggested scripts:

```json
{
  "scripts": {
    "mimetic": "mimetic",
    "mimetic:doctor": "mimetic doctor",
  "mimetic:run": "mimetic run --dry-run",
  "mimetic:watch": "mimetic watch",
  "mimetic:lab:list": "mimetic lab list",
  "mimetic:watch:ci": "mimetic watch --json --no-open",
  "mimetic:verify": "mimetic verify"
  }
}
```

## Command Ladder

| Command | Purpose | First version should |
| --- | --- | --- |
| `mimetic init` | Set up project-owned harness files | Scaffold committed `mimetic/`, ignored `.mimetic/`, package scripts |
| `mimetic doctor` | Explain readiness | Check config, gitignore, app target, browser, env var names, redaction policy |
| `mimetic run --dry-run` | Prove contract without app/browser/keys | Write synthetic run bundle |
| `mimetic verify` | Validate bundle and public-safety gates | Fail closed on schema/evidence/redaction errors |
| `mimetic review` | Build review packet from evidence | Summarize verdicts without inventing product proof |
| `mimetic watch` | Run sims and watch the observer | Create a fresh four-lane bundle, render Observer, open it, and keep the shell attached |
| `mimetic watch [lab]` | Run a named lab and watch it | Resolve committed or ignored `.yaml` lab manifests, then open/follow Observer |
| `mimetic watch --json --no-open` | Agent/CI proof path | Create the same bundle and Observer artifacts without browser open or attached watch server |
| `mimetic lab list` | Discover available labs | List committed labs and ignored local labs with origin labels |
| `mimetic lab inspect <lab>` | Read a lab manifest | Print lab id, kind, path, defaults, repos, and warnings without executing |
| `mimetic lab run <lab>` | Run a lab manifest | Human or JSON execution path for synthetic, OSS meta, and smoke labs |
| `mimetic lab run oss` | Maintainer dogfood example | Open the Observer-of-Observers with headed desktop lanes assigned by `--repos`, target app windows, nested Observers, runtime-only stream URLs, and redacted durable evidence for token-backed runs |
| `mimetic lab run oss-smoke` | Maintainer smoke example | Shallow clone lightweight GitHub repos, run setup/proof/verify, report, and remove clones |
| `mimetic feedback issue` | Produce public-safe issue draft | Print Markdown or prefilled issue URL, no GitHub API mutation |

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

Live E2B desktop labs are an optional advanced path. Target projects that need
them should install `@e2b/desktop` explicitly instead of receiving that
substrate as part of the default Mimetic package install. When a GitHub token is
present, repo labels are redacted in durable artifacts by default; live stream
auth URLs are used only by the attached watch server and are not persisted.
