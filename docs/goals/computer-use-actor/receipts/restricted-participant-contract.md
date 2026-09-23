# Restricted account participant: internal contract

This implementation connects the qualified Codex account launcher to the existing
computer-use loop and an already-owned browser executor. It adds no CLI mode,
installer, VM allocation, automatic account selection, or API fallback. Existing
API providers and saved bundles without the new fields keep their defaults.

## Admission and output

Admission uses the launcher's supported Linux x64, file-backed ChatGPT login
route. The requested profile records Codex CLI 0.154.0, `gpt-6-astra`, low
reasoning effort and the `restricted-codex-v1` policy. The durable profile itself is a request declaration.
Each request's `profileVerified` means the launcher passed its version, effective
config, account, thread and empty MCP checks before attempting `turn/start`.
It does not establish remote completion, quota, a charge, or a successful action.

A fresh restricted thread receives the participant instructions, current PNG,
explicit context hint, and recent history. DOM, executor app state, hidden text,
provider continuation IDs and private reasoning are not participant input.
History retains at most eight prior turns and 16 KiB. It contains public
participant narration, action descriptions and input acknowledgment statuses;
typed content is represented by its length. Omitted history is counted.
Acknowledged input is not proof that the app reached the intended state.

A complete proposal is validated before any action: one to four existing browser
actions, or a closing outcome with no actions. Fractional coordinates survive.
Structured output requires every property; null `click.button` and `wait.ms`
select their existing executor defaults. No other null action value is accepted.
The separate closing-report schema permits a summary and reported friction only.
No rejected action is silently removed and no provider text becomes a command.

## Lifetime and accounting

The marked provider uses one attempt per request and no retry. Abort or an outer
request deadline permanently closes that participant's admission. The loop
retains the original request promise, consumes its settlement, and waits at most
five seconds for cleanup. Owner close uses the remainder of that same grace;
it does not add another five seconds. Late output cannot dispatch an action.
An unconfirmed cleanup receipt remains unconfirmed after late recovery.
Successful requests remove their abort listener before the loop disposes its
request controller, so normal subsequent turns remain possible.

Each attempt records dispatch state, token-completeness and cleanup separately.
Known tokens from failed or interrupted requests count once. Account dollar
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

Hermetic tests exercise output schemas, bounded memory, cancellation and late
settlement, accounting, durable readers, and the real bundle/completion producer.
Provider domain mocks are identified as such. The retained launcher wire fixture
is reused unchanged to prove dispatch admission, cleanup and rejection of a
non-participant answer; it is not a fabricated successful account study.

A live acceptance run must separately retain actual schema acceptance, visible
Unicode input and Save behavior, the normal automatic report, exact source and
requested profile, unknown account dollars, and confirmed browser/provider
cleanup. A cancellation run must establish no later browser input. Tests alone
do not qualify VM boot, managed installation, Mac support, cohorts or parallel
account requests. Narration is participant speech, not private chain of thought.
