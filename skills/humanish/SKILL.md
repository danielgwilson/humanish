---
name: humanish
description: Install and configure humanish CLI in a JavaScript app as an open-source-safe persona simulation harness. Use when an agent needs to add humanish, run safe first setup, create synthetic personas or scenarios, configure env var names without values, capture the email an app sends so a persona can complete an email-gated flow (e.g. a signup verification link or one-time code), run verification and Observer commands, or draft public-safe feedback issues without GitHub mutation.
---

# humanish CLI

Use this skill to add humanish to a target app without relying on chat memory or
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

| Instead of the TUI  | Use                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------- |
| browsing labs       | `npx humanish lab list --json`                                                         |
| browsing runs       | `npx humanish runs --json`                                                             |
| starting a run      | `npx humanish lab run <lab> --json --no-open`                                          |
| a run's outcome     | `npx humanish review --run <id> --json`                                                |
| communication setup | `npx humanish comms providers --json` and `npx humanish comms connections list --json` |

If a human asks you to "open the TUI", tell them the command to type; do not run
it on their behalf.

For AgentMail credential setup, a human can open `humanish tui`, press `c`,
and choose **Add API key**. Hidden entry returns to Connections after saving or
cancelling. The key is stored for that OS user, while the connection profile is
project-local. Never ask for the key in chat. The CLI alternative is
`humanish keys set agentmail` (hidden prompt; agents may use `--stdin` from an
authorized credential source), followed by
`humanish comms connections add agentmail --json`. Existing env/file precedence
and `HUMANISH_STRICT_KEYS=1` still apply. Read installed provider capabilities:
use `humanish comms check --online --json` for read-only authentication.
Authentication does not establish mailbox permissions, capacity or delivery.
`humanish comms configure --lab <path> --json` previews an ignored lab copy;
add `--apply --plan-token <digest>` to save the reviewed version. Launch its
exact returned path, not a basename that could resolve to another manifest.

## Setup Workflow

1. Inspect public target-repo files only: `package.json`, docs, route/app
   structure, test scripts, and `.gitignore`.
2. Install humanish with the repo's package manager:

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

## Choosing a findings analyst

Analysis is separate from the participant. Hosted and manual defaults use the
OpenAI API with its own admission budget. An explicitly local browser study with
a Codex participant defaults to a separate Codex account analyst. To select that
restricted Codex ChatGPT account analyst on other supported studies,
set `review.analysis.provider: codex` or pass `analyze --provider codex` on a
completed recording. This uses remote inference and the qualified CLI/login,
not local inference or the participant's existing conversation. See
[the analysis contract](../../docs/contracts/study-analysis.md) for the current
CLI/model qualification and setup limits.

Do not pass numeric `maxCostUsd`/`maxOutputTokens` or their CLI flags to the
account branch. It cannot enforce those ceilings and rejects them. Account dollar
cost remains unknown even when token usage is reported. There is no fallback to
an API key or another provider. `analyze --dry-run --provider codex` validates
local evidence/configuration only; `doctor --lab` checks setup without a model
request. Inspect a failed attempt before explicitly retrying `--provider codex
--rerun`. Opening Observer never starts analysis.

## Local browser setup

On Linux x64 with local rootful Docker, KVM and TUN, or a supported M3-or-newer
Mac with native ARM64 Node and Lima 2.2+, an `app-url` lab can set `execution.target: local` and `actors[0].type: local-agent` with
`localAgent: codex`. It uses the supported Codex ChatGPT login, not E2B or an
OpenAI API key. Inference is remote and consumes account quota. Existing hosted
labs stay hosted; never silently change their execution or billing provider.

Use `humanish runtime status --json` and `humanish doctor --lab <path> --json`
for read-only setup inspection. `humanish runtime setup` downloads and verifies
the pinned runtime; a live local run also prepares it automatically. The normal
`humanish lab run <path>` command and TUI use the same study runner and Observer.
See [the complete example and limits](../../docs/architecture/local-browser-runtime.md).

Local browsers currently require a loopback app URL with an explicit port above
1023 and use a 960×720 Chromium desktop. For email-gated local apps, start
`humanish comms catch`, point the app's email sends at it, and declare
`comms.email.external.catchBaseUrl`. Use `doctor --lab` to check its recipient
routes. This captures app sends without mailbox-provider credentials; it does
not receive arbitrary internet email. Each participant gets only its assigned
inbox through the local desktop. Real receiving still needs a supported hosted
route. See [captured inbox setup](../../docs/architecture/comms-inbox.md#local-browser-studies).
Optional camera and spoken conversation require a separate media
runtime; follow [participant media](../../docs/architecture/participant-media.md)
for setup and provider limits. Speech uses the same continuing Codex participant,
not a second conversation. Do not claim that installing the CLI also installs
Docker or Lima, or qualifies a machine for arbitrary participant counts.

For continuous desktop playback, independent computer-use participants can opt into
`execution.desktop.recording: { audio: true }` (`false` for screen-only video).
Screenshots remain the default. Recording does not enable camera or speech;
the raw media stays local-only. See [desktop recording](../../docs/architecture/desktop-recording.md)
for runtime requirements and export limits.

## Format Stack

When creating or editing humanish files:

- use `.yaml` for human-authored humanish source: labs, personas and scenarios;
- use `.mjs` for executable adopter scorers named by `review.scorer.ref`;
- use `.json` or `.ndjson` for generated machine artifacts, Observer data, run
  bundles, event streams, and synthetic fixtures.

Do not create `.yml` files under `humanish/`; `.yml` is for outside ecosystem
conventions such as GitHub Actions workflows. Do not introduce TOML unless the
target project has a concrete scalar global-config need that YAML, TypeScript,
or JSON does not serve.

## Authoring Personas And Scenarios

Create or edit only synthetic files under `humanish/`.

Personas describe the participant's relevant experience, motivations, habits and
access needs. A short profile is enough; use optional multiline `background` for
richer context (up to 32 KiB of UTF-8 text, never silently truncated). `summary` is
a short description, capped at 280 characters with a warning. Unknown fields such
as `backstory` are ignored with a warning; put that material in `background`.
Use synthetic or de-identified research synthesis, never raw customer interviews
or personal data in committed files.

```yaml
schema: humanish.persona.v1
id: volunteer-organizer
name: Morgan
summary: A volunteer organizer trying an unfamiliar planning app.
background: |
  Morgan coordinates twelve volunteers using spreadsheets and email.
  They know those tools well but have never used this product.
  Reconciling replies takes time. They worry about making the roster
  public and want to keep a usable copy if the group changes tools.
```

A profile with `background` receives only explicitly declared trait directives.
Legacy profiles without it retain medium defaults for missing patience and
technical confidence. Avoid contradictory prose and traits; inspect the compiled
brief with `humanish lab inspect <lab> --json` before running.

For an autonomous participant study, use a computer-use/local-agent lab and write
its `mission` as a believable situation and desired outcome. Supply fixture facts
needed to act, but do not supply selectors, click sequences, hidden success rules,
expected defects or recovery tricks. For example: “Saturday's event needs two
setup volunteers and one cleanup volunteer. See whether this app helps you
organize the event and keep people informed.” Do not instruct a participant to
find a specific UI control merely to make the study succeed. Allow discovery,
recovery and stopping appropriate to the participant. Keep researcher criteria in
`tasks[].success`, separate from participant-facing `tasks[].goal`.

Scripted regression checks are a different use of scenarios. When the requested
work is deterministic verification of a known path, a `browser.steps` manifest
can drive it with explicit selectors and assertions. It does not establish
independent persona behavior or discoverability. Keep app-specific paths and
fixtures in the target repo's `humanish/` files.

```yaml
schema: humanish.scenario.v1
id: product-core-flow
title: Scripted product regression
persona: synthetic-new-user
goal: Verify a known path with synthetic data.
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

- **Every declared participant runs live at once by default.** A 6-participant
  roster is 6 simultaneous actors; total sessions and spend are the same either
  way, only wall-clock and simultaneity differ. `execution.concurrency` is a
  CAP, not a mode: declare it only to bound simultaneous paid desktops, and
  expect a parse warning when the cap makes participants run in waves (a green
  waved run looks identical to the all-live run you meant, so the harness says
  so up front).
- **Separate worlds (`per-lane-worlds`) vs one shared world.** A plain
  multi-participant computer-use lab gives each actor its OWN app instance
  (independent studies in parallel). Add `subject.topology: shared-world` for N
  actors in ONE world (a lobby, a shared DB, actors seeing each other's
  changes). Shared-world participants run at once; `execution.concurrency` must
  be at least 2 there.
- **Watching it:** each live participant is its own Observer tile/stream;
  participants beyond a declared cap start when a slot frees, which on a capped
  run looks like idle tiles — another reason to leave the cap out unless you
  need it.

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

### Off-app email verification (comms)

When a flow needs an email from the app — a verification link, one-time code or
magic link — configure an inbox so the participant can read and use that message.
humanish supports local capture and fresh hosted receiving, with different setup
and privacy behavior.

Choose the transport to match the app:

- **Local capture** (below): app send configuration can point at a test catch;
  no external mail service is needed. It tests the email flow without proving
  real delivery.
- **Real AgentMail receiving**: use `comms.email: { connection: agentmail }`.
  humanish acquires one fresh hosted inbox per participant before desktops start.
  The app sends normally. Requires a configured organization-scoped key and
  app-url/clone/local-tree hosted computer-use participants; shared worlds
  work, local-agent does not. Do not combine
  connection with capture settings or substitute fresh addresses for existing
  account identities. `allowedOrigins` can name additional trusted link origins.

Real mail can reach hosted desktops, actor models and analysis models. Screenshots
can contain it. Such runs remain `local_only` even after screenshot blurring;
this is a publication restriction, not local-only processing. Provider charges
and model charges are separate. Use `humanish comms recover --json` after an
interrupted run, then `humanish comms recover --run <id> --apply --json` for its
privately recorded resources. Never derive deletion authority from run artifacts.
SMS, participant sending, borrowed inboxes and other providers remain unavailable.
See `docs/architecture/real-email-receiving.md` for limits and recovery.

The following configuration selects **local capture**:

```yaml
comms:
  email:
    injectEnv:
      RESEND_API_URL # adopter-named: whatever env var YOUR app reads for its
      # email-API base URL. The harness sets it to the in-sandbox catch — do NOT also
      # list it in subject.env. VERIFY the app actually reads this variable: a stock
      # email SDK does not honor a base-URL env unless the app passes it through, and
      # an app that ignores it sends real mail (or throws) while the inbox stays empty.
      # A run where the catch captured zero sends warns at teardown for exactly this.
```

That is the whole block for the common case. Every participant automatically gets a
deterministic inbox address (`<laneId>@example.test`), and each actor's prompt is
extended with the full handoff: its address ("when the app asks for an email
address, enter exactly that"), the inbox URL to open, and the wait steering
("waiting for an email is normal, not a blocker"). Declare `recipients` only to
customize addresses or limit which participants do email:

```yaml
recipients:
  - lane: signup-01 # this lab's REAL participant id: a roster entry's `id`, or the
    # generated lane-01..lane-NN names when you use `count`. An unknown id
    # is a hard parse error listing the lab's actual participant ids (a mismatch
    # would silently disable the funnel for that participant, which is how a
    # 6-actor field run lost every inbox at once). Participants you leave out get
    # no inbox and are never told one exists — the parser warns which.
    address: user@example.test # what the actor signs up with; the evidence
    # drain matches captured mail against it.
```

The app keeps calling its email API normally (Resend/SendGrid-shaped, or a custom
profile); only the base URL is redirected. Route support: the clone/local-tree
computer-use route (inbox on the sandbox's own loopback) and the CONCURRENT
shared-world route (inbox getHost-exposed from the subject sandbox; the default
since every participant now runs live at once). SMTP capture is supported on
provisioned routes with separate worlds (`per-lane-worlds`); shared-world SMTP
is rejected because it is not wired there.
For app-url/operator-provided subjects, run `humanish comms catch` on a reachable
host, point the app's email sends at that catch, and declare
`comms.email.external.catchBaseUrl` (plus `inboxBaseUrl` if different). A declared
`authTokenEnv` is an environment variable name, never a credential value.
The in-sandbox catch
needs `python3` (the stock E2B desktop has it).
Evidence is digest-only (`humanish.comms-thread.v1` — counts and digests, never
raw mail); the _readable_ proof a persona saw the email is its screenshots of the
inbox page. See `docs/contracts/schemas.md` for the full `comms:` shape and
`humanish <cmd> --help` for run flags — this skill does not restate them.

## First Proof Run

Run the no-credentials path first. This proves humanish artifact plumbing, not
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

When the target app can run locally, prove a known browser path with a
scripted-browser lab after starting the app on loopback. The lab replays a
`browser.steps` scenario (see above) on a desktop surface, plus a mobile one
with `count: 2`. The scripted steps make no model requests. Post-run analysis
still runs by default when `OPENAI_API_KEY` is set, with a $3 cap; keep
`review.analysis: false` to skip it. Copy the shape of
[`humanish/labs/scripted-demo.yaml`](https://github.com/danielgwilson/humanish/blob/main/humanish/labs/scripted-demo.yaml)
or the example in the
[lab manifest reference](https://humanish.dev/docs/lab-manifests#scripted-browser-scenarios):
set `subject.appUrl` to the loopback URL, `scenario.ref` to the scenario id,
and `scenario.mode: live`. Without `mode: live` the lab is a dry run that opens
no browser.

```bash
# in another terminal, start the target app on 127.0.0.1 or localhost
npx humanish lab inspect <lab> --json
npx humanish lab run <lab> --json --no-open
npx humanish verify --run latest --json
npx humanish watch --run latest --detach --no-open --json
```

Do not use `humanish watch --sims ...` as a substitute for a scripted-browser
lab. `watch` renders or follows Observer evidence; a live scripted-browser lab
captures desktop and mobile browser evidence against a running app.

## Optional Live E2B Lab

Live headed E2B desktop participants are optional. Add the substrate dependency only
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
