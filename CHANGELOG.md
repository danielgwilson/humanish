# Changelog

Newest first. Each entry is the opening paragraph of that version's release notes; the link holds
the full notes. Versions not listed here (0.1.1 through 0.65.0 except 0.20.0, and 0.81.0) are
tagged without notes.

The Unreleased section holds the full notes for the next version until it is tagged.

## Unreleased

The refusal of `humanish keys set` for a name that is not a provider key now lists E2B_API_KEY
before ANTHROPIC_API_KEY.

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
