---
name: humanish
description: Install and configure Humanish CLI in a JavaScript app as an open-source-safe persona simulation harness. Use when an agent needs to add humanish, run safe first setup, create synthetic personas or scenarios, configure env var names without values, capture the email or SMS an app sends so a persona can complete an email-gated flow (e.g. a signup verification link or one-time code), run verification and Observer commands, or draft public-safe feedback issues without GitHub mutation.
---

# Humanish CLI

Use this skill to add Humanish to a target app without relying on chat memory or
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

## Not For You: `humanish tui`

`humanish tui` is a human-only surface. It takes over the terminal and waits for
keystrokes, so it will block you and produce nothing you can read. It refuses a
non-interactive stdin or stdout with `HUMANISH_TUI_REQUIRES_TTY` rather than
rendering escape codes into your transcript — but do not invoke it at all.

Everything it shows has a machine-readable equivalent, which is what you want:

| Instead of the TUI | Use |
| --- | --- |
| browsing labs | `npx humanish lab list --json` |
| browsing runs | `npx humanish runs --json` |
| starting a run | `npx humanish lab run <lab> --json --no-open` |
| a run's outcome | `npx humanish review --run <id> --json` |

If a human asks you to "open the TUI", tell them the command to type; do not run
it on their behalf.

## Setup Workflow

1. Inspect public target-repo files only: `package.json`, docs, route/app
   structure, test scripts, and `.gitignore`.
2. Install Humanish with the repo's package manager:

   ```bash
   npm i -D humanish
   ```

   The package is `humanish`; the installed binary is `humanish`. After
   installation, `npx humanish ...` resolves the local project binary. For a
   one-shot command before installation, use
   `npx --package humanish humanish ...` to guarantee the binary comes from
   the `humanish` registry package rather than a same-named command already
   on the PATH.

3. Preview setup:

   ```bash
   npx humanish init --dry-run --json
   ```

4. Apply setup after the planned changes are understood:

   ```bash
   npx humanish init --yes --json
   ```

5. Confirm the layout:
   - commit `humanish/` source files;
   - ignore `.humanish/` runtime artifacts;
   - keep committed labs under `humanish/labs/*.yaml`;
   - keep private/local labs under ignored `.humanish/labs/*.yaml` or
     `.humanish/local/labs/*.yaml`;
   - keep `.env.example` commit-safe and value-free;
   - never commit generated run bundles.

## Format Stack

When creating or editing Humanish files:

- use `.yaml` for human-authored Humanish source: personas, scenarios,
  policies, labs, review vocabulary, and milestones;
- use `.ts` for executable integration: `humanish/config.ts`, adapters, route
  catalogs, and app launch logic;
- use `.json` or `.ndjson` for generated machine artifacts, Observer data, run
  bundles, event streams, and synthetic fixtures.

Do not create `.yml` files under `humanish/`; `.yml` is for outside ecosystem
conventions such as GitHub Actions workflows. Do not introduce TOML unless the
target project has a concrete scalar global-config need that YAML, TypeScript,
or JSON does not serve.

## Authoring Personas And Scenarios

Create or edit only synthetic files under `humanish/`.

Personas should describe motivations, accessibility needs, experience level,
device assumptions, and risk tolerance. Avoid names, emails, addresses,
accounts, screenshots, logs, tickets, transcripts, analytics rows, or anything
copied from a real user.

Scenarios should define the target app surface, start URL, task intent,
success signals, and failure signals. Keep app-specific truth in the target
repo's `humanish/` files, not in the package or this skill.

When the app can run locally, make at least one scenario executable with a
`browser.steps` manifest so `humanish run --app-url` can drive the app instead
of falling back to the generic two-step proof:

```yaml
schema: humanish.scenario.v1
id: product-core-flow
title: Product core flow
persona: synthetic-new-user
goal: Reach and verify the first meaningful app state with synthetic data.
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
    - id: enter-synthetic-input
      label: Enter synthetic fixture input
      action: fill
      selector: "input[name='query']"
      value: "synthetic fixture"
    - id: submit-primary-action
      label: Submit the primary action
      action: click
      selector: "button[type='submit']"
      expect:
        stateChanged: true
```

Supported actions are `goto`, `fill`, `click`, `assertText`, `waitForText`,
and `waitForSelector`. Supported expectations are `text`, `selectorVisible`,
`urlIncludes`, and `stateChanged`. Use public-safe selectors and synthetic
values only. Do not write real emails, names, customer data, tickets, logs, or
tokens into scenario files.

## Authoring Labs

Create reusable simulation runs as `.yaml` lab manifests:

```yaml
schema: humanish.lab.v2
id: first-run
title: First-run synthetic Observer
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

A lab is a composition (`subject` × `actors` × `execution` × `scenario` ×
`policies`), not a hardcoded kind; there is no v1 compatibility. Run
`npx humanish lab inspect <lab>` to see how a manifest parses, including
warnings for fields the engine does not consume yet.

### Many actors at once (fan-out, shared worlds, concurrency)

- **Every declared seat runs live at once by default.** A 6-lane roster is 6
  simultaneous actors; total sessions and spend are the same either way, only
  wall-clock and simultaneity differ. `execution.concurrency` is a CAP, not a
  mode: declare it only to bound simultaneous paid desktops, and expect a parse
  warning when the cap makes seats run in waves (a green waved run looks
  identical to the all-live run you meant, so the harness says so up front).
- **Per-lane worlds vs one shared world.** A plain multi-lane computer-use lab
  gives each actor its OWN app instance (independent studies in parallel). Add
  `subject.topology: shared-world` for N actors in ONE world (a lobby, a shared
  DB, actors seeing each other's changes). `execution.concurrency: 1` on a
  shared-world lab is the sequential turn-taking variant — one actor at a time,
  and note comms/email has no wiring there.
- **Watching it:** each live lane is its own Observer tile/stream; lanes beyond
  a declared cap start when a slot frees, which on a capped run looks like idle
  tiles — another reason to leave the cap out unless you need it.

Use committed `humanish/labs/*.yaml` for public-safe, reproducible labs. Use
ignored `.humanish/labs/*.yaml` or `.humanish/local/labs/*.yaml` for private repo
targets, local-only dogfood, or machine-specific settings. Never commit private
repo names, stream URLs, credential values, screenshots, logs, source snippets,
or operational details.

Useful commands:

```bash
npx humanish lab list
npx humanish lab inspect first-run
npx humanish watch first-run
npx humanish lab run first-run --json --no-open
```

### Off-app email/SMS verification (comms)

When a flow is gated behind an email or SMS the app itself SENDS — a signup
verification link, a one-time code, a magic link — add a `comms:` block. The
harness redirects the app's email-API sends into a catch INSIDE the sandbox (no
mail leaves the machine), gives the persona a synthetic inbox to open and click
through, and writes a digest-only `humanish.comms-thread.v1` evidence artifact (no
raw address/link/code persists). Reach for this whenever a persona must read mail
the app sent it to finish a step.

```yaml
comms:
  email:
    injectEnv: RESEND_API_URL # adopter-named: whatever env var YOUR app reads for its
      # email-API base URL. The harness sets it to the in-sandbox catch — do NOT also
      # list it in subject.env. VERIFY the app actually reads this variable: a stock
      # email SDK does not honor a base-URL env unless the app passes it through, and
      # an app that ignores it sends real mail (or throws) while the inbox stays empty.
      # A run where the catch captured zero sends warns at teardown for exactly this.
```

That is the whole block for the common case. Every lane automatically gets a
deterministic inbox address (`<laneId>@example.test`), and each actor's prompt is
extended with the full handoff: its address ("when the app asks for an email
address, enter exactly that"), the inbox URL to open, and the wait steering
("waiting for an email is normal, not a blocker"). Declare `recipients` only to
customize addresses or limit which lanes do email:

```yaml
    recipients:
      - lane: signup-01 # this lab's REAL lane id — a roster lane's `id`, or the
        # generated lane-01..lane-NN names when you use `count`. An unknown lane
        # is a hard parse error listing the lab's actual lane ids (a mismatch
        # would silently disable the funnel for that seat, which is how a
        # 6-actor field run lost every inbox at once). Lanes you leave out get
        # no inbox and are never told one exists — the parser warns which.
        address: user@example.test # what the actor signs up with; the evidence
        # drain matches captured mail against it.
```

The app keeps calling its email API normally (Resend/SendGrid-shaped, or a custom
profile); only the base URL is redirected. Route support: the clone/local-tree
computer-use route (inbox on the sandbox's own loopback) and the CONCURRENT
shared-world route (inbox getHost-exposed from the subject sandbox; the default
since every seat now runs live at once). Declared anywhere else — app-url /
operator-provided subjects, or a sequential `concurrency: 1` shared world — it is
warned inert at parse: no catch exists there and no actor hears about an inbox.
It needs `python3` in the subject sandbox (the stock E2B desktop has it).
Evidence is digest-only (`humanish.comms-thread.v1` — counts and digests, never
raw mail); the *readable* proof a persona saw the email is its screenshots of the
inbox page. See `docs/contracts/schemas.md` for the full `comms:` shape and
`humanish <cmd> --help` for run flags — this skill does not restate them.

## First Proof Run

Run the no-credentials path first. This proves Humanish artifact plumbing, not
target app behavior:

```bash
npx humanish doctor
npx humanish watch
npx humanish verify --run latest --json
npx humanish feedback issue --run latest --repo example/app --format markdown
```

For CI or non-interactive proof:

```bash
npx humanish watch --json --no-open
npx humanish lab run first-run --json --no-open
```

The feedback command prints a public-safe Markdown draft. It must not call the
GitHub API, require a token, update Projects, use provider credits, or claim
product behavior proof from a dry run.

When the target app can run locally, prove real browser behavior with
`run --app-url` after starting the app on loopback:

```bash
# in another terminal, start the target app on 127.0.0.1 or localhost
npx humanish run --app-url http://127.0.0.1:<port> --sims 2 --json
npx humanish verify --run latest --json
npx humanish watch --run latest --detach --no-open --json
```

Do not use `humanish watch --sims ...` as a substitute for app-url proof.
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
npx humanish watch .humanish/labs/local-live.yaml --env-file .humanish/local/provider.env
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
- generated local artifact paths under `.humanish/`;
- whether redaction passed;
- what remains blocked before live browser, OpenAI, E2B, or GitHub mutation.
