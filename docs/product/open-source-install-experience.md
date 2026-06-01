# Open-Source Install Experience

Date: 2026-06-01

Status: product target for the first world-class `mimetic-cli` implementation.

## Product Promise

Drop Mimetic into an app and let a coding agent set up realistic persona
simulations, run them safely, watch them in a polished observer, and turn
friction into public-safe issue drafts.

The first experience should feel as easy as Northstar's `ui-sim`, but with an
open-source-safe package shape:

```bash
npm i -D mimetic-cli
npx mimetic init
npm run mimetic doctor
npm run mimetic run -- --dry-run
npm run mimetic watch
npm run mimetic feedback issue -- --run latest
```

## Two-Part Distribution

### NPM Package

The npm package owns executable behavior:

- binary: `mimetic`;
- CLI framework: `commander`;
- commands: `init`, `doctor`, `run`, `watch`, `review`, `verify`,
  `feedback`;
- schemas and validators;
- synthetic starter templates;
- observer static assets;
- artifact and run-bundle utilities;
- redaction and public issue-draft generation.

### Agent Skill

The agent skill owns installation guidance and repo adaptation:

```bash
npx skills add danielgwilson/mimetic-cli
```

The skill should teach the user's coding agent how to:

- install `mimetic-cli`;
- run `mimetic init`;
- inspect the target app's routes and dev command;
- create synthetic personas and scenarios;
- configure local app targets;
- document E2B and OpenAI env var names without storing values;
- run `doctor`, `run --dry-run`, `watch`, `verify`, and `feedback issue`;
- avoid PII, PHI, secrets, real customer data, and private artifacts.

The skill should not hide critical behavior in chat memory. It should point to
repo-owned `mimetic/` files and package-owned docs.

## First-Run Principles

- No keys required for the first wow moment.
- No live GitHub mutation.
- No hosted queues or private infrastructure.
- No real customer/user/patient data.
- No generated personas from tickets, logs, transcripts, screenshots, or
  production analytics.
- Safe dry-run should produce a valid synthetic run bundle and observer view.
- The user should see what changed in git.

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
    "mimetic:run": "mimetic run",
    "mimetic:watch": "mimetic watch",
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
| `mimetic watch` | Open observer over bundle | Render static local observer |
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

