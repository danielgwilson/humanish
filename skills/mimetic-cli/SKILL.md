---
name: mimetic-cli
description: Install and configure Mimetic CLI in a JavaScript app as an open-source-safe persona simulation harness. Use when an agent needs to add mimetic-cli, run safe first setup, create synthetic personas or scenarios, configure env var names without values, run verification and Observer commands, or draft public-safe feedback issues without GitHub mutation.
---

# Mimetic CLI

Use this skill to add Mimetic to a target app without relying on chat memory or
private artifacts. Keep every example synthetic and public-safe.

## Hard Boundary

Never read, copy, commit, summarize, or generate PII, PHI, secrets, keys,
tokens, raw private transcripts, private screenshots, raw customer data, raw
patient data, or private upstream artifacts.

Do not edit `.env` or secret files. Do not paste credential values. Use env var
names only, usually `OPENAI_API_KEY` and `E2B_API_KEY`. For live local runs,
prefer an explicit ignored env file passed with `--env-file <path>`; do not
assume broad inherited job env is safe. Stop before live provider spend,
hosted execution, deploys, public tunnels, or GitHub mutation unless the user
explicitly approves that exact action.

## Setup Workflow

1. Inspect public target-repo files only: `package.json`, docs, route/app
   structure, test scripts, and `.gitignore`.
2. Install Mimetic with the repo's package manager:

   ```bash
   npm i -D mimetic-cli
   ```

3. Preview setup:

   ```bash
   npx mimetic init --dry-run --json
   ```

4. Apply setup after the planned changes are understood:

   ```bash
   npx mimetic init --yes --json
   ```

5. Confirm the layout:
   - commit `mimetic/` source files;
   - ignore `.mimetic/` runtime artifacts;
   - keep committed labs under `mimetic/labs/*.yaml`;
   - keep private/local labs under ignored `.mimetic/labs/*.yaml` or
     `.mimetic/local/labs/*.yaml`;
   - keep `.env.example` commit-safe and value-free;
   - never commit generated run bundles.

## Format Stack

When creating or editing Mimetic files:

- use `.yaml` for human-authored Mimetic source: personas, scenarios,
  policies, labs, review vocabulary, and milestones;
- use `.ts` for executable integration: `mimetic/config.ts`, adapters, route
  catalogs, and app launch logic;
- use `.json` or `.ndjson` for generated machine artifacts, Observer data, run
  bundles, event streams, and synthetic fixtures.

Do not create `.yml` files under `mimetic/`; `.yml` is for outside ecosystem
conventions such as GitHub Actions workflows. Do not introduce TOML unless the
target project has a concrete scalar global-config need that YAML, TypeScript,
or JSON does not serve.

## Authoring Personas And Scenarios

Create or edit only synthetic files under `mimetic/`.

Personas should describe motivations, accessibility needs, experience level,
device assumptions, and risk tolerance. Avoid names, emails, addresses,
accounts, screenshots, logs, tickets, transcripts, analytics rows, or anything
copied from a real user.

Scenarios should define the target app surface, start URL, task intent,
success signals, and failure signals. Keep app-specific truth in the target
repo's `mimetic/` files, not in the package or this skill.

## Authoring Labs

Create reusable simulation runs as `.yaml` lab manifests:

```yaml
schema: mimetic.lab.v1
id: first-run
kind: synthetic
title: First-run synthetic Observer
sims: 4
defaults:
  dryRun: true
  open: true
```

Use committed `mimetic/labs/*.yaml` for public-safe, reproducible labs. Use
ignored `.mimetic/labs/*.yaml` or `.mimetic/local/labs/*.yaml` for private repo
targets, local-only dogfood, or machine-specific settings. Never commit private
repo names, stream URLs, credential values, screenshots, logs, source snippets,
or operational details.

Useful commands:

```bash
npx mimetic lab list
npx mimetic lab inspect first-run
npx mimetic watch first-run
npx mimetic lab run first-run --json --no-open
```

## First Proof Run

Run the no-credentials path first. This proves Mimetic artifact plumbing, not
target app behavior:

```bash
npx mimetic doctor
npx mimetic watch
npx mimetic verify --run latest --json
npx mimetic feedback issue --run latest --repo example/app --format markdown
```

For CI or non-interactive proof:

```bash
npx mimetic watch --json --no-open
npx mimetic lab run first-run --json --no-open
```

The feedback command prints a public-safe Markdown draft. It must not call the
GitHub API, require a token, update Projects, use provider credits, or claim
product behavior proof from a dry run.

When the target app can run locally, prove real browser behavior with
`run --app-url` after starting the app on loopback:

```bash
# in another terminal, start the target app on 127.0.0.1 or localhost
npx mimetic run --app-url http://127.0.0.1:<port> --sims 2 --json
npx mimetic verify --run latest --json
npx mimetic watch --run latest --detach --no-open --json
```

Do not use `mimetic watch --sims ...` as a substitute for app-url proof.
`watch` renders or follows Observer evidence; `run --app-url` is the command
that captures live desktop/mobile browser evidence against a running app.

## Optional Live E2B Lab

Live headed E2B desktop lanes are optional. Add the substrate dependency only
when the user explicitly wants live E2B execution:

```bash
npm i -D @e2b/desktop
```

Then confirm env var names are documented without values:

```bash
E2B_API_KEY
OPENAI_API_KEY
```

Do not paste values into files, prompts, run bundles, issue drafts, or logs.
Load local values only at invocation time:

```bash
npx mimetic watch .mimetic/labs/local-live.yaml --env-file .mimetic/local/provider.env
```

When choosing dogfood targets, prefer apps, CLIs, or agent-facing tools with a
real observable user surface and local run path. Do not use libraries,
frameworks, starters, or infrastructure packages as default targets unless the
declared scenario is developer-experience testing. Private repos are allowed
only as explicit maintainer-authorized runs with repo redaction left on; never
publish their names, screenshots, logs, source snippets, or operational details.

## Reporting Back

Report:

- files changed in the target repo;
- exact proof commands run;
- generated local artifact paths under `.mimetic/`;
- whether redaction passed;
- what remains blocked before live browser, OpenAI, E2B, or GitHub mutation.
