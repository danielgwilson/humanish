# humanish

Synthetic user research for apps, CLIs, and agent-facing product flows.
Open-source and public-safe.

Humanish runs studies. Realistic synthetic participants, each with its own
goals, patience, and skill, actually use your product on hosted desktops while
you watch. A study leaves verifiable evidence: screenshots, action traces,
per-task completion funnels, participant outcomes with the denominator
attached, and estimated cost lines. A fail-closed share-safety gate stands
between that evidence and anything public, and the end of the pipeline is a
public-safe feedback draft you can turn into a real issue. Committed study
source lives under `humanish/`; run evidence lands under gitignored
`.humanish/`.

![Humanish Observer grid of a live four-persona drawDB study: four completed lanes, each showing its final full-desktop screenshot and outcome](https://unpkg.com/humanish@0.16.0/docs/assets/humanish-drawdb-hero.png)

A live four-persona study of [drawDB](https://github.com/drawdb-io/drawdb), a
public open-source database diagram editor, driven against a commit-pinned
local checkout. Every lane is a real computer-use session on a hosted desktop;
the captions are each persona's own final report. drawDB is the application
studied; it is not a Humanish adopter or endorser.

## Three Roles

Every design decision in humanish is checked against the three people a study
actually involves ([docs/principles/three-roles.md](docs/principles/three-roles.md)):

- **The researcher** (usually a coding agent driving the CLI) declares the
  protocol: personas, discrete tasks with success criteria the participant
  never sees, and a budget set once at the study level, the way recruiting
  decisions are made.
- **The stakeholder** watches through Observer, drives from `humanish tui`, and
  reads results that carry their denominator: `2/2 reached the goal, 1 reported
  friction; tasks: reach-signup 2/2 · read-verification-mail 2/2`.
- **The participant** is the persona: the subject of the study, never its
  instrument. A participant abandoning a task is a finding about the product,
  not a harness failure.

In practice: a two-participant study of an email-gated signup on a public
open-source document app completed end to end (signup, verification mail read
in a captured inbox, signed-in dashboard), and the keyboard-first participant
reported, unprompted, that the signature step could not be completed without a
mouse. The panel cost about $1.50 and the receipts are committed under
[docs/goals/email-gated-signup/receipts/](docs/goals/email-gated-signup/receipts/).

## Install

```bash
npm i -D humanish
npx humanish init --yes       # sets up, then tells you the next command for THIS machine
npx humanish run first-run    # a study with no keys and no spend — about a minute
npx humanish run try-live     # a REAL study on a hosted desktop, capped at $2
```

**What it finds, measured (2026-09-01 to 09-04, receipts in `bench/` and `docs/goals/`):** 58 of
60 planted defects over four benchmark runs on an app we wrote, none invented in 15 clean runs, and
14 of 15 with a second brain (the operator's own Claude Code as the participant, 0 invented in 3 more); on
two apps we did not write, 16 of 18 distinct findings confirmed against the source and 0 invented,
across 14 participants; a drawDB modal reported by 5 of 5 keyboard-first participants (3 stopped
there) and never mentioned by 5 mouse-driving newcomers; a TodoMVC rename that blocked 6 of 6
keyboard-first participants and none of the others; and, on a phone-sized desktop, a drawDB
relationship drag intercepted by a popover that both phone participants hit (one stopped) and no
desktop participant reported; under mobile emulation with touch, TodoMVC's double-click rename
stopped 4 of 4 phone participants while 4 of 4 desktop newcomers finished, and Excalidraw read
12 of 12. Each file states its own caveats.

`try-live` studies a real public app so that your first live run works without
configuring anything; point its `subject` at your own app once you have seen it
run. It needs `E2B_API_KEY`, and a model: either a provider key or a coding
agent you are already signed in to (see below). Measured on 2026-09-01 from
three fresh directories against the published 0.65.0: 3 of 3 reached the goal,
108 to 111 s each, about $0.16 each, and all three reported the same two
frictions in the demo app
([receipt](docs/goals/computer-use-actor/receipts/cold-install-try-live-2026-09-01.md)).

**Install it, do not one-shot it.** A live run needs the optional peer
`@e2b/desktop`, and Node resolves that relative to humanish itself, so a
one-shot `npx humanish@latest` can never find it, no matter what your project
has installed. `npm i -D humanish @e2b/desktop` once, then `npx humanish …`
resolves the local copy and works. The dry-run path (`humanish run first-run`)
needs none of this.

The package is `humanish`; the installed binary is `humanish`. For a one-shot
command before installation, use `npx --package humanish humanish ...` to
guarantee the binary comes from the `humanish` registry package rather than a
same-named command already on your PATH.

For coding agents, install the repo skill first:

```bash
npx skills add danielgwilson/humanish --skill humanish
```

The skill lives at [`skills/humanish/SKILL.md`](skills/humanish/SKILL.md)
for skills.sh discovery.

## A First Live Run Without a Provider API Key

A live study normally needs a provider API key. If you already have a coding
agent signed in (Codex on a ChatGPT plan, Claude Code on a Max plan), humanish
can use it as the participant's brain instead, and then the only credential it
needs is `E2B_API_KEY`.

```bash
humanish doctor      # says which local agents are installed and signed in
```

```yaml
actors:
  - type: local-agent   # instead of openai-computer-use
    persona: synthetic-new-user
    mission: >-
      ...
```

humanish never reads those credentials. It checks that the credential file
**exists**, spawns the CLI tool-restricted (`--sandbox read-only` for Codex,
`--allowedTools Read` for Claude Code) in a scratch directory, and hands it one
screenshot per turn. The agent only **decides**; humanish performs the action
inside the E2B sandbox, so nothing the persona chooses ever runs on your machine.

Three things to know before you rely on it:

- **It is not free.** Subscription usage consumes your own plan. Runs driven this
  way record `estimatedCostUsd: null` with `reason: "no_token_usage"` rather than
  `$0`, because `$0` would be untrue. Rate limits on those plans are built for
  interactive coding; humanish fails closed with the CLI's own message and does
  not retry into them.
- **It is slower.** Roughly 9 seconds per turn against about 3 for a direct API
  call, so give the lane a longer `execution.timeoutMs` than you would otherwise.
- **The evidence says which brain ran it.** The trace records
  `ids.model: "codex app-server (local, operator-authenticated)"` or
  `"claude (local, operator-authenticated, one session per run)"`, so a
  local-agent run is never silently compared against an API one.
- **Both agents keep one conversation for the whole run.** Codex through an
  app-server thread, Claude Code through one `claude -p` stream-json session.
  A participant that starts every turn cold cannot remember trying the menu
  and tries it again; measured on one lab, that was 188 actions over 90 turns
  and no finish against 21 actions over 8 turns. `HUMANISH_LOCAL_AGENT_ONE_SHOT=1`
  keeps the cold-start path for the Claude agent as a measurement switch, so
  "remembers" can be compared against "does not" on your own lab; the trace's
  `ids.model` says which ran.

## Telemetry

humanish collects anonymous usage data by default (which command ran, whether it
worked, roughly how long it took) so the maintainers can tell whether anyone
reaches a working first run. It never sends your labs, subjects, personas, paths,
or evidence, and there is no field in the payload that could.

```bash
humanish telemetry status     # the exact document that would be sent
humanish telemetry disable    # or set DO_NOT_TRACK=1
```

Full detail, including why it exists and everything it cannot contain:
[TELEMETRY.md](TELEMETRY.md).

## Public-Safety Boundary

Humanish is designed for public repositories and public issue queues. The
boundary is three planks, each enforced where it actually holds:

**1. This repo and the published package are kept public-safe by CI.** Every
push runs a public-surface scan (secret/key/path shapes, a sha256 binary-asset
allowlist, over both tracked files and the packed npm payload) plus a
full-history gitleaks scan. That protects what we ship; it does not scan your
repo.

**2. The harness never persists secret values into run artifacts.** On every
route, values it provisioned are scrubbed by literal match (they have no shape
for patterns to catch) and secret-shaped content is pattern-redacted before any
log tail, harness error, or model narration lands on disk. Env var names are
evidence; values never are. Pixels are the exception: a raw screenshot shows
whatever was on screen, which is why plank 3 exists.

**3. Run bundles are local by default.** Evidence lands under gitignored
`.humanish/`, and no command publishes it for you. Sharing evidence (committing
screenshots, pasting transcripts, attaching bundles to issues) is a deliberate
act, and reviewing what you share is on you. Use synthetic personas and
synthetic data so there is nothing sensitive to capture in the first place.

**What the automated gate enforces.** `humanish verify` scans public-bound
artifacts and fails closed on secret, key, and token shapes and on known local
path shapes. It does not yet detect free-form PII or PHI such as names, emails,
phone numbers, dates of birth, or medical identifiers. Keeping those out depends
on using synthetic data and on review, so `redaction: passed` means the
automated secret and path scan found no matches, not that the artifact was
certified free of PII or PHI. A first-class PII/PHI detector is on the roadmap
([#108](https://github.com/danielgwilson/humanish/issues/108)).

`humanish verify --json` also reports `shareSafety.status`:

- `share_ready`: the verified bundle is eligible for public feedback drafts;
- `local_only`: the bundle is valid local evidence, but should not be shared as-is
  (for example, full-fidelity raw screenshots are present);
- `blocked`: the bundle failed verification or public-safety gates.

Feedback commands require `share_ready`. A valid local run can still be
reviewed in Observer without being promoted into a public issue draft.

## How It Works

```text
humanish/      committed source plane: labs, personas, scenarios, policy, adapters
.humanish/    ignored runtime plane: runs, Observer output, reviews, local state
```

The first-run path does not require credentials:

```bash
npx humanish doctor
npx humanish watch
npx humanish verify --run latest --json
npx humanish feedback issue --run latest --repo owner/repo --format markdown
```

`humanish watch` starts a fresh four-lane synthetic run, renders the Observer,
opens it in the browser, serves it over localhost, and keeps the shell attached.
After `humanish init`, named lab manifests can be run the same way:

```bash
npx humanish watch first-run
npx humanish lab list
npx humanish lab inspect first-run
npx humanish lab preflight first-run
```

The CI-safe equivalent is:

```bash
npx humanish watch --json --no-open
```

## The Terminal Surface

Every other humanish command is built so an agent can drive it. `humanish tui`
takes the screen and waits for a person.

```bash
npx humanish tui
```

Arrow keys move, `enter` opens, `esc` goes back, `q` quits. There are three
screens, and you move between objects rather than between states: the set of
labs, one lab, one run. A run's lifecycle
renders in place, so a run you are watching changes from running to its verdict
without the screen moving under you.

- **labs**: every lab in the project, whether or not it has ever run. Labs with
  something running now sort first. Each row carries what to expect from a live
  run of it; a lab with no live history says `no live runs yet` and does not
  quote a median from dry runs, which spend nothing and take no time.
- **lab**: that lab's history, and two ways to start it. A dry run starts on one
  keypress because it cannot cost anything; a live run is armed by the first
  `enter` and committed by the second, restating the cost in between.
- **run**: who is in the run, what they are currently thinking, and how far they
  have got, with time and money underneath. A terminal cannot show screenshots,
  so the run's self-contained Observer artifact is named for you to open.

A run you start from the surface is detached: it keeps going if you quit the
TUI, and it survives losing the SSH session you started it over. The surface
follows it by reading `.humanish/runs/<id>/status.json`, holding no handle on
it, so you can quit mid-run, reopen, and find it still there.

Requires an interactive terminal and Node 22 or newer. It refuses anything else
with a structured error rather than rendering escape codes into a pipe:

```console
$ humanish tui --json < /dev/null
{
  "schema": "humanish.tui-result.v1",
  "ok": false,
  "error": {
    "code": "HUMANISH_TUI_REQUIRES_TTY",
    "message": "humanish tui needs an interactive terminal. For scripted or agent use, `humanish runs --json` lists the same runs and `humanish lab run --json` starts one."
  }
}
```

Every other command still works on Node 20; only this surface needs 22.

## Serve the Library

`humanish watch` follows one attached run; `humanish serve` serves the whole
local run library under `.humanish/runs/`, a library index plus every run's
Observer page:

```bash
npx humanish serve
npx humanish serve --expose --tunnel ngrok --oauth google --allow-email you@example.com
npx humanish serve --safe --expose --tunnel ngrok
npx humanish serve --expose --public-url https://observer.example.com
```

The first serves the library on loopback only. The second is the phone path:
ngrok's edge authenticates viewers with Google OAuth (restricted to your
`--allow-email`/`--allow-domain` allow rules) before any request reaches the
loopback server; humanish carries no in-process auth. The third is a secretless
safe observer: no login, but only runs whose `humanish verify` shareSafety is
`share_ready` exist at all; everything else is absent and 404s. The fourth
trusts an edge you already secure (Cloudflare Access, Tailscale, a proxy you own)
and just binds loopback behind it.

In every mode the server binds `127.0.0.1`; exposure only ever happens through
an authenticated edge forwarding to the loopback port. Exposure is fail-closed:
`--expose` always needs a reachable public origin (a `--tunnel` or a `--public-url`,
even under `--safe`), and then requires either edge auth (`--oauth` on the tunnel,
or a `--public-url` you secure) or `--safe`. `--oauth google` with no allow rule
lets any Google account in and warns loudly.

### Watch a live run from your phone

`humanish watch <cua-lab> --expose --tunnel ngrok --oauth google --allow-email
you@example.com` streams the live desktop of a computer-use run to an
edge-authenticated remote viewer while it plays. The attached server comes up
during the run and survives a timed-out/failed run, so you can inspect a failed
run's evidence too. A live run is never `share_ready`, so `watch --expose` always
requires edge auth; `--safe` is a `serve` library filter and is rejected on watch
(`HUMANISH_WATCH_SAFE_NOT_APPLICABLE`). An exposed watch serves only the attached
run (its history lists just that run and every other run id 404s), so a remote
viewer can never reach your other runs' raw evidence.

Live E2B desktop stream URLs are served only on `watch --expose`, and only behind
edge auth; `serve` never injects them (remote viewers of the library see only
persisted evidence: screenshots, events, terminal tails). See
[Serve architecture](docs/architecture/serve.md).

## Commands

| Command | Purpose |
| --- | --- |
| `humanish init` | Scaffold committed `humanish/` source and ignored `.humanish/` runtime state. |
| `humanish doctor` | Explain readiness and missing setup. |
| `humanish tui` | Interactive terminal surface for browsing labs and runs and starting a run. Humans only; it refuses a non-interactive stdin or stdout. |
| `humanish run --dry-run` | Generate a synthetic run bundle without browser, keys, or provider spend. |
| `humanish run --app-url http://127.0.0.1:<port>` | Capture live desktop/mobile browser evidence against a running local app. |
| `humanish watch [lab]` | Run sims or a named lab, open Observer, and keep watching. |
| `humanish serve` | Serve the local run library over loopback; optional tunnel-edge authenticated or share-safe exposure. |
| `humanish lab list` | List committed and ignored lab manifests. |
| `humanish lab inspect <lab>` | Show the source manifest for a lab without running it. |
| `humanish lab preflight <lab>` | Check lab routing and optional target reachability before actor/model spend. |
| `humanish lab run <lab>` | Run a lab manifest in human or JSON mode. |
| `humanish verify` | Validate a run bundle and public-safety gates. |
| `humanish cleanup` | Inspect recorded resource evidence and write `cleanup.json`; stored IDs do not authorize provider mutation. |
| `humanish review` | Read review evidence for a run. |
| `humanish runs` | List local runs and latest pointers. |
| `humanish export` | One self-contained `.html` of a run's Observer with screenshots inlined; verify and the share_ready gate run inside, `--local-only` watermarks a raw-screenshot bundle. |
| `humanish stats` | Cost, outcome, and duration roll-ups across run history; `--lab`, `--since`. Estimates stay labelled; unknown costs count as unknown. |
| `humanish feedback list` | List a run's draft state and every feedback candidate (one per participant finding), with the ids `--candidate` takes. |
| `humanish feedback issue` | Print a public-safe GitHub issue draft without API mutation. `--candidate <id>` chooses which finding; default is the first. |
| `humanish lab run oss` | Repo-maintainer contract example: dry-run Observer-of-Observers for authorized repo selections. |
| `humanish lab run oss-smoke` | Repo-maintainer dogfood example: disposable clone smoke test against public OSS repos. |

## Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Commander usage error: unknown command, unknown option, or a missing/invalid argument. |
| `2` | Humanish domain or validation failure. Check the JSON envelope's `error.code` for detail. |
| `128+N` | Terminated by signal `N`: `130` for SIGINT, `143` for SIGTERM, `129` for SIGHUP. |

## Lab Manifests

Labs are authored as `.yaml` source:

```text
humanish/labs/*.yaml          committed public-safe labs
.humanish/labs/*.yaml         ignored local labs
.humanish/local/labs/*.yaml   ignored private or machine-specific labs
```

Committed labs should be useful to anyone who clones the project. Private repo
targets, token-backed provider settings, and local-only dogfood variants belong
in ignored `.humanish/` lab manifests and can be run explicitly:

```bash
npx humanish watch .humanish/labs/local-dogfood.yaml --env-file .humanish/local/provider.env
npx humanish lab run .humanish/labs/local-dogfood.yaml --json --no-open
```

`--env-file` loads values for the current process only. Humanish reports loaded
env var names, never values, and does not persist those values into run bundles
or Observer data.

### Computer-Use Labs

A computer-use lab dispatches a **registered computer-use actor** (`actors[0].type`,
resolved against the actor registry, e.g. `openai-computer-use`) to drive an app in
a hosted E2B desktop browser and emit an evidence bundle under gitignored
`.humanish/` (full-fidelity screenshots by default, see below; length-only typed
text; provider-neutral `humanish.actor-trace.v1` on the stream). Two subjects route
here:

- **`subject.source: clone`** (+ `execution.target: e2b-desktop` + a computer-use
  actor): the lab clones your repo into the sandbox, runs your declared
  `serve.install`/`serve.build`/`serve.start` commands (detached, with readiness
  probing), and drives the served app at `serve.url`. Subject env var names declared
  in `subject.env` are provisioned from `--env-file` (names land in evidence; values
  never do). The bundle records provenance: repo, cloned commit, env names.
- **`subject.source: app-url`**: you (a library caller) provision the app yourself
  via the `prepareDesktop` hook (`runLab(config, { cuaHooks: { prepareDesktop } })`)
  and the actor drives the URL you declared.

```yaml
subject:
  source: clone
  repos: [example-org/example-app]
  serve:
    install: pnpm install --frozen-lockfile
    build: pnpm build
    start: pnpm start
    url: http://127.0.0.1:3000/
actors:
  - type: openai-computer-use
    mission: Explore the app as a first-time visitor and complete its primary flow.
execution: { target: e2b-desktop }
scenario: { mode: live }
```

```bash
npx humanish lab run cua-browser                 # dry-run contract bundle (no spend)
```

Live runs (`scenario.mode: live`) need `OPENAI_API_KEY` + `E2B_API_KEY` (pass via
`--env-file`) and the optional peer dependency: `npm i -D @e2b/desktop`. A cloned
subject is served **inside** the sandbox on loopback; to instead drive a deployment
you own (a Vercel preview, staging), use an `app-url` subject with
`policies.allowPublicTargets: true`. The actor's API key never enters the sandbox;
only declared subject env names do. `humanish init` scaffolds an example at
`humanish/labs/cua-browser.yaml`.

**Off-app email/SMS verification (`comms`).** When a flow is gated behind an email or
SMS the app itself sends (a signup verification link, a one-time code, a magic link),
add a `comms:` block to the lab. Humanish redirects the app's email-API sends (via
one adopter-named env var: with the official Resend SDK it is `RESEND_BASE_URL`,
which the SDK reads on its own, so nothing in the app has to change; other providers
need the app to actually pass the env through, and a run whose catch captures zero
sends warns at teardown) into a catch **inside** the sandbox, so nothing leaves the
machine. Every lane gets a deterministic inbox address automatically, and each
persona's prompt carries the full handoff: the address to sign up with, the inbox URL
to open, and that waiting for an email is a next step, not a blocker. The run bundle
gets a digest-only `humanish.comms-thread.v1` artifact (from/to/subject/link
digests + an OTP count; no raw address, link, or code persists); the readable proof a
persona saw the email is its inbox-page screenshots. Hosted on the clone/local-tree
computer-use lanes and the concurrent shared-world route (warned inert elsewhere),
vendor-neutral (Resend/SendGrid shaped, or a custom profile).
See `docs/contracts/schemas.md` for the full `comms:` shape.

**Screenshots are full-fidelity by default.** Run bundles live in gitignored
`.humanish/`, so the Observer shows exactly what the persona saw. Set
`policies.redactScreenshots: true` to persist blurred thumbnails at capture instead
(for unowned subjects, or bundles you intend to share as-is). Raw bundles stay local
in gitignored `.humanish/`; nothing scans the pixels, so review them before sharing
anywhere. A redact-on-export step is planned. The frame sent to the model is always
full-resolution regardless. (Doctrine: `docs/principles/invariants-and-defaults.md`.
Redaction binds the publish boundary, not capture.) `humanish verify` reports
raw-screenshot bundles as `shareSafety.status: local_only`; `humanish feedback issue`
refuses them until the run is share-ready.

**Device presets.** `execution.desktop.device` picks the hosted desktop screen size:
`mobile` (414×896), `small-mobile` (360×740), `narrow-mobile` (320×700), `tablet`
(820×1180), `desktop` (1440×950, default), or `wide` (1920×1080). The values are copied
from the mature in-house sims. **Honest fidelity:** on the computer-use / E2B-desktop
route width/height size the virtual display and browser outer window. The actual page
viewport is smaller because browser chrome occupies space; Chromium-family live bundles
measure it through CDP and record it separately from requested/verified screen geometry.
Browsers without that measurement seam omit the viewport rather than guessing. A
site's width-based responsive CSS still fires, and the model is *told* its device in the
prompt, matching how those sims run organic mobile lanes. Without the block below there is no
touch input, the device-pixel-ratio isn't rendered, and the user-agent stays desktop on this
route. Device is run-wide today; per-*persona* device (N personas × devices) lands with fan-out.
`execution.desktop.resolution` is a raw escape hatch that overrides the preset.

**Mobile emulation.** `execution.desktop.fidelity: { mobileEmulation: true }` turns every hosted
Chrome/Chromium computer-use lane on a mobile preset (`mobile`, `small-mobile`, `narrow-mobile`)
into a mobile-emulated browser before the participant arrives, and leaves desktop, tablet and
wide lanes in the same run untouched: the lane's preset width/height become the CSS viewport (414 px for `mobile`, where the
X screen itself cannot go below 500), the preset's device pixel ratio applies (`deviceScaleFactor`
overrides it), touch events are on (`touch: false` turns them off) and the browser presents a
mobile user agent (`userAgent` replaces the default iPhone Safari string). The run bundle records
`desktopGeometry.fidelity` with `tier: mobile-emulated`, the request, the CDP methods applied,
and `resolved`: what the page itself reported afterwards (`navigator.userAgent`,
`devicePixelRatio`, `innerWidth`, `maxTouchPoints`, coarse pointer). A page without a viewport
meta lays out at 980 px, as it would on a phone, and the bundle says so. Firefox cannot be
emulated, so the lane fails closed instead of shipping a desktop run labelled mobile. The
viewport and DPR override cover the launch tab (the user agent and touch flags are browser-wide);
if an observation reads a tab the participant opened later, the lane records one warning saying
so, because that tab laid out at the window width. A bundle without a `fidelity` block is a
responsive-viewport study whatever its preset is called.

**Desktop browser choice.** Hosted computer-use lanes and shared-world actor seats use the
route's historical opener unless you set `execution.desktop.browser` to `chrome`, `chromium`,
or `firefox`. A concrete value means "launch this browser or fail"; it never silently
falls back to whatever the image prefers. When configured, run bundles record the requested
browser and the resolved in-sandbox command as `desktopBrowser`.

**Deterministic stop conditions.** Freeform computer-use actors can keep acting after the
app has already reached the state you care about. Add `stopWhen` to the actor or a lane to
stop immediately after a deterministic browser observation matches. Conditions inside one
rule are ANDed together; rules under `any` are ORed. Lane-level `stopWhen` overrides the
actor default.

```yaml
actors:
  - type: openai-computer-use
    mission: Complete the assigned browser task.
    stopWhen:
      any:
        - id: dashboard-visible
          urlPathEquals: /dashboard
          textIncludes: Dashboard
    lanes:
      - id: reviewer
        entry: /items/123
        instruction: Review the item and return to the queue.
        stopWhen:
          any:
            - id: returned-to-queue
              urlPathEquals: /items
              textIncludes: Queue
```

**A participant with a camera.** `execution.desktop.media.camera: { source: synthetic }` gives a
hosted Chrome lane a capture device: an ffmpeg test pattern generated in the sandbox (or a
`.y4m` file of yours, uploaded). The browser's own permission dialog stays in the way by default
(`policies.mediaPermission: prompt`), because the gate is where a real person hesitates or
refuses; `granted` bypasses it for studies about what happens after. The bundle records the
feed and the exact launch flags under `desktopBrowser.media`. A microphone needs an image with
an audio stack (`execution.desktop.template`); the stock desktop has none, so a declared
microphone without a template is refused before any spend.
**A declared observation window.** Some findings are "time passed and nothing broke": a call
both participants stay on, an import that finishes, a dashboard that updates. A freeform
participant with nothing to do keeps acting, so `dwell` lets the study hold instead. Once
`when` matches (or after the first observation, when there is no `when`), the harness holds the
page for `ms`, captures a frame every `everyMs` (default 10 s), takes no action and requests no
model turn, then hands control back (`then: continue`, the default) or ends the session
(`then: stop`). The window is recorded in the trace as deliberate, and it never outlasts the
session budget. Lane-level `dwell` overrides the actor default.

```yaml
actors:
  - type: openai-computer-use
    mission: Join the room, stay a while, then leave.
    dwell:
      when:
        any:
          - id: in-room
            urlIncludes: /room/
      ms: 120000
      everyMs: 10000
      then: continue
```

Supported primitives are `urlIncludes`, `urlPathEquals`, `textIncludes`, and
`appStatePathEquals`. URL and text observations are runtime-only and are not persisted into
the run bundle; the trace stores only the matched rule id and primitive names. Browser URL
and text observation requires a Chrome/Chromium CDP session in the desktop. For deterministic
browser-observed stops, set `execution.desktop.browser: chrome` or `chromium`.

**Cost tracking (estimated).** Computer-use run bundles carry an advisory `cost` block: a
per-lane token-derived model estimate plus one aggregate E2B desktop-minute estimate. Every
dollar figure is an estimate, never a provider charge. It is a rate-table multiply, always
surfaced as "~$X estimated (rates as of `<date>`)" in the Observer and the run library, and it
carries the pricing date + source so a token-derived number is never mistaken for an
authoritative bill. Unknown model/rate is declared absent (`null` + a reason), never guessed or
silently zeroed; dry-runs invent no spend. The rates live in
[`src/pricing.ts`](src/pricing.ts) as **operator-editable, dated estimates**. The E2B desktop
rate is still a `placeholder` stand-in; update the numbers and the `asOf` date when providers
change pricing. On models that bill prompt-cache writes and long-context requests at their own
rates (OpenAI's 5.6 family), the estimate prices both exactly from the trace's per-request
usage ledger.

**Choosing the model.** Computer-use lanes default to `gpt-5.6-sol` (the 5.6-generation
flagship; `gpt-5.6` is OpenAI's alias for the same model). Configure it per lab with
`actors[0].model`. Any id in the rate table prices cleanly (`gpt-5.6-terra` and
`gpt-5.6-luna` are the cheaper tiers; `gpt-5.5` stays priced for pinned labs). A run with a
spend cap (`execution.caps`) refuses an unpriced model at preflight, so add a dated rate to
`src/pricing.ts` before capping a model the table does not know.

**Fail-closed spend cap.** Set `execution.caps.maxUsd` on a computer-use lab to abort a session
the moment its running estimated spend crosses the cap, a runaway-retry guard that mirrors the
terminal lane's `scenario.caps.maxUsd`. It is a **per-lane** cap: enforced inside each lane's loop,
so an N-lane fan-out can spend up to N × `maxUsd` before any lane aborts (the run bundle warns with
the true ~N × cap ceiling; a shared run-level budget is future work). A lane that did real work then
hits its cap passes (`budget_reached`); a zero-action runaway that crosses it fails (`gave_up`).
Absent = uncapped (the historical CUA behavior); `maxUsd: 0` = no-spend. A cap on a model
`src/pricing.ts` cannot price is refused at preflight (`HUMANISH_CUA_LAB_UNPRICED_CAP`)
rather than run uncapped: an unenforceable cap is more dangerous than none, so add a rate
or drop the cap.

**Failed-lane reruns.** Multi-lane CUA fan-out can be rerun surgically without mutating
the source run:

```bash
npx humanish lab run cua-browser --rerun-failed-from latest --json --no-open
npx humanish lab run cua-browser --rerun-failed-from <run-id> --lanes lane-02,lane-04
```

This creates a new linked run containing only the failed/blocked/timed-out/hollow lanes
(or the explicit `--lanes` selection). The new `run.json` records `rerun.sourceRunId`,
selected lane ids, and previous lane statuses; the source run's verdict is left unchanged.
This is intentionally not automatic retry; a passing rerun is evidence of a
nondeterminism candidate and does not license erasing the original red lane.

**Run-owned cleanup.** Live providers can record resource evidence in `run.json`.
Stored bundle IDs are mutable evidence and do not authorize provider mutation. The
cleanup command writes a durable inspection receipt until Humanish has a
verified resource-lease contract. Resources already recorded as killed become
`already_clean`; recorded live or unknown resources become `failed`, which
makes cleanup and verification fail closed:

```bash
npx humanish cleanup --run latest
npx humanish verify --run latest
```

Humanish does not enumerate or bulk-delete provider accounts from this command.
Same-process teardown uses trusted in-memory provider handles. The separate OSS
orphan sweep is maintainer-only, opt-in, and verifies provider metadata before
calling provider cleanup.

Trust note: `serve` commands run inside the disposable sandbox with the declared
subject env provisioned, the same trust class as a repo's package.json scripts.
Only run lab configs you trust, and declare only the env names that the subject
genuinely needs. (Since 0.5.0, a clone × e2b-desktop lab whose actor is a
registered computer-use actor routes here and requires `serve`; on earlier
versions that shape routed to the meta lab.)

#### Adapters: drive a local app via its JS state contract (no E2B, no vision)

The computer-use loop is provider- and substrate-agnostic. You can point a lab at an
**already-running local dev server** (`subject.source: local-app`) and drive it
through its in-process JS contract (`window.app.getState()` etc.) with a custom
`CuaExecutor` (screenshot optional, `appState` as the progress signal) paired with a
**non-vision** `CuaProvider` (`requiresFrame` falsey), keeping personas, the
Observer, the evidence bundle, redaction, and the friction loop, with **no E2B
desktop and no clone**. Supply `cuaHooks.buildExecutor` + `buildProvider` to
`runLab` (a config-only run with no hooks fails closed with a structured error). See
[State-driven executor](docs/architecture/state-driven-executor.md).

## Browser Scenario Manifests

`humanish run --app-url http://127.0.0.1:<port>` looks for executable browser
steps in committed `humanish/scenarios/*.yaml`. If none are present, Humanish
falls back to the built-in two-step browser persona proof. Browser steps are
public-safe source, so use synthetic fixture values and committed relative app
paths only.

```yaml
schema: humanish.scenario.v1
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
`.humanish/runs/<run>/traces/` and summarized in the Observer.

## Maintainer OSS Meta-Lab Example

This repository includes a contract-only authorized-repo dogfood lab:

```bash
pnpm humanish -- watch oss
pnpm humanish -- lab run oss --dry-run --repos CorentinTh/it-tools,drawdb-io/drawdb,maciekt07/TodoApp,lissy93/dashy
```

Default lab targets are intentionally app/tool-like repos with visible,
locally runnable user surfaces. Avoid libraries and frameworks for public
dogfood unless the scenario is explicitly testing developer experience.

The bundled manifest defaults to dry-run and creates contract evidence without
cloning repos, launching a provider sandbox, or forwarding credentials. Use:

```bash
pnpm humanish -- lab run oss --dry-run --json --no-open
```

Live OSS meta-lab execution is unavailable until repository-derived instructions
have an isolated credential boundary. A live manifest fails closed with
`HUMANISH_OSS_META_LIVE_ISOLATION_REQUIRED` before callbacks, filesystem writes,
network access, or provider launch.

The `oss` lab accepts GitHub `owner/repo` slugs. A CLI `--repos` override redacts
repo labels in durable artifacts by default; pass `--no-redact-repos` only for a
public-safe selection. Dry-run does not access or clone repositories and does
not need or use private-repository credentials. Private-repository execution
remains unavailable while the live lane is disabled. Local bundles remain
ignored under `.humanish/`; do not publish private screenshots, logs, or
upstream details.

## Development

```bash
pnpm install
pnpm check
pnpm public-surface:scan
pnpm pack:dry-run
```

Local dogfood:

```bash
pnpm humanish:watch
pnpm humanish:verify
pnpm humanish:feedback
pnpm humanish:lab:list
```

## Docs

Start with the current safety and capability state. Dated design documents may
preserve historical mechanisms and carry explicit amendments near the top.

- [Current safety state and goals](docs/goals/current.md)
- [Ramp for future contributors and agents](docs/ramp/README.md)
- [Project layout](docs/architecture/project-layout.md)
- [Observer architecture](docs/architecture/observer.md)
- [Serve: the run library surface](docs/architecture/serve.md)
- [Actor contract (first-party registry and extension direction)](docs/architecture/actor-contract.md)
- [State-driven executor (drive a local app, no E2B/vision)](docs/architecture/state-driven-executor.md)
- [OSS lab design record (historical; see its current safety amendment)](docs/architecture/oss-lab-poc.md)
- [Feedback contract](docs/contracts/feedback.md)
- [Open-source install experience](docs/product/open-source-install-experience.md)
- [Three roles: researcher, stakeholder, participant](docs/principles/three-roles.md)
- [Self-driving harness principles](docs/principles/self-driving-harness.md)
- [World-class open-source v0 roadmap](docs/roadmap/world-class-open-source-v0.md)
- [Open-source release readiness](docs/release/open-source-readiness.md)
- [Public readiness standard](docs/release/public-readiness-standard.md)

## Release Status

The package is published on npm. Every future publication remains a human
release action: do not run `npm publish` or create a release tag unless the
maintainer explicitly approves it in the current context.
