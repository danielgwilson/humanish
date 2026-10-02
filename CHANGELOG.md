# Changelog

Newest first. Each entry is the opening paragraph of that version's release notes; the link holds
the full notes. Versions not listed here (0.1.1 through 0.65.0 except 0.20.0, and 0.81.0) are
tagged without notes.

The Unreleased section holds the full notes for the next version until it is tagged.

## Unreleased

### Deprecated

- `--sims` on `humanish run`, `humanish lab run` and `humanish watch`. Use `--count`, which
  `humanish run` now takes and `humanish watch` now applies without a lab. `--sims` is hidden
  from `--help`, sets the same count and prints one stderr warning naming `--count`; the next
  minor removes it. `--count` now also sets a preview lab's participant count, which only
  `--sims` did before.
- `--lanes` on `humanish lab run`. Use `--participants`, which takes the same comma-separated
  participant ids for `--rerun-failed-from`. `--lanes` is hidden from `--help`, selects the same
  participants and prints one stderr warning naming `--participants`; the next minor removes it.
- `CuaLoopOptions.onObservedUrl`, `onMessage` and `onScreenshot`, the lobby taps on
  `runComputerUseLoop`. Wrap the executor's `observe` and read `url` or `screenshot` from each
  observation, or wrap the provider's `nextTurn` and read `reasoning` and `message` from each
  turn. The options work as before and print no warning; the next minor removes them.
- `BrowserLabScoringContext.laneCount` and `.backend`, the scorer context on computer-use and
  shared-world runs. Read `participantCount` and `route` (`computer-use` or `shared-world`),
  which the context now carries. The older fields still carry the same facts, and the first
  read of each prints one `DeprecationWarning` with code
  `HUMANISH_SCORING_CONTEXT_FIELD_DEPRECATED`. The next minor removes them.

### Removed

- `RunLabOptions` no longer takes the route hook bags `cuaHooks`, `scriptedHooks`,
  `terminalHooks`, `sharedWorldHooks` and `automaticAnalysis` (#1353). Use the typed options:
  `scorer`, `createProvider`, `inProcess`, `prepareDesktop`, `env`, `onEvent`, `onStream` and
  `analysisSignal`. `docs/contracts/schemas.md`, "Library options", maps each bag field to its
  option. A JavaScript caller that still passes a bag gets `HUMANISH_LAB_OPTION_UNSUPPORTED`
  before anything runs, naming the options to use. `lab` and `scorerProvenance` are refused the
  same way; the humanish CLI sets them, and they had no deprecation warning.
- The route runners `runCuaActorLab`, `runScriptedBrowserLab`, `runTerminalProductLab` and
  `runConcurrentSharedWorld`, and their option types `RunCuaActorLabOptions`,
  `RunScriptedBrowserLabOptions`, `RunTerminalProductLabOptions` and
  `RunConcurrentSharedWorldLabOptions`. Use `runLab(config, options)` with the typed options;
  its result is `LabResult<route>`.
- The hook bag types `CuaActorLabHooks`, `ScriptedBrowserLabHooks`, `TerminalProductLabHooks`,
  `SharedWorldLabHooks`, `AutomaticAnalysisHooks` and `BrowserLabAdapterHooks`. Use the typed
  options; `AdapterScorerModule` is the scorer's type.
- `RunLabOptions.rerun.laneIds`, the older name of `rerun.participantIds` (#1405). Use
  `rerun.participantIds`. A JavaScript caller that still passes `laneIds` gets
  `HUMANISH_LAB_OPTION_UNSUPPORTED` before anything runs. The error code
  `HUMANISH_LAB_OPTION_CONFLICT`, which refused `laneIds` beside `participantIds`, and the warning
  code `HUMANISH_RUN_LAB_OPTION_DEPRECATED`, which only `laneIds` emitted, are gone.
- `LabOutcome.backend` and the `LabBackend` type (#1388). Narrow on `outcome.route` instead.
  The old names map to routes: `cua` is `computer-use`, `concurrent-shared-world` is `shared-world`,
  `synthetic` is `preview`, and `scripted` and `terminal` keep their names.
- `humanish lab preflight --json` no longer writes `backend` (#1388). This JSON field never
  carried a deprecation. Read `route`, which the same result has carried beside it since 0.106.0,
  with the mapping above. The check named `backend` is now named `route`, and the human output
  prints `route:` where it printed `backend:`.
- The `routesTo*` predicates and `selectLabBackend` (#1399). Use `routeOf(config)`, which
  returns the one route a lab runs on: `routesToComputerUse`, `routesToScriptedBrowser` and
  `routesToTerminalProduct` become a check for `"computer-use"`, `"scripted"` and `"terminal"`.
  `routesToSharedWorld` and `routesToConcurrentSharedWorld` become a check for `"shared-world"`.
  `routesToProvisionedSharedWorld` adds `subject.source` `clone` or `local-tree`, and
  `routesToExternalPublicSharedWorld` adds `subject.source` `app-url`. `selectLabBackend`
  returned the old names, which map to routes as above.
- The `HUMANISH_TERMINAL_AGENT_NOT_IMPLEMENTED` value of `TerminalProductLabResult.error.code`.
  No humanish release since 0.106.0 produces it; the terminal agent runs only inside the terminal
  route. Migration: delete any branch that matches it.

### Changed

- An analysis response that fails validation is kept locally for diagnosis (#1403) at
  `.humanish/analysis-diagnostics/<run>/<analysis>.json`. Known secret values are removed from every
  string, key and scalar, including their percent-encoded, escaped and base64 forms, then shape
  redaction runs. Each write keeps only the newest 20 records across runs. `humanish analyze` and a
  lab run's automatic analysis print the path, and the result carries it as `rejectedOutputPath`.
  The file is outside the run directory, so export, verify and the Observer never read it. The run's
  analysis record still keeps only the error code. Before, a failure such as
  `analysis_validation_failed_quote_invalid` left nothing that showed which quote failed.

- `humanish doctor --lab` checks a hosted Codex participant (a local-agent lab on an E2B desktop) by
  starting it as a run would, up to an ephemeral thread and without a turn (#1380): the release
  check, then `initialize`, `config/read`, `account/read` and `thread/start` with the operator's
  Codex configuration and the lab's declared model and reasoning effort. The row names the release,
  the model and whether Codex is signed in with a ChatGPT account or an API key, which bills its
  usage to that key; a failure gets the same recovery as the local participant row. Before, doctor
  reported only `codex login status` for hosted participants, so a refused release, configuration or
  model first showed up in the run. A Codex that reports signed out still gets the sign-in row.
- Three CLI messages use plain words (#1374). The dry-run summary prints `participants: N`
  in place of `sims: N`. The line before a live run reads "refused before it starts if its
  estimate is over $3; this is not a billing cap" in place of "separate $3 admission estimate limit
  (not a provider billing cap)", and doctor's analysis row says the same. Computer-use progress lines
  and the fan-out plan line start `humanish computer-use` in place of `humanish cua`; participant
  ids such as `lane-01` are unchanged.
- A live `run`, `lab run` or `watch` prints a `humanish keys:` line only for the provider keys its
  lab's plan reads (#1367): the model, desktop and runtime keys, the `subject.env` names, the
  variable `comms.email.external.authTokenEnv` names, `ANTHROPIC_API_KEY` for a Claude Code
  participant, and `OPENAI_API_KEY` when automatic analysis runs on OpenAI. A run with a declared
  scorer prints every key, since the scorer's code may read any. Discovery still fills every key it
  finds, from the same sources in the same order. Before, a `local-browser` run printed lines for
  `GH_TOKEN` and `AGENTMAIL_API_KEY`, which it never uses.
- The first SIGINT, SIGTERM or SIGHUP to `humanish run`, `lab run` or `watch` during a live run
  (outside post-run analysis) writes `status.json` `state: "interrupted"` with the signal (#1354).
  It then kills the E2B sandboxes the run's create-time receipts name, records them in
  `reclaim-receipt.json` as `humanish reclaim` does, closes a watch's Observer server and tunnel,
  and exits 128+n, all within 10 s. A second signal exits at once. The TUI's Stop shows the run as
  interrupted at once instead of after the stale window. Before, the process exited at once, its
  record read `running` until stale, and its sandboxes waited for `humanish reclaim` or their
  timeout. An older humanish reading the new state falls back to bundle liveness.
- `AdapterScorerModule<C>` takes the context its functions read as a type parameter, defaulting to
  the union of the browser and terminal contexts (#1357). `browserScorer` and `terminalScorer`
  pass a scorer written for one context as `RunLabOptions.scorer` without a cast (#1360): a
  scorer whose functions took `BrowserLabScoringContext` or `TerminalProductScoringContext` did
  not typecheck as `scorer` before. Inline scorers keep their contextual types.
- A local-browser lab (an app-url subject with `execution.target: local`) that has no local
  desktop now reports any planning refusal before `HUMANISH_CUA_LAB_LOCAL_DESKTOP_MISSING`: an
  invalid roster, a count above the cap, in-process fan-out, or `subject.topology: shared-world`.
  The count cap reads committed personas, so a malformed persona file can now throw first. runLab
  always gives such a lab its local desktop, so only a library caller using `inProcess` sees the
  change. The desktop check moved from planning to admission, so a local-browser lab can be planned
  without one (#1359).
- A scorer's warnings about a dropped output name `scorer.score`, `scorer.deriveFeedback` and
  `scorer.deriveArtifacts`. They named the removed `cuaHooks`, `sharedWorldHooks` and
  `terminalHooks` bags (#1362).
- Computer-use refusals about in-process runs name `RunLabOptions.inProcess` and
  `RunLabOptions.createProvider`. They named the removed `cuaHooks.buildExecutor` and
  `cuaHooks.buildProvider` (#1368). `runLab` no longer reaches
  `HUMANISH_CUA_LAB_EXECUTOR_NO_PROVIDER`: `inProcess` without `createProvider` gets
  `HUMANISH_LAB_OPTION_UNSUPPORTED` before planning, and the `cuaHooks.buildExecutor` path to it
  is refused like every bag field since #1353.
- `humanish lab run --help` says what `--participants`, formerly `--lanes`, takes: a
  participant's declared `actors[0].lanes[].id`, or `lane-01`, `lane-02`, … by position when the
  lab declares none (#1336).
- The parse warning for `actors[0].lanes[].entry` on a lab that is not shared-world says "the
  per-participant loopback entry" in place of "the per-role loopback entry" (#1397).

### Fixes

- Automatic analysis of a terminal run quotes the agent's own words (#1402). The terminal trace now
  has one `message` item per Codex `agent_message` and one `reasoning` item per `reasoning` item.
  They are read from the raw exec JSON stream in memory, without the agent's verdict marker lines,
  and the decoded text is scrubbed and redacted. The trace keeps the last 200 such items within 128
  KiB, with a `notice` item when it leaves older ones out. Before, its only `message` item was the
  last 2000 characters of the stored stream: JSON-escaped command output, the `HUMANISH_ACTOR_NONCE`
  line and token usage. Analysis could quote that text, and a quote that decoded a `\n` escape
  failed with `analysis_validation_failed_quote_invalid`. The stream tail stays in the `command`
  item's `outputTail`, which analysis does not quote. `counts.messages` now counts the stream's
  `agent_message` items, where it was 1 for any output, and `counts.runtimeParticipantItems` is read
  from the raw stream too. Bundles written before this change keep their old `message-001` item, and
  re-analysis still quotes it.

- `humanish serve --safe` says which runs it left out and why (#1373). After `runs:` it prints a
  `hidden:` count and one line per grade and reasons, such as `3 runs local_only (RAW_SCREENSHOTS)`.
  When a run is held back only for raw screenshots, it names the redacted-copy step:
  `humanish export --run <id> --format bundle --redact-screenshots --out <dir>`, then
  `humanish serve --safe --cwd <dir>`. The JSON result carries `hiddenRuns`. Before, a project
  whose live runs were all `local_only` printed `runs: 0` and nothing else.
- `humanish doctor --lab` and the TUI's lab screen give each Codex failure its own recovery
  (#1371). A Codex that is installed but signed out says to run `codex login`; signed in with an
  API key, to run `codex logout` and `codex login` with a ChatGPT account. A `codex` humanish cannot
  run names the file it found on PATH and why, such as a wrapper script that is neither the native
  executable nor the npm launcher, and gives the install command. Before, every code but an
  unsupported version said "Install the supported Codex CLI version and sign in", which the 0.106.1
  release dogfood got for a signed-out Codex 0.160.0. A provider key that is present but that the
  lab does not read now shows `present (<source>), not used by this lab` in place of `supplied by`.
  With a declared scorer, which may read any key, doctor makes no such claim.
- A local VM run whose desktop shutdown is unconfirmed records it in `status.json` (#1363).
  `outcome.execution.warnings` gets a `sandbox-cleanup` entry naming the container and the
  `docker rm --force --volumes <container>` command that removes it; `ok` is unchanged. Its
  automatic analysis records `skipped` with `AUTOMATIC_ANALYSIS_CLEANUP_UNCONFIRMED`, which the CLI
  line, the TUI and the Observer all show, and the command still exits 2. Before, status.json
  showed nothing, and the analysis read `failed` (`AUTOMATIC_ANALYSIS_FAILED`) with no record.
- `humanish doctor --lab` plans the lab with the planner `humanish lab run` uses, in the lab's own
  scenario mode. A lab the planner refuses now fails doctor's `live route` row with the planner's
  message: for example a live terminal lab without `scenario.caps`, or an `execution.timeoutMs`
  whose sandbox deadline passes 60 minutes. Before, doctor reported the lab's keys as if the run
  could start. The TUI's lab screen shows the planner's message in place of the missing keys,
  `refused ✗` in place of `keys ✗`, and marks the live row `refused` as it marked `needs keys`.
  Doctor and the TUI now read the key and subject env names from the plan's requirements; they
  are unchanged for every committed lab.
- A lab whose inline `personas` entry refers to its own YAML anchor no longer overflows the stack
  while it is planned. `lab run` threw `RangeError`; a dry run of such a lab now completes, and
  doctor and the TUI, which now plan the lab, report its keys.
- An adopter-hosted email catch's warnings no longer carry a provisioned value or the catch's
  bearer token (#1343). Shared-world runs only pattern-redacted a failed drain's error, and
  neither route removed the catch token, its encoded forms (percent-encoded, JSON-escaped, hex, or
  base64 at any byte offset) or a token inside the catch URL. Both routes now scrub every comms
  warning of those values before redacting it, and a warning that held escapes shows them decoded.
  A catch token shorter than 16 characters, or not well-formed Unicode, is refused by a live run
  (`HUMANISH_CUA_LAB_COMMS_TOKEN_INVALID`, `HUMANISH_CONCURRENT_SHARED_WORLD_LAB_COMMS_TOKEN_INVALID`)
  and by `humanish comms catch --token`.
- A scripted scenario's `press` step sends its key (#1352). Before, `press` ran as `click` and its `key` was
  dropped, so a step that pressed Enter in a form field clicked the field instead, and a 0.106.1
  live pass on TodoMVC ended `fail` at "Visible page state did not change". `press` now needs `key`
  (Playwright key syntax: `Enter`, `Tab`, `Control+A`). With a `selector` it focuses that element
  and presses the key; without one it presses the key on the focused element. The scenario parser
  refuses a `press` step without `key`, and `key` on any other step. Migration: a scenario that used
  `press` to click uses `click`.
- A computer-use, shared-world or scripted run whose sandbox release was not confirmed records it in
  `status.json` (#1348). `outcome.execution.warnings` gets a `sandbox-cleanup` entry naming the
  participant or `subject`, the release warning and `humanish reclaim --run <id>`. The run stays
  `ok`. On computer-use runs, `run.json` `providerResources` marks such a sandbox `unknown` rather
  than `running`, with the release warning as `cleanup.reason`; `running` now means kept for
  debugging. Before, the run read as a clean success with `execution.failures: []`.
- `humanish lab run --rerun-failed-from` selects a fan-out participant whose session ended
  goal_satisfied but reported a blocker (#1341). The review counted that participant as blocked,
  but rerun selection read the trace status, `passed`, and answered that nothing needed a rerun.
  Fan-out bundles now record each participant's judged status as `streams[].judgedStatus`, and
  rerun selection reads it; an older bundle without it keeps the previous rule.
- A terminal scorer's score whose `data` is not an object (an array, a string, a number or `null`)
  is dropped with a warning (#1366). Before, the terminal route attached it to `run.json` as
  `adapterScore`, and `humanish verify` then refused the bundle. A declared scorer that returns one
  now fails the run with the malformed-scorer gap, as on the browser routes.
- Codex participants and Codex-account analysis check every item an app-server notification carries
  (#1358). Before, a notification under a method humanish did not handle, one that arrived before
  the turn was dispatched, and an item inside `turn.items` passed unchecked, so a native command
  reported that way did not stop the run. Now every item, in `item`, `items`, `turn.items` or
  `thread.turns[].items`, goes through the item allowlist and the participant's tool check whatever
  its method, from the start of the launch until the app-server exits. A disallowed or malformed
  item fails the launch or the request with `codex_tool_call`, and one that arrives between requests
  fails the next request. A participant tool request before the turn starts or after it completed is
  refused the same way; one that crosses an interrupt during shutdown is declined and runs nothing.
  Every refusal in a participant's session, including one after its last request, during shutdown or
  in a debrief whose failure the run tolerates, also fails the run at close, and so does output that
  could not be checked (malformed, past a limit, or a last frame cut off by anything but humanish's
  own signal): `status.json` `outcome.execution.failures` gets a `provider-policy` entry naming the
  participant, and the result's `ok` is false; a Codex-account analysis that had completed fails
  with the refusal's code, `analysis_codex_tool_call` for a disallowed item. A last frame cut off by
  humanish's own signal, delivered to the running app-server and ending it, is a run warning with
  its byte count. A method humanish does not know that carries no item does not stop the run:
  participant runs and `humanish analyze` list such methods with counts in their warnings.
- `humanish doctor --lab` and the TUI name the Codex CLI they found on PATH when it is not admitted
  or cannot run, and give the command that replaces that binary (#1376). A Codex installed in the
  project (`node_modules/.bin/codex`, which `npx humanish` puts first on PATH) gets
  `npm install -D @openai/codex@<release>` in that project, or `npm uninstall @openai/codex` there
  to use the global one. One in npm's global prefix gets `npm install -g @openai/codex@<release>`,
  and any other, such as a Homebrew install, is told to update it with the tool that installed it.
  Before, doctor always said `npm install -g`; in the 0.106.1 live pass that left the project's
  older Codex first on PATH, so the refusal stayed.

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
