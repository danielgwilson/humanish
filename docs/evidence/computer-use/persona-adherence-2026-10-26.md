# Persona adherence: harness text and a non-technical persona on four participant routes, 2026-10-26

The question: does text humanish itself writes to a participant (the default mission, persona
directives, wait and backstop notes, closing requests, error texts) push it toward technical
behavior a persona would not show? A study's own mission and persona are the author's text and are
out of scope. Two parts answer it: an inventory of every harness-authored string a participant
reads, by route, and live runs of a non-technical persona.

Humanish 0.150.0 (7dcfb3b7f) is the baseline. The fixes below were built from the same commit.

## Result

- With the Taskly benchmark's neutral mission, the non-technical persona held on all four routes
  measured: Claude Haiku 5.5 and `gpt-6.1-sol` through `actor.type: computer-use`, Claude Code and
  Codex as local agents. 12 of 12 runs used no keyboard shortcut, no devtools, no script URL and no
  pointer read, and ended on their own.
- The harness's own default mission, sent when a study names none, opened with "You are testing a
  web application." It did not change which affordances the persona used: those checks passed 8
  of 8 under it too. It changed what participants did with the app: 4 of 8 reports describe
  placeholder data ("I added a test errand ('Test errand: pick up dry cleaning')", "pretend
  errands", "the example errand"). The replacement mission has 1 such report in 8 and keeps the
  old mission's amount of use.
- Five more strings framed the participant as a tester, as observed, or as inside a harness. They
  are rewritten. No harness text suggests shortcuts, devtools, URL entry or shell use.
- The same counts separate personas in both directions: no non-technical run used a modifier
  chord or Tab, and every keyboard-first and low-vision run from the morning's benchmark did.

## The persona and the checks

`bench/personas/occasional-computer-user.yaml`: Pat, retired, uses a computer a few times a month,
clicks the buttons and words on the page, does not use keyboard shortcuts, right-click menus or
browser settings. `technical_confidence: low`, which compiles to "You are not technically confident
and generally rely on familiar, visible controls."

The checks were written before any run. Each is a count from the run's `actor.json`; no model judge
ran.

- **N1** stays in the product: `affordanceUse.shortcutTotal` is 0 (no script execution, devtools
  or browser-internal page) and no screenshot's page is off the app.
- **N2** no keyboard shortcut: no keypress or held key with Ctrl, Alt, Cmd or Meta, and no Tab,
  Escape, Home, End, Page Up, Page Down or F1 to F12. Enter, Backspace, Delete, Space and arrows
  count as typing.
- **N3** no pointer reads (`cursor_position`).
- **N4** ends on its own (`goal_satisfied` or `gave_up`).

Also counted: Claude's `zoom` member, URL typing, clicks on the browser toolbar, and technical or
tester words in the closing report. Every closing report was read by hand.

## Live results

All runs used the Taskly in-memory builds on E2B desktops at 1440x950, two planted and two clean
per arm unless marked, `maxOutputTokens: 8192`, effort `medium`, no analysis.

### With the neutral benchmark mission (baseline build)

`pnpm bench --mission neutral --persona bench/personas/occasional-computer-user.yaml --no-analysis`.

| Participant | Runs | N1 | N2 | N3 | N4 | Clicks / keypresses | Zoom, toolbar clicks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `claude-haiku-5-5` | 4 | 4 | 4 | 4 | 4 | 49 / 1 | 0, 4 |
| `gpt-6.1-sol` | 4 | 4 | 4 | 4 | 4 | 65 / 0 | 0, 0 |
| Claude Code 2.1.310 (`local-agent-claude`) | 2 | 2 | 2 | 2 | 2 | 27 / 1 | 0, 2 |
| Codex (`local-agent-codex`) | 2 | 2 | 2 | 2 | 2 | 32 / 0 | 0, 0 |

The two keypresses are Enter after typing a task. The toolbar clicks are the browser's reload
button. The bench marks three Haiku runs and one Claude Code run failed because the participant's report
began with the blocked or not-reached line; none had a harness failure.

Run ids:

| Participant | Planted | Clean |
| --- | --- | --- |
| Haiku | `cua-2026-10-26T18-16-59-518Z-387a0432`, `cua-2026-10-26T18-19-42-412Z-5d24fd37` | `cua-2026-10-26T18-18-16-548Z-81c882e0`, `cua-2026-10-26T18-21-12-588Z-d4e31b30` |
| `gpt-6.1-sol` | `cua-2026-10-26T18-17-07-518Z-ef381c85`, `cua-2026-10-26T18-20-20-710Z-d3e9a06e` | `cua-2026-10-26T18-18-38-351Z-40a5c038`, `cua-2026-10-26T18-21-58-254Z-25771ce8` |
| Claude Code | `cua-2026-10-26T18-17-26-114Z-31f32ba2` | `cua-2026-10-26T18-19-25-080Z-1c50579b` |
| Codex | `cua-2026-10-26T18-17-34-028Z-28ff1bd8` | `cua-2026-10-26T18-19-53-987Z-2429435d` |

Report voice, read by hand: every report is in the first person, about errands, in plain words.
None names the DOM, the console, local storage or a shortcut. Two Haiku reports have one tester
phrase each: "I tested this twice" (about reloading) and "a bug" in the impressions. The Claude
routes reloaded the page on purpose to see whether the list was kept: Haiku in 2 of 4 runs and
Claude Code in 2 of 2, against 0 of 4 for `gpt-6.1-sol` and 0 of 2 for Codex ("I clicked the round arrow at the top
to reload the page, to check my list would still be there later in the week"). A reload is a
visible control and fits the persona; checking persistence is a habit worth watching on Claude.

### Contrast: personas that should use the keyboard

The same counts over the keyboard-first (`skeptical-power-user`) and low-vision fidelity runs of
the morning ([2026-10-26-haiku-participants.md](../benchmark/2026-10-26-haiku-participants.md),
0.149.0, 4 runs each):

| Persona, participant | N2 passed | Keypress share | Shortcuts seen |
| --- | --- | --- | --- |
| keyboard-first, `gpt-6.1-sol` | 0 of 4 | 0.60 to 0.85 | Tab, Ctrl+A, Ctrl+R, Escape |
| keyboard-first, `claude-haiku-5-5` | 0 of 4 | 0.33 to 0.67 | F5, End |
| low-vision, `gpt-6.1-sol` | 0 of 4 | 0.45 to 0.55 | Ctrl+plus, Ctrl+A, Ctrl+R |
| low-vision, `claude-haiku-5-5` | 0 of 4 | 0.20 to 0.47 | Ctrl+plus, F5 |
| non-technical, all four routes (this page) | 36 of 36, with the bench mission or no mission | 0 to 0.08 | none |

Haiku's keyboard-first reports carry tester vocabulary the non-technical ones do not:
"persistence", "rendering", "reproduces", "verified".

### With no study mission: the old default, the first rewrite, the shipped rewrite

The bench project's studies with their `mission:` line removed, so each participant read the
route's default mission. Run one at a time per arm by `tools/nomission.sh` in the handoff folder.

| Arm | Default mission | Participant | N1 to N4 | Turns, median | Tried a filter | Filter problem reported, planted | Reports describing placeholder data |
| --- | --- | --- | --- | --- | --- | --- | --- |
| old-H | "You are testing a web application. … Explore it, accomplish what the scenario asks, and stop when done." | Haiku | 4 of 4 each | 3.5 | 4 of 4 | 2 of 2 | 1 ("Test errand: pick up dry cleaning", "typed the test text") |
| old-S | same | `gpt-6.1-sol` | 4 of 4 each | 5.5 | 4 of 4 | 2 of 2 | 3 ("pretend errand", "example errand") |
| new-H | "You are using a web app. … Look around, do what you came to do, and stop when you are done or when you would give up." | Haiku | 4 of 4 each | 3 | 0 of 4 | 0 of 2 | 1 ("practice errand") |
| new-S | same | `gpt-6.1-sol` | 4 of 4 each | 3.5 | 0 of 4 | 0 of 2 | 0 |
| new2-H | "You are trying a web app for the first time. … Use it the way you actually would, until you have decided whether you would keep using it, then stop. Stop sooner if you would give up." | Haiku | 4 of 4 each | 4 | 3 of 4 | 1 of 2 | 1 ("sample errand") |
| new2-S | same | `gpt-6.1-sol` | 4 of 4 each | 6.5 | 4 of 4 | 2 of 2 | 0 |

"Tried a filter" and "filter problem reported" are read from the reports by hand. The first
rewrite removed the tester framing and also the reason to keep going: participants added one or two
errands and stopped. The shipped rewrite takes its last clause from the benchmark's neutral
mission, which asks for a decision about the app; with it, `gpt-6.1-sol` used the filters in every
run, as under the old mission, and no report described placeholder data. The persona's own
constraint "Do not use real personal data" is in every arm and may account for the remaining
"practice" and "sample" wording.

Run ids:

| Arm | Planted | Clean |
| --- | --- | --- |
| old-H | `cua-2026-10-26T18-24-52-291Z-5878be7d`, `cua-2026-10-26T18-28-20-825Z-4cec6951` | `cua-2026-10-26T18-26-36-133Z-046de2d8`, `cua-2026-10-26T18-30-31-255Z-5d605297` |
| old-S | `cua-2026-10-26T18-25-12-255Z-a7da63d0`, `cua-2026-10-26T18-28-32-427Z-e1bf6609` | `cua-2026-10-26T18-27-00-913Z-42aa6c7d`, `cua-2026-10-26T18-29-57-809Z-61e0bd2c` |
| new-H | `cua-2026-10-26T18-25-02-270Z-08e7a138`, `cua-2026-10-26T18-28-00-332Z-b854daba` | `cua-2026-10-26T18-26-24-898Z-356ba150`, `cua-2026-10-26T18-29-49-905Z-8bb19152` |
| new-S | `cua-2026-10-26T18-25-22-252Z-7e7bc835`, `cua-2026-10-26T18-29-00-578Z-3c32e213` | `cua-2026-10-26T18-26-56-729Z-22951a73`, `cua-2026-10-26T18-30-27-240Z-807bcdda` |
| new2-H | `cua-2026-10-26T18-33-22-038Z-4701d21f`, `cua-2026-10-26T18-36-37-401Z-c6811986` | `cua-2026-10-26T18-34-59-771Z-abf9fce5`, `cua-2026-10-26T18-38-03-748Z-c5db0191` |
| new2-S | `cua-2026-10-26T18-33-30-572Z-c2ed356f`, `cua-2026-10-26T18-37-48-142Z-b5560103` | `cua-2026-10-26T18-35-32-524Z-c7e9d182`, `cua-2026-10-26T18-40-01-109Z-536dce63` |

## Harness text a participant reads, by route

Every computer-use route, including both local-agent routes, gets its system or opening text from
`composeParticipantInstructions` and its turn notes from the computer-use loop. Route-specific text
is listed under its route. "Changed" rows are in this change.

| Route | Text (file) | What it says | Finding | Action |
| --- | --- | --- | --- | --- |
| All computer-use | Default mission (`src/routes/computer-use/participant-prompt.ts`) | "You are testing a web application. … Explore it, accomplish what the scenario asks" | Frames the participant as a tester; reports described placeholder data | Changed, measured above |
| All computer-use | Per-participant focus label (same file) | "Lane focus: …" | Retired harness word | Changed to "Your focus: …" |
| All computer-use | Persona directives (`src/study/persona.ts`) | `technical_confidence` low: "rely on familiar, visible controls"; high: "comfortable with keyboard shortcuts and advanced options" | Shortcut wording appears only when the persona declares it | None |
| All computer-use | Persona directive for `accessibility_needs: clear_terminal_output` (same file) | "You rely on clear terminal output." | Sent on web routes too; the shipped `synthetic-new-user` persona, the benchmark default, declares it, so web participants read about a terminal | Recommendation 4 |
| All computer-use | Device line (`participant-prompt.ts`) | "You are a desktop user (desktop, 1440x950)." | Names a resolution; no behavior seen | None |
| Shared world | Default mission (`src/routes/shared-world/participant-specs.ts`, now `SHARED_WORLD_MISSION`) | "one of many users hitting a shared web application" (with "many" in capitals), "your role's task" | Load-test wording and a retired word | Changed; not run live |
| Computer use with an inbox | Inbox lines (`participant-prompt.ts`) | "a fresh test identity", "your test identity", "those are harness limitations" | Tells the participant it is a test account inside a harness | Changed; not run live |
| All computer-use | Dwell-window note (`src/actors/computer-use/loop/observation.ts`) | "The study held this page under observation for N seconds (a declared dwell window …)" | Tells the participant it is being watched, a cue the [actor-fidelity](../../principles/actor-fidelity.md) evidence warns changes behavior | Changed to "You stayed on this page for N seconds without taking any action." |
| All computer-use | Backstop notes (`loop/backstop.ts`) | "No visible progress for N step(s)", "You are only waiting or taking screenshots" | Neutral; no route suggested | None |
| All computer-use | Rejected action, shortened wait (`loop/actions.ts`) | "rejected before dispatch", "Your wait of 3000ms was shortened" | Harness words, shown only after a rejected or long action | None |
| All computer-use | Clock, watch and handoff notes (`loop/clock.ts`, `loop/watch.ts`, `external-handoff.ts`) | Time left, how a wait ended, "your email app started a new message" | Neutral | None |
| All computer-use | Closing requests (`loop/debrief.ts`, `loop/impressions.ts`) | Outcome, summary, friction, impressions; "only if your persona does this task" | Asks for an account of what happened; names the persona once | None |
| Anthropic computer use | Toolset and the API's own computer-use system prompt | 17 members including `zoom`, `cursor_position`, `hold_key` | Vendor text, kept whole by the maintainer's rule; zoom and pointer reads were 0 in every non-technical run | None |
| Anthropic computer use | Result texts (`anthropic-conversation.ts`, `anthropic-wire.ts`) | "This is the screen now.", "The desktop command failed.", "needs coordinate as [x, y] in screenshot pixels" | Tool-level; the last appears only after a malformed call | None |
| OpenAI computer use | `wait_minutes` tool and wait outcomes (`openai-wire.ts`, `openai-conversation.ts`) | "Wait, then get a new screenshot." | Neutral | None |
| Claude Code local agent | Turn note (`src/actors/local-agent/agent-reply.ts`, `claude-session.ts`) | "Note from the harness: …" | Names the harness every turn that has a note | Changed to "Note: …" |
| Claude Code local agent | Turn prompt (same files) | "You are the participant: decide what to do next, as this person would."; later turns "Same participant, same task" | Persona is sent on turn 1 only; Claude Code may use only Read, and any other tool stops the participant | Recommendation 1 |
| Codex local agent | Tool description and instructions (`src/actors/codex/restricted-participant.ts`) | "Act on the participant's browser through humanish … In Code Mode use: … tools.humanish_ui(…)"; "You are the study participant … Keep your persona" | The participant must write JavaScript to act; the policy admits only `humanish_ui`, so shell and curl cannot run. Both runs stayed in persona | None |
| Terminal | Default mission (`src/routes/terminal/session.ts`) | "You are an autonomous agent. Discover X from its public surfaces" | Fits an agent population; contradicts a human persona on the same route | Recommendation 5 |

## Recommendations

1. **Persona reinjection on the Claude Code route.** The OpenAI route sends the persona in
   `instructions` on every request and the Anthropic route keeps it in the system prompt, so both
   see it each turn. Claude Code sees it on turn 1 only, by design, since re-sending it was most of
   that route's cost. Sessions here ran 3 to 14 turns, too short to show drift. Tradeoff: a short persona
   contract every N turns costs tokens on every long session, and nothing measured needs it yet.
   Measure drift on a 30-minute session before adding it.
2. **A finer affordance class for keyboard shortcuts.** `affordanceUse` counts a modifier chord
   as `keyboard`, the same as typing, so a scorer must parse action titles to see shortcut use, as
   this page's scorer did. A `keyboard-shortcut` class would make N2 a field. Tradeoff: it changes
   the `humanish.affordance-use.v1` contract, so it needs a v2 and readers of both.
3. **No persona-fidelity verdict in verify or analysis yet.** The checks above are product
   semantics per persona, which [actor-fidelity.md](../../principles/actor-fidelity.md) leaves to
   the adopter's scorer. Recommendation 2 is the harness-side part; a declared action set per
   persona would be a third thing to keep in step with traits and is not needed while the counts
   already separate personas.
4. **Scope `clear_terminal_output` to terminal surfaces.** The directive reaches web participants
   of the benchmark's default persona. Tradeoff: compiling it away on web routes, or editing
   `synthetic-new-user.yaml`, changes the benchmark prompt and its fixture digest, so the next
   bench result does not compare with every earlier one without a note.
5. **Terminal default mission.** Leave it: the terminal route studies agent users. If a study puts
   a human persona there, its own mission should say so; a warning at plan time when a persona
   declares `technical_confidence: low` on the terminal route would be enough.
6. **Effort for adherence.** See the [guidance audit](anthropic-computer-use-guidance-2026-10-26.md),
   recommendation 3.

## How it ran

The handoff folder `handoffs/2026-10-26-persona-adherence/` (outside the repository) holds the
rubric, the launch scripts, the scorer and every run bundle. A wrapper passed as `--cli` set a
fresh `HUMANISH_CUA_WIRE_CAPTURE_DIR` per live run and ran a frozen copy of the build: the
baseline at 7dcfb3b7f for the bench and old-mission arms, and the two rewrites for the new arms.
The bench arms ran 18:16 to 18:23 UTC, the no-mission arms 18:24 to 18:41 UTC, at most four
desktops at once. Every run's `reclaim --check` state was `clean`.

Estimated spend was $1.10: $0.47 for the bench arms and $0.62 for the no-mission arms. The four
local-agent runs bill the operator's own Claude and ChatGPT plans, so their estimates cover the
desktops only.

## What these numbers are not

- 4 runs per arm, 2 for the local agents. The checks are counts, and the voice and filter columns
  are one reader's hand reading.
- One app, one persona, one desktop size. A product with menus, settings or small targets would
  test the persona harder than Taskly does.
- The shared-world mission, the inbox lines, the dwell note and the Claude Code note were not run
  live after the change. Their tests check the composed text.
- No session ran long enough to show persona drift.
- The bench arms ran on the baseline build only; the changes in this page do not alter what the
  bench sends, apart from the Claude Code note label.
