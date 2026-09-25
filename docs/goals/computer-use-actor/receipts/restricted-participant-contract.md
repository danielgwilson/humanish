# Restricted account participant: internal contract

This implementation connects the qualified Codex account launcher to the existing
computer-use loop and an already-owned browser executor. It adds no CLI mode,
installer, VM allocation, automatic account selection, or API fallback. Existing
API providers and saved bundles without the new fields keep their defaults.

## Admission and output

Admission uses the launcher's supported Linux x64 or Apple Silicon macOS,
file-backed ChatGPT login route. The requested profile records Codex CLI 0.154.0,
`gpt-6-astra`, low reasoning effort and the `codex-ui-tools-v1` policy. The durable
profile itself is a request declaration.
Each request's `profileVerified` means the launcher passed its version, effective
config, account, thread and tool-policy checks before attempting `turn/start`.
It does not establish remote completion, quota, a charge, or a successful action.

One restricted Codex thread belongs to each participant for the full interaction
and closing feedback. The initial persona and assignment stay fixed. Its native
UI tool proposes browser actions; Humanish returns the current PNG, context hint
and actual input acknowledgments within that continuing turn. Codex manages context compaction; Humanish does not discard turns
after an eight-turn window. The execution profile records `continuing-thread-v1`;
readers still accept earlier structured-action profiles and `recent-eight-16k-v1` bundles.

DOM, executor app state, hidden text and private reasoning are not participant
input. Proposed actions and acknowledged input do not prove that the app reached
the intended state; the next screenshot supplies observable evidence. No new
conversation is silently substituted after a provider failure.

A tool proposal is validated before any action: one to four existing browser
actions and a public participant comment. Fractional coordinates survive, and
optional action fields use the existing executor defaults. Final output contains
an outcome, summary and reported friction. Closing feedback cannot dispatch more
UI inputs. No rejected action is silently removed and no provider text becomes a
command.

The same participant implementation drives hosted E2B desktops. That route keeps
the operator's Codex home/authentication and configured model selection, with
explicit effort honored. It records the resolved model; ChatGPT authentication carries unknown-dollar
account billing, while API-key authentication remains separately priceable.
Only the Humanish UI tool is enabled; general-purpose Codex tools and inherited
MCP integrations are disabled for the participant thread.

## Lifetime and accounting

The marked provider uses one attempt per request and no retry. Abort or an outer
request deadline permanently closes that participant's admission. The loop
retains the original request promise, consumes its settlement, and waits at most
five seconds for cleanup. Owner close uses the remainder of that same grace;
it does not add another five seconds. Late output cannot dispatch an action.
An unconfirmed cleanup receipt remains unconfirmed after late recovery.
Successful requests remove their abort listener before the loop disposes its
request controller, so normal subsequent turns remain possible.

Native tool yields remain pending rather than inventing a receipt for every
callback. Settlement records dispatch state, token-completeness and cleanup once;
known pending usage is available to runtime budget checks. A request still pending
when the study stops retains incomplete accounting, not a zero-token result.
Delivered usage from failed or interrupted requests counts once. Account dollar
cost stays null even when all token counts are known. Numeric dollar and output
token caps are rejected before observation or a participant call. API pricing
cannot be inferred from the model name. Bundle verification and the independent
Observer reader reject account charges, numeric account model cost lines,
ambiguous model-line attribution, and malformed request receipts. Separately
measured desktop, API participant and analysis costs retain their own meaning.

`runRestrictedParticipantStudy` is the internal bounded consumer. It accepts one
local-app participant, one already-owned desktop and a finite study deadline of
at most ten minutes. It uses `runLab`, its normal run bundle producer and its
normal automatic-analysis completion boundary. Provider and desktop cleanup
finish before that boundary; any unresolved cleanup blocks automatic analysis.
Analysis must be explicitly Codex-backed or disabled. The consumer never
allocates a desktop or reads an API key.

## Verification boundary

Hermetic tests exercise output schemas, conversation isolation, cancellation and late
settlement, accounting, durable readers, and the real bundle/completion producer.
Provider domain mocks are identified as such. The captured launcher wire fixtures
are reused with documented synthetic ID/counter mutations to prove dispatch
admission, cleanup and rejection of a non-participant answer; they are not a
fabricated successful account study.

A live acceptance run must separately retain actual schema acceptance, visible
Unicode input and Save behavior, the normal automatic report, exact source and
requested profile, unknown account dollars, and confirmed browser/provider
cleanup. A cancellation run must establish no later browser input. Tests alone
do not qualify VM boot, managed installation, Mac support, cohorts or parallel
account requests. Narration is participant speech, not private chain of thought.
