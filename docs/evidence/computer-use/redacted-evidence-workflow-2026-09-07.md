# Readable originals and a shareable feedback workspace

Four real computer-use sessions on Humanish 0.83.2 produced readable local
recordings. Export candidate `fd44372` created four independent redacted
workspaces without changing any of the 67 original files. The exported copies
retained all measured outcomes, task funnels, subject pins, actor actions,
settings, token usage and cost estimates. This is an operator rehearsal of the
maintainer workflow; no external maintainer participated.

## Subject and method

The subject was TodoMVC's vanilla JavaScript example at upstream
`ff43b02e59dfa604386bb382034b2cd07c2bcd8a`. Two participants used the original;
two used the previously studied visible Edit control. This repeats a known
repair, rather than discovering a new defect. Each participant used the same
synthetic-new-user persona, keyboard-only instructions, gpt-5.6-sol at medium
reasoning effort, and a fresh 1440×950 hosted desktop.

The task was to add “Draft proposal,” rename that same item to “Send proposal,”
and leave it saved. A private adapter used the public CUA API and a fresh
post-session state observation to check the original item ID, final label and
closed editor. The adapter's state input is additional instrumentation; these
results do not establish the capability of an uninstrumented CLI manifest.

| Run | Added original | Same saved item renamed | Participant outcome |
| --- | --- | --- | --- |
| `maintainer-0907-original-keyboard-1b` | 1/1 | 0/1 | blocked |
| `maintainer-0907-original-keyboard-2` | 1/1 | 0/1 | blocked |
| `maintainer-0907-visible-edit-keyboard-1` | 1/1 | 1/1 | reached goal |
| `maintainer-0907-visible-edit-keyboard-2` | 1/1 | 1/1 | reached goal |

The original participants found no keyboard rename path. Both patched
participants used Edit, Ctrl+A and Enter. All four reported friction; the two
successful participants mentioned ambiguous row focus and the edit field's
unselected text. No pointer actions appeared in the retained action traces.
The product review correctly counted the original participants as blocked even
though the lower-level actor completion field said `goal_satisfied`.

## Export and downstream proof

The raw original verified as `local_only`; ordinary feedback draft refused with
`HUMANISH_FEEDBACK_SHARE_SAFETY_BLOCKED`. Each candidate export used:

```bash
humanish export --run RUN --format bundle --redact-screenshots --out shared-study
humanish verify --cwd shared-study --run RUN
humanish feedback draft --cwd shared-study --run RUN
humanish feedback verify --cwd shared-study --run RUN
humanish feedback issue --cwd shared-study --run RUN --repo tastejs/todomvc
```

The four derivatives contained 31 transformed PNG frames in total. Each workspace
was moved, and its original project was made unavailable during downstream
commands. Published Humanish 0.83.2 independently verified every derivative as
`share_ready` and completed feedback draft, verification and issue Markdown.
Issue Markdown generation did not submit another upstream issue or comment.

Candidate HTML export also passed for all four. Browser inspection initially
found a false `local_only` badge in the bundle Observer and missing frames in
HTML playback. The amendment retains the real verification grade and accepts
embedded raster images only in screenshot rendering. All 31 frames then
navigated in each format across eight real artifact surfaces. Player images and
thumbnails loaded, the badge matched verification, and 1440-pixel desktop and
390-pixel mobile layouts had no horizontal overflow or page errors.

The derivative receipt identifies the source inventory and each copied,
transformed or omitted file. Operational lease journals and process status are
omitted; the copy does not own a sandbox or represent another participant.
Screenshots use the existing full-frame blur. Text still requires review, and
the readable original remains necessary for detailed visual adjudication.

## Cost and limits

The four sessions made 31 provider requests. Retained usage supports an estimated
$0.3612788 for model tokens and $0.033643952 for desktop compute, totaling
$0.394922752. Desktop estimates use observed 8-vCPU/8-GiB resources and a
conservative creation-attempt-to-confirmed-absence span. All four owned desktops
were confirmed absent. These are rate-based controls, not provider invoices;
plan fees, credits and negotiated rates are not attributed.

A first configuration attempt was refused before any allocation or model call
because a manifest output-token setting was incompatible with a custom session
hook. The admitted runs enforce 4,096 output tokens through the provider
transport. The refused configuration is retained separately and is excluded
from participant and spend denominators.

This receipt does not establish organic activation, maintainer acceptance,
human-population success rates, persona differences, unknown-cost preservation
from a live run, or a nested credential grant. Unknown-cost preservation and
malformed evidence refusal have separate synthetic regression coverage.
