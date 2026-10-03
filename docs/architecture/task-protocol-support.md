# Task protocol support

`actor.tasks` adds a participant protocol to the mission. Goals reach the
participant; hidden success criteria go only to the observation tracker. A route
that cannot carry both halves refuses the declaration before execution. Removing
`tasks` is an explicit choice to run a mission-only study, not an automatic fallback.

| Execution path                                        | Task support | Mechanism                                                                                     |
| ----------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| CUA, app-url, one participant or fan-out              | Supported    | The participant prompt composer renders goals; the CUA loop tracks observations               |
| CUA, provisioned clone or local-tree, separate worlds | Supported    | Same prompt composer and loop                                                                 |
| CUA, local-app with caller executor/provider          | Supported    | Same loop; the caller supplies observations                                                   |
| CUA, desktop-cli                                      | Supported    | Same prompt and tracker; unavailable criterion inputs remain unmeasured                       |
| Shared-world, provisioned or external-public          | Rejected     | Actor specs omit the protocol before CUA session dispatch                                     |
| Terminal-product                                      | Rejected     | Terminal prompt and result contract do not implement tasks                                    |
| Scripted-browser, local or provisioned                | Rejected     | Scenario steps drive the participant; no task protocol is consumed                            |
| Synthetic (`this-repo`)                               | Rejected     | Study dispatch does not pass task declarations to the dry-run engine                          |
| Any second or later `actors[]` entry                  | Rejected     | Current runners consume only the first actor; declare every participant under the first actor |

Both registered CUA actors (`openai-computer-use` and `local-agent`) share the CUA
session loop. Their task support does not depend on which provider chooses actions.
Custom session hooks remain caller-owned implementations of that same contract;
this preflight does not certify arbitrary hook behavior.

The parser reports `HUMANISH_STUDY_INVALID` with the unsupported field path. `runStudy`
reports `HUMANISH_STUDY_TASKS_UNSUPPORTED` in the route's failure envelope, from
`planStudy` (`src/study/plan.ts`) and each route's plan.
Refusal precedes run storage, source preparation, user hooks, local processes,
sandbox allocation, and model calls. No task content appears in the error.

A future route gains support only after proving participant goals, hidden criteria,
observation-backed completion, explicit missing-input handling, and per-participant
bundle evidence together. Appending goals to a prompt alone is insufficient.
