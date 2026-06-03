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
names only, usually `OPENAI_API_KEY` and `E2B_API_KEY`. Stop before live
provider spend, hosted execution, deploys, public tunnels, or GitHub mutation
unless the user explicitly approves that exact action.

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

## First Proof Run

Run the no-credentials path first:

```bash
npx mimetic doctor
npx mimetic watch
npx mimetic verify --run latest --json
npx mimetic feedback issue --run latest --repo example/app --format markdown
```

For CI or non-interactive proof:

```bash
npx mimetic watch --json --no-open
```

The feedback command prints a public-safe Markdown draft. It must not call the
GitHub API, require a token, update Projects, use provider credits, or claim
product behavior proof from a dry run.

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

## Reporting Back

Report:

- files changed in the target repo;
- exact proof commands run;
- generated local artifact paths under `.mimetic/`;
- whether redaction passed;
- what remains blocked before live browser, OpenAI, E2B, or GitHub mutation.
