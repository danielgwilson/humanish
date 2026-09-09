# Task protocol support

`actors[0].tasks` adds a participant protocol to the mission. Goals reach the
participant; hidden success criteria go only to the observation tracker. A route
that cannot carry both halves refuses the declaration before execution. Removing
`tasks` is an explicit choice to run a mission-only study, not an automatic fallback.

| Execution path | Task support | Mechanism |
| --- | --- | --- |
| CUA, app-url, single or per-lane fan-out | Supported | Lane composer renders goals; the CUA loop tracks observations |
| CUA, provisioned clone or local-tree, per-lane worlds | Supported | Same lane composer and loop |
| CUA, local-app with caller executor/provider | Supported | Same loop; the caller supplies observations |
| CUA, desktop-cli | Supported | Same prompt and tracker; unavailable criterion inputs remain unmeasured |
| Sequential shared-world, clone or local-tree | Rejected | Seat composer and session do not forward tasks |
| Concurrent shared-world, provisioned or external-public | Rejected | Actor specs omit the protocol before CUA session dispatch |
| Terminal-product | Rejected | Terminal prompt and result contract do not implement tasks |
| Scripted-browser, local or provisioned | Rejected | Scenario steps drive the participant; no task protocol is consumed |
| Synthetic, smoke, meta | Rejected | Lab dispatch does not pass task declarations to these engines |
| Any second or later `actors[]` entry | Rejected | Current runners consume only the first actor; use supported first-actor lanes |

Both registered CUA actors (`openai-computer-use` and `local-agent`) share the CUA
session loop. Their task support does not depend on which provider chooses actions.
Custom session hooks remain caller-owned implementations of that same contract;
this preflight does not certify arbitrary hook behavior.

The parser reports `HUMANISH_LAB_INVALID` with the unsupported field path. Direct
library entry points report `HUMANISH_LAB_TASKS_UNSUPPORTED` in their existing
failure envelopes. Refusal precedes run storage, source preparation, user hooks,
local processes, sandbox allocation, and model calls. No task content appears in
the error. Low-level synthetic/smoke/meta APIs accept no lab config or tasks; their
lab declaration boundary is `runLab`.

A future route gains support only after proving participant goals, hidden criteria,
observation-backed completion, honest missing-input treatment, and per-participant
bundle evidence together. Appending goals to a prompt alone is insufficient.
