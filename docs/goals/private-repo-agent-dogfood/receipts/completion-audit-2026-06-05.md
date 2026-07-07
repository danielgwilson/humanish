# Completion Audit: 2026-06-05

## Scope

This audit maps the private-repo dogfood goal invariants to current evidence.
Repo labels remain redacted as `repo-01` through `repo-04`.

## Evidence Map

| Invariant | Evidence | Status |
|---|---|---|
| Ignored env supplies provider auth without printing values | Env-name preflight found `GH_TOKEN`, `E2B_API_KEY`, and `OPENAI_API_KEY`; token values were not printed or committed. | passed |
| Four authorized repo slugs supplied through current context, not committed docs | The live command supplied four authorized repos and durable artifacts used redacted lane labels only. | passed |
| GitHub access preflight passes for all assigned private repos | Credential-isolated anonymous-first, token-second read preflight passed `4/4`. | passed |
| Headed E2B Observer-of-Observers run starts up to four desktop lanes with redacted labels | Formal run `oss-meta-2026-06-05T07-02-38-522Z-ea401be2` launched four live headed lanes and durable artifacts used `repo-01` through `repo-04`. | passed |
| Each lane has a terminal state and public-safe reason | All four formal lanes reached `passed`; lane reasons are summarized in the formal receipt. | passed |
| Each lane records app URL and nested Homun proof status | All four lanes reached running app surfaces, nested verify, nested Observer, and visible layouts. The app-url proof path was weaker than desired in part of the actor evidence and was classified as Homun-owned proof-path confusion. | passed with caveat |
| Setup-quality filesystem evidence exists | All four setup-quality snapshots passed `5/5`: `homun/config.ts`, two persona files, two scenario files, package script, and `.homun/` ignore. Raw private previews were suppressed. | passed |
| Agent evidence records actor status and materiality | Actor evidence artifacts were present for all four lanes. Manual materiality review found successful install/init/configuration proof but limited target-specific leverage. | passed |
| Meaningful-use assessment exists per lane | `repo-01`: ceremonial; `repo-02`: ceremonial; `repo-03`: useful; `repo-04`: ceremonial. | passed |
| Agent feedback is classified | Automatic feedback candidates were missing for the formal run; manual classification identified proof-path confusion. The detector was expanded locally to capture this class on future runs. | passed with local fix |
| Homun-owned blockers are fixed or ticketed | Local branch fixes issue #86 install behavior, removes private fixture labels, strengthens app-url guidance/prompts, and expands feedback detection. Issue #88 tracks provider cleanup receipts and meaningful-use scoring. | passed |
| Relevant tests and release gates run before merge/release claims | Focused tests passed before this audit. Final `pnpm release:check` passed after this audit file was added. | passed |
| Provider cleanup after live run is recorded | Provider readback found four running Homun meta-lab sandboxes after the formal run; cleanup killed `4/4`; follow-up readback found zero running. | passed |
| Completion audit maps every invariant | This file is the invariant map and is paired with final local release gate output. | passed |

## Lane Quality Summary

The formal run proved that the four-lane private-repo dogfood harness can
install/configure Homun, start target apps, collect nested Observer evidence,
verify artifacts, and clean up providers without committing private labels or
raw private evidence.

The run did not yet prove consistently high-leverage user-study behavior.
Three lanes were mostly setup/Observer proof. One lane showed target-specific
configuration work. That is useful evidence: Homun can reach the projects,
but agent instructions and telemetry still need to push actors from setup
success toward product-specific persona/scenario leverage.

## Public-Safety Review

Committed receipts intentionally exclude:

- private repo names;
- private screenshots;
- raw private source snippets;
- raw actor transcripts;
- provider stream URLs;
- sandbox IDs;
- provider account identifiers;
- token values;
- PII, PHI, or keys.

The branch also replaces a previously tracked private test fixture slug with a
synthetic fixture label.

An independent public-safety review also found historical recursive-proof
receipts with real-looking provider sandbox IDs. This branch redacts those
handles and adds a public-surface scanner rule for sandbox-ID contexts.

## Post-Audit Shipping Chores

At audit time, the goal invariants were mapped and local release gates passed.
The remaining work is normal shipping hygiene outside the invariant map:

- open a PR, let CI prove the branch, and merge only if checks remain green;
- close or update issue #86 once the install-path fix is merged.
