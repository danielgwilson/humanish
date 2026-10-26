# Changelog

Newest first. Each entry is the opening paragraph of that version's release notes; the link holds
the full notes. Versions not listed here (0.1.1 through 0.65.0 except 0.20.0, and 0.81.0) are
tagged without notes.

The Unreleased section holds the full notes for the next version until it is tagged.

## Unreleased

### Added

- A library `ComputerUseProvider` can set `batchFailure: "halt"`: after a desktop command fails,
  the loop sends none of that batch's later actions and acknowledges each as `not_dispatched`.
- A `ComputerUseTurn` can carry `rejectedProposal: { reason }` for a proposal the provider could
  not map to an action. The loop runs the turn's actions, acknowledges the proposal's position as
  `not_dispatched`, gives the participant the reason and continues the session.
- A `ComputerUseTurn` can report `interruption: "refused"` with an optional `refusalCategory`. The
  session stops with stop cause `provider_refused_prompt`, keeps the reply's usage and records the
  category in its notice.
- A trace's `conversation.explicitReason` can be `stateless_api`, for a provider whose API keeps
  no conversation between requests. Such a run gives no zero-data-retention warning.
- `ComputerUseAction` has six more desktop actions, run on E2B, Modal and local VM desktops through
  the shared X11 translator: `triple_click`, `mouse_down` and `mouse_up` (a button, at the pointer
  or a point), `hold_keys` (a chord held for up to 30 seconds), `read_pointer`, and `zoom` (a fresh
  capture cropped to a region at the desktop's own pixels). The OpenAI provider never proposes
  them, so its requests are unchanged.
- `ComputerUseExecutor.execute` may resolve with a result, `{ kind: "pointer", x, y }` for
  `read_pointer` or `{ kind: "frame", screenshot }` for `zoom`. The loop passes it to the provider
  in that action's acknowledgement (`previousExecution.actions[i].result`). An executor that
  returns nothing is unchanged.
- Keypresses and held keys accept the X keysym names a model writing xdotool syntax sends:
  `Prior`, `Next`, `KP_Enter`, `KP_0` to `KP_9`, the keypad operators, `ISO_Left_Tab`, the sided
  modifiers (`Control_L`, `Shift_R` and the rest) and punctuation keysym names such as `minus`. The
  keypad's navigation names (`KP_Home`, `KP_Page_Down` and the rest) press the main keys. Before,
  each of these was rejected before dispatch.
- `createAnthropicMessagesProvider` builds a computer-use participant on Claude through the
  Anthropic Messages API and Claude's `computer_toolset_20260801`, on `claude-haiku-5-5` at effort
  `medium` with a 16,000-token output limit by default. A library caller passes it to
  `runComputerUseLoop`, and a study reaches it with `actor.type: computer-use` (below). All 17 of Claude's computer actions run,
  `zoom` and `cursor_position` answered from what the desktop read, and a desktop over 2,000 px a
  side is refused.
- `claude-haiku-5-5` has a rate: $0.10 input, $0.01 cache read, $0.125 cache write and $0.50
  output per 1M tokens, 5x each for a request over 100,000 prompt tokens.
- A `ComputerUseProvider` can set `requireReportedUsageForSpendCap: true`. Every session with a
  declared cap (`maxUsd` or a study budget) then runs as with the loop option of that name: a
  request that stalls or fails without a reply stops the session with `stopCause:
  "usage_unreported"` instead of being booked at a worst case and sent again. The Anthropic
  provider sets it, since that worst case cannot bound a request priced by prompt-size tiers.
- A `ComputerUseTurn` can carry `notices`, which the trace records as warnings. A trace's
  `conversation.requests[]` can carry `clearedInputTokens`, the input the provider's server-side
  context editing cleared.
- `actor.type: local-agent` participants can propose every desktop action, including the six
  above. Codex's `humanish_ui` tool schema and Claude Code's reply shape both come from one
  schema. A `read_pointer` position comes back as text: in Codex's acknowledgment, and in Claude
  Code's next message. A `zoom` crop comes back as an image enlarged to fit the screenshot, as
  for Claude through the Anthropic provider: in Codex's tool result as `zoomImages`, and to Claude
  Code as an image file in its folder, which it opens with Read.
- A computer-use participant's zooms and pointer reads are run evidence. The image a zoom gave the
  participant is kept as `screenshots/zoom-NNN` beside the turn screenshots, at the desktop's own
  pixels, and referenced from the zoom's `ui_action` with the zoomed `region`. It follows every
  screenshot rule: blurred under `policies.redactScreenshots`, lossless WebP otherwise, listed in
  the stream's screenshots and checked by `humanish verify`. A pointer read's `ui_action` records
  `pointer`, the position it read. The Observer shows a zoom's image on its activity row, and
  analysis offers it as a capture the analyst can cite.
- `actor.type: computer-use` runs each participant on the vendor of its `actor.model`:
  `claude-haiku-5-5` on Anthropic with `ANTHROPIC_API_KEY`, the `gpt-*` models on OpenAI with
  `OPENAI_API_KEY`, and `gpt-6.1-sol` when the study names no model. It runs on E2B and Modal
  desktops, in local and remote runs, and in a local browser. `actor.provider` names the vendor of
  a model humanish does not list yet; that model runs unpriced, so a spend cap is refused.
- A `computer-use` study is refused when it is read, before a run id exists, for a model
  humanish does not list and no `actor.provider`, an `actor.provider` that disagrees with the
  listed model, and a Claude participant's desktop over 2,000 px a side or 4,784 visual tokens.
- `humanish keys` lists `ANTHROPIC_API_KEY`, `doctor --study` reports it for a study whose
  participants run on Anthropic, and a live run without it is refused before it starts with
  `humanish keys set anthropic`. A remote run on E2B keeps it in E2B's egress proxy, added to
  requests for `api.anthropic.com` as `x-api-key`; a Modal runner receives it as an environment
  variable.

### Changed

- A Claude Code participant's reply uses the same action fields as Codex's tool: a scroll gives
  `dx` and `dy`, and a field may be omitted or null when unused. A proposal that does not match
  its action's fields is refused before any input, with the reason in the participant's next
  message, and the actions before it run. Before, it was dropped without a word.
- Every `ComputerUseProvider` now receives `previousExecution` on each request after a turn that
  acted, with one acknowledgement per batch position. Before, only providers with
  `requestPolicy: "fail_closed"` received it. The OpenAI provider ignores it, so its requests are
  unchanged.
- An OpenAI participant whose reply body is lost while it is read, after the request reached
  OpenAI, now has its usage marked incomplete and the request handled as lost in transit, as a
  dropped connection already was. Before, that request's usage went missing without a mark.
- The default provider fetch passes response headers through, so a live OpenAI participant
  waits for a 429 or 5xx reply's `Retry-After` hint, up to 60 s, before it retries.
- E2B, Modal and local VM desktops translate computer-use actions through one shared X11
  translator (`src/substrates/x11/`). Each sends the same native commands as before. The exported
  `E2BDesktopSandbox` type no longer declares the SDK's mouse and keyboard methods (`leftClick`,
  `moveMouse`, `scroll`, `write`, `press`, `drag` and the other clicks), since humanish sends input
  as xdotool commands; code that called them through this type should call the `@e2b/desktop`
  Sandbox directly.
- A participant is given a zoom's image enlarged to fit its screenshot, with the aspect ratio kept
  (bilinear), as Claude's computer-use toolset documents for `zoom`. This covers Claude through
  the Anthropic provider and Codex and Claude Code on the local-agent route. Before, each got the
  crop at the desktop's own pixels, which Claude Haiku 5.5 found too small to read, and local
  agents enlarged the page with Ctrl+= instead. The run bundle keeps the crop at desktop pixels.
- Analysis instructions say a zoom capture is the participant's closer look at a region and not a
  full screen. The added paragraph raises each analysis request's input by about 145 tokens.
- `openai-computer-use` refuses a model the participant model table puts on another vendor, such
  as `claude-haiku-5-5`, and names `actor.type: computer-use`. Before, a capped study naming it
  passed every check, since the model has a rate, and failed on its first request. Any other model
  id still goes to OpenAI.
- An effort level a listed participant model does not accept is refused when the study is read,
  for `actor.reasoningEffort` and for each `participants[].reasoningEffort`, on
  `openai-computer-use` too: `none` on the default `gpt-6.1-sol` no longer starts a run that fails
  on its first turn. A model humanish does not list is checked against its vendor's levels only.
- `actor.maxOutputTokens` and `actor.serviceTier` apply to `computer-use` as to
  `openai-computer-use`. `serviceTier: fast` still needs a Fast mode rate, which only OpenAI
  models have.

### Fixed

- An OpenAI participant whose reply could not be written to `HUMANISH_CUA_WIRE_CAPTURE_DIR` keeps
  that reply's usage, for participant turns and closing requests. The trace records a "wire capture
  not written" warning. Before, the write error was raised as a provider failure and the billed
  reply's usage went unrecorded.

## 0.148.0: Participants run gpt-6.1-sol (2026-10-26)

humanish 0.148.0 runs a computer-use participant on `gpt-6.1-sol` at medium effort when its study
names no `actor.model`, in place of `gpt-5.6-sol`. On the Taskly benchmark its analyses found as
many planted defects, its participants cost about a third as much ($0.071 against $0.216 median),
and its steps were no slower. Studies that set `actor.model` are unchanged, and the terminal
route's Codex participant keeps `gpt-5.6-sol`.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.148.0)

## 0.147.0: Screenshots take half the space (2026-10-25)

humanish 0.147.0 keeps a computer-use participant's screenshots as lossless WebP, 0.47 to 0.55 of
the PNG size with the same pixels, and `verify`, study analysis and export read them; earlier
humanish versions refuse a bundle with WebP screenshots. `actor.serviceTier: fast` runs OpenAI
computer-use participants in Fast mode. On the Taskly benchmark a Fast mode step took 14% less
time at 2.15 times the participant cost, and each request is priced at the tier that served it.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.147.0)

## 0.146.0: Studies start and finish sooner (2026-10-23)

humanish 0.146.0 cuts the wait around a hosted study. A Chrome participant starts once its page
has loaded, in place of a fixed 8 s sleep, and a remote run sets up its runner and returns its
evidence faster; on a one-participant study, desktop to session start fell from about 29 s to 11
to 18 s, and a remote run's overhead from 17.8 s to about 10 s. An analysis request that runs out
of output is sent again once within its cost cap, and a low- or medium-effort analysis asks for an
output limit sized to its participants, so a runaway request stops sooner.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.146.0)

## 0.145.0: A remote runner's keys stay in E2B's proxy (2026-10-22)

humanish 0.145.0 keeps the OpenAI, Gemini and E2B keys out of a remote E2B runner's environment.
E2B's egress proxy adds each key to the runner's requests on its fixed host, and the runner holds
placeholders; code in the runner can still read the keys back through the E2B API, and a Modal
runner still receives them as environment variables. Study analysis with `gpt-6-luna` sends low
text verbosity, which made it about four times faster on the benchmark recordings, and an
observation of what a participant said may now also cite the capture they spoke about.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.145.0)

## 0.144.0: Hosted studies run remotely by default (2026-10-22)

humanish 0.144.0 runs a hosted computer-use study remotely by default. A study on
`e2b-desktop` or `modal-desktop` with a public `app-url` runs its own process in a sandbox in your
E2B or Modal account, so it keeps going when this machine sleeps; the command follows it, serves
the live Observer here and copies the evidence back. Before the runner starts, the command names
the keys it sends. Pass `--local` for one run, or set `execution.remote: false` in a study, to keep
it on this machine.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.144.0)

## 0.143.0: Analysis costs about one seventh as much: gpt-6.1-sol at medium effort is the default (2026-10-22)

humanish 0.143.0 analyzes studies with `gpt-6.1-sol` at medium reasoning effort by default, in
place of `gpt-6-astra` at high. On the same recordings it found what `gpt-6-astra` found, invented
nothing, and cost about one seventh as much: $0.06 against $0.41 per analysis on the Taskly
benchmark. A study can set the analysis effort with `review.analysis.reasoningEffort`, and one
that names its model keeps it at high effort with an unchanged configuration hash.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.143.0)

## 0.142.0: Remote runs, Gemini and GPT-6 analysis models, and a view-only live stream (2026-10-21)

humanish 0.142.0 can run a study remotely: `humanish run <study> --remote` puts the study's own
process in a sandbox, so a long study keeps going after this machine sleeps, and `observe --run
<id>` reconnects to it. Study analysis can run on `gpt-6.1-sol` and `gpt-6-luna` as well as the
default `gpt-6-astra`, and on Google's Gemini API with `humanish keys set gemini`. A hosted
desktop's live stream is now view-only on the VNC server itself: before, anyone holding a
participant's stream URL could type into that desktop.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.142.0)

## 0.141.0: A run says when it is writing findings, and email links no longer open a dialog (2026-10-21)

humanish 0.141.0 says when a run is writing its findings: the CLI prints progress with the
elapsed time, `humanish runs` and the TUI show `analyzing`, and the Observer's Findings tab shows a
pending state from the moment analysis starts. A run cut off before it publishes is recorded as
interrupted, `reclaim` marks a dead run, a killed analysis no longer blocks the next one, and
`run` prints the run id as soon as it exists. On hosted and local desktops, a `mailto:`, `tel:`
or `sms:` link no longer opens an app chooser or a browser prompt that participants reported as an
app fault: humanish records the link and tells the participant that nothing was sent.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.141.0)

## 0.140.0: One local study can test phone, tablet and desktop, and every run ends with findings (2026-10-21)

humanish 0.140.0 lets a local browser study give each participant its own device. One study with
`mobile`, `tablet` and `desktop` participants runs them side by side on your machine, with mobile
emulation for the phone, as hosted desktops already did; `humanish runtime setup` installs the new
local runtime. A study with a Codex participant is now analyzed by the same Codex account on every
target, so a run ends with findings without an OpenAI key; the default OpenAI analysis cap is $10;
a skipped analysis names the command that runs it; and `run --json` carries the findings.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.140.0)

## 0.139.1: Hosted Codex participants work with an AGENTS.md in the Codex home (2026-10-21)

humanish 0.139.1 fixes hosted Codex participants for operators whose Codex home
(`CODEX_HOME`, or `~/.codex`) holds an `AGENTS.md`. Codex adds that file to every thread, and
humanish refused the launch as `codex_unsafe_configuration` with no reason. humanish now admits
that file, leaves it unchanged, and says the participant also received it. Every other
`codex_unsafe_configuration` refusal names the setting it refused.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.139.1)

## 0.139.0: Computer-use studies can run on Modal desktops (2026-10-19)

humanish 0.139.0 can run a computer-use study's desktops on Modal. Set
`execution.target: modal-desktop` on an `app-url` study and each participant gets its own Modal
sandbox running the same desktop the E2B route uses: Xvfb, XFCE, xdotool input, screenshots, a
live noVNC stream, Chromium and recordings. The same study file runs on E2B or Modal
with only the target changed. Clone and local-tree subjects, shared worlds, E2B templates and
camera or speech media stay on E2B.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.139.0)

## 0.138.0: A terminal study can run on Modal (2026-10-19)

humanish 0.138.0 can run a terminal study's shell on Modal as well as E2B. Set
`execution.target: modal-terminal` and `execution.runtimeAuth: openai-env`, sign in with
`modal token new`, and install the optional `modal` package beside humanish. The sandbox runs as a
non-root user with sudo, as on E2B, lives up to Modal's 24 hours, is journaled and reclaimed by id
like an E2B sandbox, and is priced at Modal's sandbox rate. Desktop studies still run on E2B or a
local VM.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.138.0)

## 0.137.0: Each browser participant can record its requests (2026-10-16)

humanish 0.137.0 can record the requests each hosted browser participant makes. With
`execution.network: true`, a computer-use participant in Chrome or Chromium writes
`network/<participant id>.ndjson`: one line per request hop with its turn, method, origin and
path, status, duration, and whether it failed or was still open. A 500 on add-to-cart or a list
call that never returns now sits next to the turn that started it. The file holds no headers,
cookies, bodies or query strings, verify checks every record against the contract, and capture is
off unless a study turns it on.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.137.0)

## 0.136.1: The emulation log no longer holds page addresses (2026-10-16)

humanish 0.136.1 keeps page addresses out of a mobile-emulated participant's emulation log. The
log held the full address of each tab the emulation holder reloaded or attached to, query string
and fragment included, and run.json keeps up to 50 of its lines. A one-time code or token in a URL
the participant opened could reach a `share_ready` bundle, since verify's text scan does not read a
short query value as a secret. The log now names the tab's target id and the commands sent.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.136.1)

## 0.136.0: verify takes less than half the time on large runs (2026-10-14)

humanish 0.136.0 makes `humanish verify` take less than half the time on large runs. It checks a
run folder for links 32 entries at a time and inflates screenshots on Node's thread pool, 1 MiB of
rows at a time, and still runs every check it ran before. On a run folder of 15,000 entries verify
took 3.3 seconds where it took 7.7, and on a run with 3,000 real screenshots 4.2 seconds where it
took 10.3. A computer-use participant that repeats a base64- or percent-encoded key from its
instructions no longer makes the run `blocked`. `humanish analyze` names the participant and the
event id when two run events share an id, and reports `ANALYSIS_SOURCE_INVALID` where it reported
`ANALYSIS_UNAVAILABLE`. The bundle estimate counts participants' instructions and task goals with
the mission, `init` prints three next steps in 24 lines, and reading a run refuses a conversation
without its requests list.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.136.0)

## 0.135.0: Encoded keys in a study's own text stay out of the run (2026-10-14)

humanish 0.135.0 keeps a base64- or percent-encoded key in a study's own text out of the copies of
that text the run records. The run redacted keys as written, and verify also decodes those
encodings, so a study whose title, mission, instructions, persona or scripted scenario held an
encoded key produced a run graded `blocked`. A participant that repeats such a key in its own words
still does (#1892). `actor.model`, `subject.envValues` and the analysis question now refuse such a
value before anything runs, which a study that ran before may now meet. verify's per-file scan also
finds a key behind an HTML reference and a JSON escape. The Observer page and its live feed carry
each participant's items on their own, so `humanish observe` writes the page of a run whose traces
together pass V8's longest string: on a synthetic run of 25 participants with 30 MiB traces it
exits 0 where it exited 2.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.135.0)

## 0.134.0: Participants held to an end keep reloading until it (2026-10-14)

humanish 0.134.0 keeps a participant held to a scheduled end running when it reloads a page that
changes only on reload. 20 reloads in a row on an unchanged screen ended its session as `gave_up`.
Now humanish watches the screen after each further reload, as after a wait, so a participant that
reloads every few seconds costs about what one that waits costs. In 60-minute live runs with a
persona that refreshes every few seconds, 0.133.1 ended 3 of 4 within 7 minutes; this release ran
all 4 to their end at a median $3.23 an hour. Trace files are now written as compact JSON, about a
quarter smaller, and a run whose trace still passes the 32 MiB read limit finishes and grades
`local_only` where it failed.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.134.0)

## 0.133.1: Hosted runs keep writing run.json past 512 MiB of traces (2026-10-14)

humanish 0.133.1 keeps a hosted run writing run.json once its finished participants' traces
together pass V8's longest string, 536,870,888 characters. The sandbox id scrub serialized the whole
bundle into one string on every write, so past that size every write threw and run.json, the trace
files, review.json and events.ndjson stopped updating. It now scrubs the bundle and each participant
apart and writes the same bytes. On synthetic runs at a recorded hosted run's density, a snapshot
write of 10 participants of 10 MiB took 3.8 seconds where it took 4.7, at half the peak memory.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.133.1)

## 0.133.0: An OpenAI participant names how long it waits (2026-10-14)

humanish 0.133.0 lets an OpenAI computer-use participant name how long it waits, with a
`wait_minutes` tool, and cuts what a participant costs while nothing on its screen changes. A turn of
only waits is watched, and each further quiet wait in a row lasts twice as long, starting from the
length the participant named, up to 10 minutes. In live 60-minute runs against 0.132.0, median model
spend per participant-hour fell 13% on a resident portal, 52% on a support queue, 46% on an issue
list that shows new issues only on reload, and 78% on a dispatch board, and all 6 participants on
the issue list reloaded and reported every new issue. verify and analysis also no longer fail on a
run whose traces together pass 512 MiB.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.133.0)

## 0.132.0: An OpenAI participant's closing report reads the prompt cache (2026-10-13)

humanish 0.132.0 cuts the cost of an OpenAI computer-use participant's closing report. The closing
report and impressions requests set `text.format`, which is part of the prompt cache's prefix, so
each one was billed as a fresh write of the whole session: 25% to 42% of a run's model spend in the
8 runs measured on 0.131.0. They now send the schema in their input instead and read the session
from the cache. In two live 12-minute runs the closing request cost $0.026 and $0.025 where it
would have cost $0.14. A reply that does not match the schema is asked once more with the strict
schema, after the same budget and time checks.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.132.0)

## 0.131.1: Hosted desktops keep their screens on while participants wait (2026-10-13)

humanish 0.131.1 keeps a hosted desktop's screen on while a participant waits without input.
About 1 in 8 stock E2B desktops started with a screen saver that turned the screen black after 5
minutes, and a participant then spent its turns keeping the screen awake: one live hour cost
$17.70 where its pair cost $2.03. humanish now turns the screen saver off once the participant's
browser or terminal has opened. The refusal of an out-of-range `actor.maxWaitMs` also now says the
field caps a turn of only waits.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.131.1)

## 0.131.0: Participants that wait watch the screen and wake when it changes (2026-10-13)

humanish 0.131.0 watches the screen while a computer-use or shared-world participant waits. A
turn of only waits sends no wait to the desktop: humanish looks every `idleWaitMs` and asks the
model for the next turn when a change holds still, speech is heard, a condition matches, the
participant's end arrives or the wait's time passes, and idle turns in a row grow toward
`actor.maxWaitMs`. A clock, a spinner or a "2 minutes ago" label ends no wait. In a live hour on a
support queue, new rows reached the participant a median of 7 seconds after they appeared, against
30 seconds on 0.129.0, and an OpenAI participant made 50 requests where 0.129.0 made 43. Codex
and Claude Code waits last the length they ask for, up to 10 minutes. This is a minor release with
breaking changes: `idleWaitMs` now sets the time between looks, `actor.maxWaitMs` defaults to 10
minutes for idle turns and accepts up to an hour, and a turn of only waits sends no `wait` action
to a library caller's executor. The migration table says how to keep the old pacing.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.131.0)

## 0.130.0: Analysis reads traces up to 32 MiB one at a time and names what it refused; the bundle estimate counts the mission (2026-10-13)

humanish 0.130.0 lets analysis read long runs that 0.129.0 refused. Analysis reads each
participant's trace up to 32 MiB, as verify and the Observer do, one trace at a time, and keeps of
each only what selection can use. `humanish analyze` names the file it refused and why. The bundle
estimate counts the study's mission in run.json, so its run.json warning can fire. This is a minor
release because a run.json past 16 MiB is now refused as `ANALYSIS_SOURCE_TOO_LARGE` where it was
`ANALYSIS_SOURCE_UNAVAILABLE`.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.130.0)

## 0.129.0: Analysis reads long runs past 100,000 items; traces past 32 MiB get their own advice; shared-world skips counted apart (2026-10-13)

humanish 0.129.0 fixes three things long studies reach. Analysis no longer refuses a run by how
many events, trace items or screenshot frames it holds; it still reads each file only up to 16
MiB. A trace or live file past 32 MiB, the most the trace loader reads, is refused with advice
that fits, a running participant whose live file passes 32 MiB keeps the items the Observer page
already shows, and the Observer server reads run.json under that limit. Shared-world runs count a
participant skipped before its session apart from those that used the app, and no longer count a
skip as overlap. This is a minor release because a shared-world `skippedReason` is now a sentence
where it was `handoff-timeout` or `host-ended-before-handoff`.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.129.0)

## 0.128.0: Run bundle v4 keeps per-request lists in trace files; the study budget is checked before each request (2026-10-13)

humanish 0.128.0 keeps run.json small in long studies. Run bundles are now
`humanish.run-bundle.v4`: each participant's per-request lists (`tokenUsage.turns`,
`conversation.requests` and `providerRequests`) are only in its trace file, and run.json keeps the
totals. A synthetic run of 30 participants making 2,880 requests each wrote run.json at 93 to 106
KB, where 0.127.1 wrote 16.1, 27.2 and 41.8 MB; analysis reads run.json only up to 16 MiB. This
release reads v1 to v4 bundles, and `loadRunBundle` joins the lists back. 0.127.1 and earlier fail
verify on a v4 run. A computer-use participant now checks the study budget before each model
request, so one whose sibling crossed `caps.maxTotalUsd` no longer sends one more request.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.128.0)

## 0.127.1: Clock-end closing reports declare their outcome; skipped participants named as skipped (2026-10-13)

humanish 0.127.1 fixes two things the 0.127.0 release smoke found in scheduled studies. An OpenAI
participant asked for its closing report at a scheduled end or session cap now says how the task
went in a structured `outcome` field, so one that reached its goal counts in `reachedGoal` where
0.127.0 counted it in `ranUntilEnd`. A participant the run skips before its session starts now
shows its skip reason on its run line, and the summary counts it apart from those that took
part.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.127.1)

## 0.127.0: Clock-end passes counted by what participants declared, a scaled wind-down, the concurrency cap in the plan (2026-10-13)

humanish 0.127.0 makes long scheduled studies report what happened. A participant that passes at
its scheduled end or session cap without declaring `REACHED THE GOAL.` is now counted as running
until that end (`participants.ranUntilEnd`), where 0.126.0 counted it as reaching the goal. The
default wind-down is a quarter of the window, at most 10 minutes, so a short window is no longer
told its end from its first turn. `HUMANISH_CUA_MAX_CONCURRENCY` now lowers the plan itself, on
shared-world studies too, and a participant whose scheduled end passes while it waits for a slot
is skipped before its desktop is created. The Observer keeps updating past 100,000 items for a
participant, and the bundle estimate is re-derived for run bundle v3.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.127.0)

## 0.126.0: Per-participant time zones, session caps and desktop files, page paths, a lighter live Observer (2026-10-13)

humanish 0.126.0 adds per-participant settings for long, mixed studies and a lighter live Observer.
Each participant can have its own time zone (`participants[].clock`), which now also sets its
hosted browser, its desktop's panel clock and a `desktop-cli` terminal; an existing
`actor.clock.timeZone` sets them too. `participants[].maxSessionMs` lets a participant end its
session sooner and stops one still working at the cap with a closing report.
`participants[].files` puts files on a participant's desktop for upload dialogs, and each
computer-use turn records the page it was on (origin and path only). A closing report that opens
"REACHED THE GOAL." no longer fails its run over the page copy it paraphrases. The served Observer's
live feed sends only new items each poll: about 90 KB per poll through a synthetic 8-hour,
24-participant run, where 0.125.0 sent up to 69.5 MB. Offsets and miscased zone names are now
refused, and so is a zone on the local browser runtime.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.126.0)

## 0.125.0: Run bundle v3 with live items in append-only files, loadRunBundle, faster repeated verify (2026-10-12)

humanish 0.125.0 keeps each live flush of a long study small, exports the run bundle loader, and
verifies a finished study faster. Run bundles are now `humanish.run-bundle.v3`: a running
participant's items so far live in an append-only file under `live/`, and each flush appends only
the items recorded since the last one. On a synthetic run of 24 participants working 8 hours, a
flush wrote about 0.23 MB in about 0.24 s, where 0.124.0 wrote up to 120 MB in 3.0 s. A finished
v3 bundle differs from v2 only in its schema name; 0.124.0 and earlier refuse it by name.
`loadRunBundle(cwd, run)` returns run.json with every trace and live file joined and checked, for
v1, v2 and v3 bundles. The five verifies of a finished study read each screenshot once: 10 s in
all for 1,203 screenshots, down from 35 s. A key in a study's title is redacted from the bundle,
and one in a persona id or desktop template fails at parse instead of blocking the run.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.125.0)

## 0.124.0: Small Observer files for long studies, faster verify, closing reports under zero data retention (2026-10-12)

humanish 0.124.0 keeps a long study's Observer files small, checks screenshots about eight times
faster, and asks an `openai-computer-use` participant for its closing report at a scheduled end
under zero data retention. `observer/observer-data.json` is now `humanish.observer-data.v2`: the
run and each participant without their trace items and screenshot entries, which the Observer
page carries compressed. On a synthetic run of 24 participants working 8 hours, observer-data.json
fell from 155 MiB to 0.33 MiB and index.html from 94 MiB to 16 MiB, so verify reads both. A
reader of observer-data.json that needs a participant's items reads the run's traces. verify of a
synthetic 8-hour run with 8,895 real-size screenshots took 51 s, down from 282 s.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.124.0)

## 0.123.0: Run bundle v2 writes each trace once, bundle size estimate (2026-10-12)

humanish 0.123.0 writes each participant's trace once, outside run.json, so long studies stay
within the bundle's size limits, and estimates a study's bundle before it runs. Run bundles are now
`humanish.run-bundle.v2`: a participant's trace items live only in its trace file
(`actor.json`, `actors/<stream>.json` or `actor-<surface>.json`), and run.json indexes each one by
path, size and sha256. On a synthetic 8-participant, 1,000-turn run, run.json fell from 17 MB to
74 KB. Every reader loads traces through one loader that checks the index and refuses a missing,
altered or shared trace; a refused trace shows as evidence unavailable, and an unfinished run
grades `local_only`. Bundles from earlier versions still load unchanged; npm 0.122.0 and earlier
refuse a v2 bundle by name. `study check` and `run` estimate the bundle's size and file count and
warn before any sandbox is created when it may pass the analysis or verify limit, and the
public-safety scan's file limit grows with the number of participants.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.123.0)

## 0.122.0: Participants end on the clock, a harness error ends only its participant (2026-10-12)

humanish 0.122.0 lets a participant end at a scheduled time and keeps one participant's harness
error from stopping the rest of a study. `participants[].endAfterMs`, on the same clock as
`startAfterMs`, ends a participant's session at that time with stop cause `scheduled_end`,
counted as reaching the goal; from `endAfterMs - windDownMs` (10 minutes by default) each turn
tells the participant the end time and the minutes left, its turns that only wait no longer count
toward the idle limits before then, and its sandbox is sized from its own window. `actor.clock {
timeZone }` adds the local time to each turn, and `participants[].idleWaitMs` sets one
participant's wait length, so staff on a long shift can check the screen less often than patients.
A participant's harness error now ends only that participant: the study-wide fail-fast is removed,
and every later participant starts on its schedule.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.122.0)

## 0.121.0: One failed desktop fails alone, host sleep named as the cause (2026-10-10)

humanish 0.121.0 keeps one participant's failed desktop from costing a whole hosted study, and
names a host that slept mid-run as the likely cause of the failures after it. A computer-use study
on an `app-url` subject no longer holds its participants behind the first one's desktop, and a
participant that fails before its session no longer stops the participants queued behind it; a
study whose subject is built in each sandbox still lets one participant set it up first, and the
next one takes over when the first never got a desktop. When the machine running a study sleeps,
the run records the suspension as a `host.suspended` event, and the run outcome, `humanish run`,
the review and the `--json` result say the failures of participants running through it are
likely its effect, while each participant's record keeps its own error. The review's participant
line lists interruption causes in a fixed order.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.121.0)

## 0.120.1: Analysis requests under Bun run past 5 minutes (2026-10-09)

humanish 0.120.1 lets an analysis request from a Bun process run longer than 5 minutes. Under Bun,
`undici` is Bun's built-in module, whose `fetch` ignores the analysis provider's dispatcher and
ended each request after 300 seconds, so an analysis whose model took longer, as a 34-participant
run's cohort requests did at 325 to 405 seconds, failed with `analysis_provider_network_error`.
The provider now passes `timeout: false`, which Bun reads and Node's undici ignores, and the
request's own `timeoutMs` ends it under either runtime. A `TimeoutError` from `fetch` is recorded
as `provider_client_timeout`.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.120.1)

## 0.120.0: Analysis completes under Bun, runs past 16 participants print a bounded list, Observer counts participants by status (2026-10-09)

humanish 0.120.0 completes an analysis run from a Bun process, prints a run of more than 16
participants in a bounded number of lines, and counts and filters the Observer's participants by
status and persona. Under Bun, `undici` is Bun's built-in module, whose `Agent` has no `destroy()`,
and the analysis provider's teardown after each request threw a `TypeError` that replaced the
request's result, so every automatic analysis from a Bun process ended `unknown` with
`AUTOMATIC_ANALYSIS_OUTCOME_UNKNOWN` and kept no receipt. A failing teardown is now ignored.
`humanish watch` and `humanish run` print a computer-use run of more than 16 participants as one
line counting them by status, up to 16 participants that did not pass, and a `not listed:` line.
Each participant line holds its closing message on one line cut at 160 characters, and a warning
printed the same for each participant prints once. The Observer's participant grid counts the
participants by status when they ended more than one way, and pressing a count filters the grid.
Its view options gain a Persona filter, a filter change returns to the first page, and Next page
and Previous page open the new page at its first participant.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.120.0)

## 0.119.0: Participants arrive over time, one analysis past 16 participants in cohorts, late starts skipped past the budget, study warnings redacted (2026-10-09)

humanish 0.119.0 lets a computer-use or shared-world study start its participants over time, and
analyses a run of 17 to 100 participants in one report. `participants[].startAfterMs` starts a
participant up to 24 hours after the run starts its participants, and a `count` group's
`startEveryMs` spreads its members. Each participant's desktop is created at its start, the plan and
`study check` print the first and last start and the most participants at once, and run.json records
each participant's `arrival`. A participant whose start comes after the study crossed
`caps.maxTotalUsd` is skipped before its desktop is created. The analysis of more than 16
participants splits them into cohorts of at most 16, analyses each cohort with its own request, and
merges the cohort reports into the run's one report with one more request; 0.118.0 skipped the
automatic analysis of such a run. Admission, the plan's analysis line, `study check` and the
`analyze --dry-run` worst case count every request, and `analyze --json` gives their number as
`admission.requests`. At the default $3 cap the analysis of 17 or more participants is refused even
with no evidence, so it needs a higher `review.analysis.maxCostUsd`. A provisioned shared world gets
an app sandbox that lives until the last start or wave can end. A study warning recorded in the
run's bundle is redacted as a run failure is, so a hosted study whose participant instruction names
a sandbox URL other than the subject's verifies `share_ready` again, as on 0.111.2.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.119.0)

## 0.118.0: Up to 100 participants, E2B concurrent sandboxes, study check plans like run, analysis range (2026-10-09)

humanish 0.118.0 lets a computer-use study have up to 100 participants, up from 16, holds a
shared-world study to the same 100, and runs them within the number of sandboxes the E2B plan runs
at once. The new setting `HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES` gives that number (20 when unset,
E2B Hobby's limit; Pro runs 100). A study with more participants than that runs them in waves, an
`execution.concurrency` above it is refused before any sandbox is created, and `doctor` shows it. A
live run of more than 16 participants records its automatic analysis as skipped with
`AUTOMATIC_ANALYSIS_PARTICIPANT_LIMIT`, because one analysis reads at most 16 participants. `study
check` now plans a study the way `humanish run` does and fails a study the run refuses, and a
shared-world or scripted clone study whose sandbox deadline passes the ceiling is refused at plan
time. The analysis line that `run`, `study check` and the TUI print ends its expected range at the
largest run admission admits (`$0.75 to $2.83` for one participant at the default $3 cap, where it
read `$3.79`) and states the rule as admission applies it. An in-process `local-app` run records
`subject.source: local-app`, a desktop-cli dry run names its product, and `verify` names an unlisted
folder and the 10,000-entry stop in their own sentences. In `humanish tui`, the key legend says what
Enter and Esc do while an action is armed, a study's median cost includes its analyses, and Esc
after entering a key returns to the screen the keys were opened from.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.118.0)

## 0.117.0: Long participant waits, OpenAI wait length, serve.build fails fast, TUI confirmations (2026-10-09)

humanish 0.117.0 lets a participant wait through a long hosted study, gives an OpenAI
participant's wait a usable length, and fails a broken `serve.build` within seconds. A
participant's wait longer than one desktop call now lasts as long as it asked, up to the new study
field `actor.maxWaitMs` (1 second to 10 minutes; 2 minutes by default, 30 seconds on a desktop with
speech), and goes to the desktop in steps of at most 30 seconds. A Codex participant's longer wait
was cut to 30 seconds before. An `openai-computer-use` participant's `wait` names no duration and
lasted half a second on a hosted desktop; it now lasts `actor.idleWaitMs` (5 seconds by default) in
a turn that only waits, and 500 ms after an action in the same turn. The participant's `actor.json`
records these lengths as `waitSettings`. A `serve.install`, `serve.build` or seed step that bash
cannot parse fails within seconds with bash's error, where the run waited out the step's limit (10
minutes for `serve.build`), and a failed `serve.build` on the computer-use route has its own error
code. In `humanish tui`, a two-Enter confirmation ends when the cursor leaves it. The terminal
route's check after its sandbox kill carries the run's E2B key, and browser Back in the Observer
clears a stale saved-moment message.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.117.0)

## 0.116.0: Hosted keyboard input, E2B sandbox ceiling, bounded run reads, run header, TUI live starts (2026-10-09)

humanish 0.116.0 delivers a hosted participant's arrow keys and punctuation, lets the operator
raise the E2B sandbox lifetime, and reads run files within size limits. On hosted E2B desktops,
`ARROWDOWN`, Page Up, Page Down, `?`, `/` and other names missing from `@e2b/desktop`'s key table
reached xdotool unchanged, which ignored them while the run recorded the keypress as completed;
both desktops now translate key names through one table and refuse a name outside it.
`HUMANISH_E2B_MAX_SANDBOX_MINUTES` sets the longest sandbox lifetime the planners allow, 60 minutes
when unset and up to 1440 on E2B's Pro plan. A refusal names the value that admits the study, and
`humanish doctor` shows the ceiling. A route's sandbox kill, and the kills, checks and listings of
`humanish reclaim`, carry the run's E2B key. `verify` reads at most 32 MiB of a run file and lists
a larger file, or a run past 10,000 entries, as unscanned, and every contained read tells a missing
file from one it refused. A run whose analysis did not complete reads `live run finished; the
analysis did not complete`, a run refused before it was created prints no `analysis:` line, and a
`desktop-cli` run names its product on the `subject:` line and in run.json. In `humanish tui`, the
cursor follows the selected row through a refresh, a live start of a `mode: dry-run` file says
`needs mode: live`, Run again on a live run asks for a second Enter, the confirm prompt restates
the study's cost, and `c` lists every provider key. `NO_UPDATE_NOTIFIER` turns the update check
off.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.116.0)

## 0.115.0: Closing report limits, admitted analysis cost, concurrent reviewer notes, known-value scrub (2026-10-08)

humanish 0.115.0 asks the OpenAI computer-use participant for its closing report and impressions
within the limits its reply is checked against, keeps every reviewer note added at the same time,
and finds more encoded forms of a registered secret. The participant's request schema now carries
the limits the parser already enforced: a summary of up to 4,000 characters, up to 8 friction
reports of up to 2,000 characters and up to 6 impressions of up to 500 characters, so a longer
reply is no longer requested and then dropped. `analyze --json` adds `admission.admittedCostUsd`,
the smallest `--max-cost` that admits the analysis, and `humanish analyze` names its refusal
command as `npx humanish analyze` where humanish is a dev dependency. A reviewer note is created
under its own name, so notes added together from the Observer and `humanish notes --add` are all
kept. `export --local-only` keeps a `blocked` run `blocked` when its analysis fails the export's
own check. The known-value scrub exempts only the markers humanish writes, reads text in the same
five ways as `verify`, and finds a value that overlaps itself in time linear in the text. The TUI's
study screen shows the expected analysis cost line that `study check` prints, telemetry reads
`CI=false` as off, and `humanish keys set constructor` is refused with the list of provider keys.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.115.0)

## 0.114.0: Reviewer notes, expected analysis cost, percent-encoded UTF-8 in verify (2026-10-08)

humanish 0.114.0 lets a reviewer note a moment of a recorded run, admits post-run analysis on its
expected cost, and reads percent escapes as UTF-8 when it checks a run for secrets. Pause the study
timeline in an Observer served on 127.0.0.1 and choose "Add a note at 02:31", or run
`humanish notes <run> --add --at 02:31 "text"`. Each note is saved as its own file under `notes/`
in the run directory, marked on the study timeline and listed under "Reviewer notes" in Findings,
and `verify`, HTML export and feedback drafts read it. Analysis admission now prices input at 3
bytes per token and output at 12,000 tokens plus 1,000 per participant, and runs an analysis when
that expected cost plus 10% is within the cap, so the default $3 cap no longer refuses analyses
billed at $1 to $2. A refusal names the expected cost, the worst case, the cap and the
`humanish analyze --max-cost` command that admits it, and `study check` and live starts give the
expected cost range for the study's participant count. In `analyze --json`,
`admission.estimatedCostUsd` is now the expected cost. OpenAI computer-use traces list the
impressions request in `conversation.requests` with `kind: impressions`. `verify` and bundle
export also read percent escapes as UTF-8, so a percent-encoded password that starts with a
non-ASCII letter grades its run blocked, and the known-value scrub finds a percent-encoded value
with non-ASCII characters. The scrub also checks its matches against redaction markers by binary
search, so 1 MiB of markers and values takes well under a second instead of about 5 s.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.114.0)

## 0.113.0: Participant impressions, mission and persona warnings, local desktop capacity, key status, update notice (2026-10-07)

humanish 0.113.0 asks computer-use participants what they thought at the end of a session, warns
when a study scripts its participants, and says how many local desktops fit. An OpenAI or Codex
participant ends with up to six first-person impressions: what looked unclear, unfinished or
untrustworthy, what they liked, what they expected and did not find, and where the screen differs
from how they do the same task in their own work or life. The trace keeps them as `impressions`,
the Observer shows them under "What they said at the end", and analyses at prompt
`study-evidence-8` can cite them. `study check` and `run` warn when a mission reads like a list of
UI steps or a participant's persona has no background, and the starter personas `init` writes now
lead with a background, which changes their participant prompt. `runtime status` and
`doctor --study` report how many participant desktops the local runtime holds, and a live local
study that needs more than a Mac's humanish VM holds is refused before any desktop starts.
`humanish keys` lists each provider key with its source and never its value, and humanish says at
most once a day, at a terminal, when a newer version is out. Live shared-world output and older
terminal and scripted runs use plain participant captions.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.113.0)

## 0.112.0: Plain finding headlines, design findings, plain captions, DO_NOT_TRACK for terminal participants (2026-10-07)

humanish 0.112.0 writes findings and captions for someone who did not watch the session, and
terminal participants send `DO_NOT_TRACK=1` by default. Each analysis finding leads with a plain
headline and an account of what the person tried, what got in their way and how it seemed to feel;
its title, summary and observations stay underneath as the evidence. Analyses also report design
findings: problems a product designer would notice in the captures, each with a severity and at
least one cited capture. `review --json` carries them as `analysis.designFindings`, and the
analysis prompt is `study-evidence-7`. Participant captions name the person, such as "Lobby host,
phone", and every route's run summary says how many participants took part and how many reached
the goal. Terminal participant and product setup commands run with `DO_NOT_TRACK=1`; set
`execution.terminal.doNotTrack: false` to study a product's telemetry. `humanish runs` and the
Observer now read a run with no outcome and a running simulation as interrupted, as the TUI,
`stats` and `verify` already did. The `--env-file` and `cleanup` aliases are removed in the first
minor release on or after 2026-11-03.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.112.0)

## 0.111.4: Encoded known values scrubbed, scripted traces scrubbed, a live command after a dry run (2026-10-06)

humanish 0.111.4 scrubs a run's known values from more of its evidence and fixes three messages.
Every route now also finds a known value, such as a provider key or a `subject.env` value, in its
encoded forms: percent-encoded, JSON-escaped, base64, base64url and hex, and where a terminal color
code or an output chunk boundary splits it. A scripted run scrubs its known values from the step
trace in `traces/<surface>.json` and `actor-<surface>.json`, and from the app URL, scenario goal,
title and step labels it records. Two places keep a known value: a scenario file name, and the
path of a computer-use `subject.appUrl`. `humanish review` on a dry run names the command that
starts a live run, so `next` in `review --json` holds a string where it held null. A terminal
refusal for a missing runtime key no longer reads `runtimeAuth "undefined"`, and a refusal that
names two signed-in coding agents reads "report".

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.111.4)

## 0.111.3: Shared-world feedback candidates, scripted E2B key scrubbed, subject sandbox warnings (2026-10-06)

humanish 0.111.3 gives shared-world runs feedback candidates and repairs seven places where one
route's warnings, refusals, secret scrubbing or run directory checks differed from the other
routes'. A shared-world participant who reports friction or gives up becomes a candidate that
`humanish feedback` drafts, and each candidate from a run with several participants shows that
participant's own instructions as `expected`. A scripted run scrubs the value of `E2B_API_KEY` from
the errors and subject setup output it records, and writes `[REDACTED_SECRET]` where it wrote
`[redacted]`. A shared-world study with `caps.maxUsd` and no `caps.maxTotalUsd` warns that the cap
applies to each participant. The subject sandbox of a scripted clone study or a provisioned
shared-world study warns when its create was retried or E2B reports no size. A scripted clone study
missing a `subject.env` value, and a provisioned shared-world study missing `OPENAI_API_KEY`,
refuse with the wording computer use gives. Computer-use and shared-world runs check the run
directory again after a `prepareDesktop` hook and an Observer render.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.111.3)

## 0.111.2: A taller Observer frame, even grid cards, a notice when the server stops (2026-10-06)

humanish 0.111.2 changes the Observer and nothing else. The focus view's heading line holds the
Back button, the participant pager, the name, the status and the inspector toggle, and the assigned
task and participant background move into the Details tab, so the frame at 1600x1000 is 171 px
taller. Every grid card has a 44 px caption, so phone-sized and desktop cards in one row end at the
same height. An open Observer page whose server stopped shows one notice with the run id and two
ways back to the recording, where 0.111.1 showed "Frame unavailable" on every tile. The CLI, the
library and the study routes are the same as in 0.111.1.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.111.2)

## 0.111.1: E2B URLs in study URLs, fan-out dry runs verify, zero-data-retention cache holds (2026-10-06)

humanish 0.111.1 fixes a study URL refusal and two verify problems that an adopter met on 0.111.0,
and the input cost of long computer-use sessions on zero-data-retention OpenAI organizations. A
study URL may carry an E2B app URL in a query parameter or fragment, which 0.110.2 through 0.111.0
refused as a credential. A computer-use dry run with more than one participant against an E2B app
URL verifies `share_ready`, and verify finds a hex-encoded secret or E2B URL after `=`. On a
zero-data-retention organization, a participant past about 64,000 tokens of carried conversation
keeps the provider's prompt cache, and an OpenAI 404 for a stored item switches it to carrying its
own conversation where 0.111.0 stopped it. A Codex participant's wait over 30 seconds is shortened
to 30 seconds, a terminal session past 512 KiB of output keeps its verdict, and `humanish doctor`
in a terminal study's sandbox reports the egress placeholder as no key. `execution.egressAllow` on
a route other than `terminal` now warns, and 0.112.0 refuses it there.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.111.1)

## 0.111.0: StudyConfig has the keys of a v3 study file (2026-10-05)

humanish 0.111.0 is the first breaking release under the compatibility policy. It breaks library
callers that read or build a `StudyConfig`, the type `parseStudy` returns and `runStudy` takes:
the type now has the keys of a `humanish.study.v3` file, such as `actor`, `route`,
`participants`, `caps` and `mode`, where it had `actors[0]`, `execution.caps` and
`scenario.mode`. The release notes carry the migration table. `runStudy` refuses a config that
still sets a 0.110 field with `HUMANISH_STUDY_V2_UNSUPPORTED`, so a budget left in
`execution.caps` cannot run uncapped. Study files and CLI commands are unchanged, except two JSON
outputs: `humanish study show --json` prints the v3 config, and `humanish study check --json`
names a participant's target `participants[<i>].target`. The `--env-file` and `cleanup` aliases
still work and are removed in 0.112.0, on or after 2026-11-03.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.111.0)

## 0.110.4: Scripted runs reclaim clean, review says interrupted, Chrome under a long TMPDIR (2026-10-05)

humanish 0.110.4 fixes four findings of the 0.110.3 live smoke. `humanish reclaim --check` reports
a live scripted run against an `app-url` subject `clean`, with reason `no-sandbox`, and exits 0.
`humanish review` on a computer-use run stopped by Ctrl-C after its desktop started says the run
was interrupted. A run that failed before any participant started no longer prints "Participants
finished; preparing analysis…". The scripted route launches Chrome when `TMPDIR` is too long for
Chrome's socket path. Planner refusals for a library config built without `parseStudy` name v3
keys, and so does `humanish migrate` when one of those checks refuses a v2 file. Inside, a v3
parser runs beside `parseStudy`, src reads the study through accessors, and `humanish migrate`
reads v2 files through its own front end; the library API is unchanged.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.110.4)

## 0.110.3: Ctrl-C at the watch prompt, review says analysis is off, E2B docs links kept (2026-10-05)

humanish 0.110.3 runs the `watch` and `observe` shutdown, and prints `watch stopped` or `observe
stopped`, when a Ctrl-C lands right at their prompt. It starts no automatic analysis for a run a
signal interrupted. `humanish review` says when a study's `review.analysis: false` is why a live
run has no findings. `humanish verify` no longer blocks a run whose text holds a URL followed by an
escaped line break and an `E2B_` variable, and redacted output keeps the E2B docs link that E2B's
401 names. The `--env-file` alias is now removed in 0.112.0. Inside, the computer-use, scripted,
terminal and shared-world routes run through one shell, `admitRoute` in `src/run/route-shell.ts`;
the live smoke ran each route on it.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.110.3)

## 0.110.2: Credential URLs refused, terminal key proxied, watch exits for agents (2026-10-05)

humanish 0.110.2 refuses a study URL that carries a user name, password or credential parameter,
and `humanish verify` catches all 41 secret formats its test lists, where 0.110.1 caught 13. A
terminal study that declares no `execution.runtimeAuth` keeps the OpenAI key in E2B's host-side
proxy rule (`openai-egress`) and gives Codex a placeholder. No Observer server hands out
`sandbox-receipts.ndjson` or `status.json`, and a Ctrl-C during desktop startup no longer writes
the raw sandbox id outside `sandbox-receipts.ndjson`. For a coding agent, `watch` and `observe`
print the Observer path and exit when nobody is at a terminal, a rerun of `init` rewrites only its
own `AGENTS.md` section, and suggested commands use one invocation style.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.110.2)

## 0.110.1: Claude participants restricted, sandboxes reclaimed by tag (2026-10-04)

humanish 0.110.1 starts a Claude Code participant with Read as its only tool, in a scratch folder,
with a short environment allowlist and no saved transcript, and needs Claude Code 2.1.248 or newer.
A Ctrl-C in the first seconds of a live run no longer leaves a sandbox running: every sandbox
carries the run's tags, and the signal handler and `humanish reclaim` kill what E2B lists under
them. `reclaim` reports `clean`, `unconfirmed` or `unknown`, and `humanish cleanup` is now a
deprecated alias of `reclaim --check`. run.json records how a run ended, every surface shows a
failed run as failed, and `review`, `analyze show` and a live run's last lines print the analysis
findings as text.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.110.1)

## 0.110.0: --dotenv, and sandbox ids only in receipts (2026-10-03)

humanish 0.110.0 renames `--env-file` to `--dotenv`, so a missing file reaches humanish's exit 2
result where Node exited 9 first. `--env-file` stays as a hidden alias until 0.111.0. Raw sandbox
ids live only in a run's `sandbox-receipts.ndjson`: every other record, output and export copy names
a sandbox as `[redacted-sandbox-id]` with a digest, and `humanish verify` grades a run that still
holds a raw id `local_only` with `RAW_SANDBOX_ID`. The release notes list each changed field and
what to read instead.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.110.0)

## 0.109.1: Current option names in messages, reclaim --env-file (2026-10-03)

humanish 0.109.1 is a patch. Library refusals and warnings name `RunStudyOptions`, which 0.109.0
exports, where they named the removed `RunLabOptions`. `humanish export --format bundle` no longer
copies sandbox ids into its redacted workspace. `humanish reclaim` takes `--env-file`, and
`humanish migrate` removes a `labs/` directory that its moves emptied.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.109.1)

## 0.109.0: Lab names removed, v2 study files refused (2026-10-03)

humanish 0.109.0 removes what 0.108.0 deprecated. A `humanish.lab.v2` file, or any study file in a
`labs/` directory, is refused with the command that fixes it: `humanish migrate` converts and moves
v2 files, and a v3 file in `labs/` moves to the matching `studies/` directory. The `lab` commands,
`--lab`, `serve` and `watch --run` are unknown to the CLI. The library drops its 0.107 names:
`runLab`, `parseLabConfig`, the `Lab*` types and the `Cua*` names. Run records and telemetry name
the study as `study` only, a study's result has `studyId` only, and bare `--json`, scorer contexts
and computer-use `error.name` use study and `ComputerUse` names. The release notes list each removal
and what to change.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.109.0)

## 0.108.0: Studies, one runner and one viewer, errors on stderr (2026-10-03)

humanish 0.108.0 renames labs to studies. A study file is `humanish.study.v3` under
`humanish/studies/`, and `humanish migrate` converts a `humanish.lab.v2` file, which still runs with
a warning until 0.109.0. The commands follow: `humanish study list`, `study show` and `study check`,
and `--study` in place of `--lab`. `humanish run <study>` is the one runner and `humanish observe`
the one viewer: `lab run`, `serve` and `watch --run` are hidden aliases that warn, and `--sims`,
`--lanes` and `watch --follow` are gone. Error codes and route results name the study and the
route: `HUMANISH_LAB_*` is `HUMANISH_STUDY_*`, and every route's result is
`humanish.study-result.v1`. Human-mode errors print on stderr in one shape, and `--json` output
keeps its shape. The release notes list each rename and what to change.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.108.0)

## 0.107.0: A 44-name library API, --count and --participants (2026-10-02)

humanish 0.107.0 removes the library surfaces 0.106.0 deprecated, so the entry point exports 44
names, down from 83. `runLab(config, options)` is the one way to run a lab: the route runners, the
`RunLabOptions` hook bags, `LabOutcome.backend`, the `routesTo*` predicates and `rerun.laneIds` are
gone, and a JavaScript caller that still passes a removed option is refused before anything runs.
The release notes map each removed name to its replacement. On the CLI, `--count` replaces
`--sims` and `--participants` replaces `--lanes`; the old flags work with a warning until 0.108.0.
A scripted `press` step sends its key. A signalled live run records itself as interrupted and
kills its sandboxes. Restricted Codex launches check the release's app-server schema before they
start, and a terminal lab with no declared model runs on `gpt-5.6-sol` and prices its tokens.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.107.0)

## 0.106.1: Codex CLI 0.160.0 and reclaim in E2B debug mode (2026-10-01)

Codex participants, Codex-account analysis and `humanish doctor` admit Codex CLI 0.160.0 (published
to npm 2026-10-01) on Linux x64, which 0.106.0 refused. Doctor's recovery for an unadmitted release
suggests `npm install -g @openai/codex@0.160.0`. `humanish reclaim` refuses to run with
`E2B_DEBUG=true`, where the E2B SDK reports kills it never sent, and a run's sandbox teardown in
debug mode reads unconfirmed.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.106.1)

## 0.106.0: Node 22.19, a smaller library API and stricter share safety (2026-10-01)

humanish needs Node 22.19.0 or later. The library entry point exports 83 names, down from 377:
`runLab` runs a lab, and the release notes list the 300 removed names and how to migrate. Sequential
shared-world studies, the OSS meta-lab, `run --actor` and `run --app-url` are removed, so a
shared-world lab with `execution.concurrency: 1` fails at parse. Local Codex participants run only
on the Codex CLI releases admitted for their host, and `humanish doctor` names the release it found.
`humanish verify` judges share safety by file contents. It finds secrets in base64, hex and escaped
text, and it grades a run that holds an image or archive it cannot account for `local_only`.
`serve --safe` re-verifies a run whose files changed before serving it.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.106.0)

## 0.105.0: Rich participant backgrounds (2026-09-28)

Personas now support a multiline `background` for relevant history, habits, motivations and constraints. It preserves paragraphs up to 32 KiB and rejects oversized context instead of silently truncating it. Missing files, unsupported fields and shortened legacy fields now produce diagnostics.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.105.0)

## 0.104.3: SMTP capture for local app studies (2026-09-28)

`humanish comms catch --smtp-port 1025` now supports SMTP verification mail for apps hosted by the study operator. The command previously rejected its documented SMTP option. It now validates the port and fails startup if SMTP cannot bind, instead of leaving misleading healthy HTTP status.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.104.3)

## 0.104.2: Preserve desktop capture timestamps (2026-09-28)

Desktop recordings now preserve the capture input’s microsecond timestamps and explicitly use variable-frame-rate output across local and E2B FFmpeg versions. This avoids dropping closely spaced captured frames or filling genuine gaps with duplicates. Existing recordings are unchanged.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.104.2)

## 0.104.1: Recording startup (2026-09-28)

Mixed desktop recording no longer waits behind the recording mix's default
two-second PulseAudio buffer. Its null sink now uses the supported no-rewind mode,
which bounds that buffer to 50 ms. FFmpeg settings, timestamps, startup ordering
and resource ownership are unchanged; screen-only recording uses the same path
as before.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.104.1)

## 0.104.0: Local captured inboxes (2026-09-28)

Local browser participants can now create an account, open their assigned inbox
and follow a verification link without mailbox-provider credentials. Start
`humanish comms catch`, configure the app to send email to that catch, and declare
`comms.email.external.catchBaseUrl` in the local lab. Doctor checks the catch's
recipient routes and explains setup failures before a participant starts.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.104.0)

## 0.103.2: Adjacent ending evidence for analysis (2026-09-28)

A participant can inspect a result and then scroll or navigate before ending.
Analysis now prioritizes the preceding screenshot alongside the final view,
after beginning and explicit failure context. Previously, session sampling
could omit that nearby result while retaining a final heading or navigation page.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.103.2)

## 0.103.1: Fairer analysis capture allocation (2026-09-27)

Analysis now gives reclaimed screenshot slots to eligible participants with
fewer admitted images. Previously, a participant whose images exceeded its
initial byte reservation could receive only its ending capture while other
participants received extra captures, even with enough image bytes remaining.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.103.1)

## 0.103.0: Optional desktop video and audio recording (2026-09-27)

Computer-use studies can retain an MP4 alongside screenshots, actions,
participant feedback and analysis:

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.103.0)

## 0.102.0: Optional participant camera and speech (2026-09-26)

Codex participants can listen and speak while using a conferencing app. The same
continuing conversation handles browser actions and spoken replies on local
Firecracker and hosted E2B desktops. No separate conversational agent or speech
API key is required. Codex inference still uses the selected remote account.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.102.0)

## 0.101.0: Shared Codex UI tools (2026-09-25)

Codex participants now interact through a native Humanish UI tool. One continuing
Codex conversation can call the tool repeatedly, inspect each new screenshot,
and give its final feedback. Humanish executes and records the inputs, including
rejected or skipped actions, before returning their actual status to Codex.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.101.0)

## 0.100.1: Participant conversation continuity (2026-09-25)

Local Codex participants now keep one conversation for their entire study,
including closing feedback. Previously, each screenshot started a new thread
with only eight turns of summarized history. Earlier observations, actions and
participant context now remain in the Codex conversation, with Codex managing
context compaction.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.100.1)

## 0.100.0: Local study setup and startup reliability (2026-09-25)

Configure a local browser study during setup:

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.100.0)

## 0.99.1: Recover from rejected browser input (2026-09-24)

A participant can now recover when the desktop explicitly rejects an action
before sending any input. For example, typing without an editable field focused
previously ended a local browser study with a harness error, even though the
browser remained usable.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.99.1)

## 0.99.0: Local browser studies on Apple Silicon Macs (2026-09-24)

Local browser studies now run on supported Apple Silicon Macs using Lima and ARM64 Firecracker desktops, with the same participants, Observer recordings and automatic analysis as Linux.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.99.0)

## 0.98.0: Local browser studies on Linux (2026-09-24)

Explicit local browser labs now run from the installed CLI and TUI. On Linux
x64 with Docker/KVM and a supported Codex ChatGPT login, isolated Firecracker
participants use the normal scheduler, recordings, Observer and automatic
analysis without E2B or OpenAI API keys. Codex inference remains remote and
consumes account quota; dollar cost is unknown.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.98.0)

## 0.97.0: Codex account reports on Linux (2026-09-23)

Saved studies can use an existing Codex ChatGPT login for their separate
findings report. Select it explicitly:

[Release notes](https://github.com/danielgwilson/humanish/blob/v0.97.0/docs/release/0.97.0-codex-account-analysis.md)

## 0.96.1: Preserve browser navigation (2026-09-20)

Hosted browser studies now measure physical client bounds with `xwininfo`.
The older `xdotool` build on hosted desktops can count window decorations twice,
incorrectly reporting that a visible browser extends beyond the captured screen.
That false reading could trigger fullscreen, hiding the tabs and address bar
participants use to move between an application and their study inbox.

[Release notes](https://github.com/danielgwilson/humanish/blob/v0.96.1/docs/release/0.96.1-browser-navigation.md)

## 0.96.0: Real email receiving (2026-09-21)

Browser studies can now receive real email through AgentMail, with a fresh inbox for each participant.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.96.0)

## 0.95.0: Connections setup (2026-09-20)

Open `humanish tui` and press **c** to configure AgentMail. **Add API key**
opens a hidden terminal prompt, then returns to Connections. Ctrl+C cancels
without changing the existing key or profile. Existing keys can be reused or
replaced. Entry uses the host's key store, outside the TUI rendering contract.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.95.0)

## 0.94.0: Reliability (2026-09-18)

Long analysis requests now honor Humanish's configured deadline instead of
ending early at the HTTP client's header timeout. The default deadline is ten
minutes. Omitted output settings use up to 32,768 tokens when the existing
declared budget admits that allowance, otherwise retaining 16,384. Explicit
output settings remain exact. This adds no retries or automatic budget increase.

[Release notes](https://github.com/danielgwilson/humanish/blob/v0.94.0/docs/release/0.94.0-reliability.md)

## 0.93.1: Observer review controls (2026-09-17)

Findings now starts with a compact overview: finding count, participants
included, analyzed outcomes, and sampled captures. The original narrative
remains under **Study summary**. Coverage notes, methodology and separate
automatic-attempt status are available under **Coverage & analysis details**.
A failed automatic attempt no longer replaces the status of a usable report.
Running or unknown execution, changed evidence, and exceeded admission limits
remain visible. Outcome counts are analysis judgments, not verified success
rates; stale reports do not use current recordings as their denominators.

[Release notes](https://github.com/danielgwilson/humanish/blob/v0.93.1/docs/release/0.93.1-observer-review-controls.md)

## 0.93.0: Global playback (2026-09-16)

The Observer uses one study clock across the participant grid and individual
recordings. Seek halfway through a study, open a participant, then scrub back:
returning to the grid shows every participant at that same time. Playback also
continues through ordinary participant navigation and browser Back/Forward.

[Release notes](https://github.com/danielgwilson/humanish/blob/v0.93.0/docs/release/0.93.0-global-playback.md)

## 0.92.0: Grid playback (2026-09-16)

Play and scrub all recorded participants together in the Observer grid.
The transport includes pause, playback speed and a shared recording timeline.
Opening a displayed capture lands on its exact frame; returning restores the
grid's time and participant page, paused.

[Release notes](https://github.com/danielgwilson/humanish/blob/v0.92.0/docs/release/0.92.0-grid-playback.md)

## 0.91.1: Study review polish (2026-09-15)

Study cost summaries include retained analysis attempts alongside participant
and desktop estimates. Reusing a saved analysis does not add another charge;
separate retries do. Missing prices and incomplete histories remain explicit.
The existing stats JSON fields keep their original participant-and-desktop
meaning; additive cost fields provide the combined retained estimate.

[Release notes](https://github.com/danielgwilson/humanish/blob/v0.91.1/docs/release/0.91.1-study-review-polish.md)

## 0.91.0: Analysis quality and defaults (2026-09-15)

Supported live studies now request analysis when the recording finishes, using
`gpt-6-astra` with high reasoning and a separate $3 admission estimate limit.
The CLI, preflight and TUI disclose that budget. Set `review.analysis: false` to
disable the extra request, or supply an analysis mapping with `maxCostUsd` to
customize it. The estimate is additional to participant and desktop costs and
is not a provider billing cap. Missing default credentials record a skip while
preserving a successful recording; explicit analysis failures remain failures.
Startup failures with no retained participant activity skip default analysis.

[Release notes](https://github.com/danielgwilson/humanish/blob/v0.91.0/docs/release/0.91.0-analysis-quality-and-defaults.md)

## 0.90.0: Findings after live studies (2026-09-14)

Labs can opt into independent analysis after their recording finishes with
`review.analysis.maxCostUsd`. The command waits for the result; the TUI and
Observer show analysis separately from participant execution and task outcomes.
Without the setting, run behavior stays unchanged.

[Release notes](https://github.com/danielgwilson/humanish/blob/v0.90.0/docs/release/0.90.0-automatic-analysis.md)

## 0.89.1: Finished analysis notice (2026-09-15)

Observer now labels a partial analysis result **“Analysis finished with
limitations.”** The previous notice described findings as covering evidence
“included so far,” which could make a finished analysis appear to be running.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.89.1)

## 0.89.0: Evidence-linked study findings (2026-09-14)

Completed studies can now produce ranked findings with links to the participant
events and captures that support them. Observer keeps Participants and Findings
inside the same study shell, with the recording grid, original participant
feedback and playback controls available throughout the review.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.89.0)

## 0.88.2: Sequential study model thresholds (2026-09-14)

Sequential shared-world studies now apply the model-spend thresholds they previously accepted without enforcing. The fix covers computer-use participants sharing a clone or local-tree subject with concurrency 1.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.88.2)

## 0.88.1: Completion evidence and a runnable local-app example (2026-09-12)

When a computer-use participant says it finished, Humanish now labels that completion as **participant-reported**. A recorded `stopWhen` match or completed dwell window identifies a **recorded completion condition**. Missing, malformed or conflicting detail is labeled unavailable; zero completions use **0/N recorded completions**.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.88.1)

## 0.88.0: See what ended a study (2026-09-11)

Computer-use studies now show a diagnostic category and recorded stop cause in CLI output. Fan-out results preserve each participant's ending, and newly generated review summaries use the same recorded causes. Successful dry-runs are identified as contract previews.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.88.0)

## 0.87.0: Participant endings and phone review (2026-09-10)

Humanish 0.87.0 makes participant endings easier to interpret and saved recordings easier to review on a phone.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.87.0)

## 0.86.1: Task preflight and saved recordings (2026-09-09)

Humanish now refuses a task protocol when the chosen execution path cannot run
it. Previously, a shared-world, terminal, scripted or synthetic lab could accept
`actors[0].tasks` and then omit those tasks during execution. Preflight now names
the unsupported field before creating a run or starting hooks, processes,
desktops or model requests. Remove `tasks` only when you intend a mission-only
study, or choose a supported per-lane computer-use route.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.86.1)

## 0.86.0: Participant assignments and exact action review (2026-09-09)

The Observer now shows each participant's assigned mission and lane focus.
Expand **Assigned task** in the player or participant details to read the
instructions. Computer-use runs also include their participant-facing task
goals. Hidden success checks and runtime access details stay outside this
assignment. Older recordings explicitly say when an assignment was not recorded.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.86.0)

## 0.85.1: Observer review continuity (2026-09-09)

The Observer review flow now carries the selected evidence between views:

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.85.1)

## 0.85.0: Watch and review complete screens (2026-09-09)

Observer now shows portrait and desktop captures at their original proportions,
with equal-height grid previews and a compact caption below each screen. Live
labels and controls leave the captured pixels clear. A stable Info button opens
participant details, labeled Pin/Compare actions and recorded notices.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.85.0)

## 0.84.1: Run feedback checks from exported evidence (2026-09-07)

Generated feedback commands now work from a standalone exported evidence workspace:

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.84.1)

## 0.84.0: Share evidence and keep readable originals (2026-09-07)

Keep readable local evidence and export a separate shareable workspace:

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.84.0)

## 0.83.2 (2026-09-07)

Concurrent computer-use studies now preserve declared reasoning effort, output-token limits and the shared actor-model budget. Host startup failures report their actual cause instead of a misleading handoff timeout. Linux browser profiles use system window decorations, with a measured fullscreen fallback for narrow desktops.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.83.2)

## 0.83.1 (2026-09-06)

Desktop CLI studies that leave product installation to the participant now prepare Node/npm before the terminal opens. Two fresh hosted desktops verified the runtime becomes available while the subject product remains uninstalled.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.83.1)

## 0.83.0 (2026-09-06)

Humanish 0.83.0 adds a per-response output limit and fixes three ways harness behavior could distort a computer-use study.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.83.0)

## 0.82.1 (2026-09-05)

Humanish 0.82.1 corrects computer-use sessions that were cut short by provider output limits. A response with no remaining actions no longer counts as successful completion when the provider explicitly says it is incomplete. Usage and partial text are preserved; actions and debrief are skipped.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.82.1)

## 0.82.0 (2026-09-05)

Humanish 0.82.0 makes repeated studies easier to reproduce and their evidence easier to interpret.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.82.0)

## 0.80.0 (2026-09-04)

v0.80.0 — the observation window on every desktop route, and a sandbox request that cannot exceed the cap

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.80.0)

## 0.79.0 (2026-09-04)

v0.79.0 — a study can hold and watch, and a participant can have a camera

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.79.0)

## 0.78.0 (2026-09-04)

v0.78.0 — the CLI no longer lingers after a run: @e2b/desktop 2.3.3, and doctor says which SDK you have

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.78.0)

## 0.77.0 (2026-09-04)

v0.77.0 — a phone participant's later tab is a phone tab too; a transient sandbox error is retried once

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.77.0)

## 0.76.0: A phone participant at a real 414 px viewport, with touch and a mobile user agent (2026-09-03)

v0.76.0 — a phone participant at a real 414 px viewport, with touch and a mobile user agent

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.76.0)

## 0.75.0: The task funnel measures every desktop, installs retry once, Sol priced at the live sheet (2026-09-03)

v0.75.0 — the task funnel measures every desktop, installs retry once, Sol priced at the live sheet

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.75.0)

## 0.74.0: Run and watch write the same bundle (2026-09-01)

`humanish run` renders observer/index.html after a successful run, the way
`watch` does, so the same lab produces the same bundle whichever command
ran it. A render failure is a warning on the result, never a failed run.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.74.0)

## 0.73.0: A run bundle exports (2026-09-01)

humanish export renders the Observer for a bundle that has none, which is
every bundle `run` writes, so the everyday command's bundles can be sent.
Found by the 0.72.0 release:dogfood participant on its first export.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.73.0)

## 0.72.0: The cold-start Claude path works again, and is measured (2026-09-01)

The one-shot Claude participant had been failing on turn one since its
prompt sat after --allowedTools; fixed with --, kept reachable as
HUMANISH_LOCAL_AGENT_ONE_SHOT=1 for measurement, session stays the default.
Receipt: no difference on the two-table starter lab, 3 of 3 each; on a
harder mission, session 4 of 4 against one-shot 0 of 4 in 300 s and 1 of 4
in 600 s.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.72.0)

## 0.71.0: A taken port is named, and a lingering process can be too (2026-09-01)

A port somebody already holds reports HUMANISH_PORT_IN_USE (serve:
HUMANISH_SERVE_PORT_IN_USE) with the port and whether another humanish
process holds it, instead of HUMANISH_UNEXPECTED. HUMANISH_DEBUG_HANDLES=1
prints Node's active resources after a command settles, for the run whose
CLI lingered sixteen minutes past its result.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.71.0)

## 0.70.0: An export says what verify said (2026-09-01)

humanish export writes verify's share status into the file it produces
(publicSafety.share, additive and optional on the frozen observer-data
schema), and the Observer's chip renders it, so a share_ready export no
longer reads local_only.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.70.0)

## 0.69.0: Export, the closing line, and reports that count as friction (2026-09-01)

`humanish export --run <id>` writes one self-contained Observer with
screenshots inlined, after verify and the share gate; --local-only
watermarks. Free-text computer-use participants label their own ending
(REACHED THE GOAL. / DID NOT REACH THE GOAL. / BLOCKED.) and the trace
records it; adherence 6 of 6 on the benchmark rerun, with recall and
precision unchanged (14 of 15, 0 invented). A finished participant's report
of defects or confusion now counts as friction and becomes a feedback
candidate. drawDB precision arm: 11 of 12 claims confirmed in source.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.69.0)

## 0.68.0: Stats, the participant's own word, and no person profile (2026-09-01)

`humanish stats` rolls up cost, outcomes, and durations across run history
with estimates labelled and unknown costs counted as unknown. A
schema-constrained participant declares reached / not_reached / blocked on
its final turn and the lane reads that before the closing paragraph
(verified live). "blocked" no longer reads as "blocked on an approval".
Every telemetry event asks for no person profile.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.68.0)

## 0.67.0: The scan stops refusing finished runs, and a hung turn is named (2026-09-01)

Five of five completed live runs were refused as "not a credible pass" on
sentences like "I could not read the full description"; the verdict scan
now strips perception verbs after "can't" and reads "encountered no ..." as
a negation. A hung provider turn is retried once and then ends the lane as
harness_error with its name on it; a hung wait is skipped with a notice.
Claude Code participants keep one session per run. The study-participant
telemetry marker is actually set.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.67.0)

## 0.66.0: The funnel tells us what a study was, and a refused lane stays refused (2026-09-01)

Telemetry now reports what a study was: mode, outcome, starter lab, brain
route, and our own error code, with ok meaning exit 0. Every event asks the
receiver not to derive a location, and the project discards client IPs.
1,359 study events before this release carried none of that.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.66.0)

## 0.20.0: External-public shared-world plane + CDP lobby-code handoff (2026-08-02)

Additive minor release. No breaking change to the provisioned-getHost path, its schema, or its verify
asserts (byte-stable; a snapshot regression pins it).

[Release notes](https://github.com/danielgwilson/humanish/blob/v0.20.0/docs/release/0.20.0-external-public-shared-world.md)
