# Current Goals

Status date: 2026-09-10. Published baseline: `0.86.1`.

This page guides work on current merged source. Published behavior is described
in the [release notes](../release/0.86.1-task-preflight-saved-recordings.md).
The [September 9 history](https://github.com/danielgwilson/humanish/blob/main/docs/goals/current-history-2026-09-09.md)
preserves the former status log; its queues do not supersede this page.

## North Star

Humanish should let a maintainer ask:

> What happens when synthetic personas try to use this app, CLI, or
> agent-facing workflow?

The answer should be observable, verifiable, public-safe, and useful for
making a repair. The working loop is:

```text
study → recorded evidence → verify → feedback → repair → comparable rerun
```

The run bundle is the source of truth; Observer is its review surface. Keep
product-specific tasks, state checks and vocabulary in adapters, with generic
execution, evidence and lifecycle primitives in core.

## The Three Roles

Check changes against the [researcher, stakeholder and participant](../principles/three-roles.md):

- The researcher declares the study, tasks, hidden success criteria, panel and
  budgets. Supported routes return observation-backed task outcomes.
- The stakeholder needs inspectable moments, findings and denominators, with
  evidence quality separate from participant success.
- The participant receives a goal and behavioral constraints. They may finish,
  abandon, encounter a blocker or be interrupted; these outcomes must remain
  distinct from failures of the harness.

A participant does not see their hidden success criteria. Missing observation
inputs remain unmeasured. Provider and session limits are safeguards, and a
limit ending a session must not be presented as natural completion.

## The Next Outcome To Establish

An independent maintainer uses the published package on their own app,
adjudicates a useful finding, makes a repair and retains a comparable rerun.
Voluntary repeat use is the next adoption signal to establish.

Measure the effort and decisions in that loop:

- setup effort and interventions needed to obtain a usable recording;
- findings confirmed, dismissed or left uncertain after evidence review;
- accepted repair decisions and the results of comparable reruns;
- whether the maintainer chooses to use Humanish again.

Prioritize work that changes one of those outcomes. Fix a reproduced first-use
failure or evidence-review obstacle before expanding the platform. Use actual
recordings to check whether people can identify what happened, find the
relevant capture and understand the limits of the evidence.

The [own-app guide](https://humanish.dev/docs/your-app) and
[TodoMVC repair study](https://humanish.dev/docs/todomvc-edit-study) provide
starting points. Named public applications in study receipts are subjects,
not adopters or endorsements. An invitation is not activation.

## What The Evidence Establishes

- A keyless `first-run` is a contract and review preview. It does not establish
  live execution, app findings or independent use.
- Kept live studies establish the behavior observed on their named subjects,
  versions, tasks and actors. Preserve interruptions and unsuccessful attempts
  alongside successful ones.
- The [TodoMVC repair comparison](https://github.com/danielgwilson/humanish/blob/main/docs/goals/computer-use-actor/receipts/todomvc-edit-confirmation-2026-09-05.md)
  supports one synthetic keyboard repair result; it does not estimate human
  completion rates or general defect recall.
- The [evidence/export workflow receipt](https://github.com/danielgwilson/humanish/blob/main/docs/goals/computer-use-actor/receipts/redacted-evidence-workflow-2026-09-07.md)
  establishes readable originals and verified shareable derivatives on retained
  runs. External maintainer acceptance remains a separate gate.
- Explicit keyboard/pointer contrasts do not isolate the value of rich persona
  prompting. Matched comparisons need the same tasks, model, budgets and source
  conditions, with validated findings and adjudication effort measured. See
  [actor fidelity](../principles/actor-fidelity.md) for claim boundaries.

Capability proof also differs from replacing an adopter's bespoke harness.
The [proof roadmap](https://github.com/danielgwilson/humanish/blob/main/docs/goals/proof-roadmap/README.md)
requires decision-equivalent retained evidence and a real deletion branch;
that gate has not been satisfied by a public demonstration alone.

## Current Capabilities And Boundaries

| Surface | Available in merged source | Remaining boundary |
| --- | --- | --- |
| Study authoring | YAML labs, lane/roster composition, model settings and study/per-lane caps | Route support varies; declarations are not promises of engine parity |
| Actors | Seven first-party descriptors; computer-use, scripted-browser and terminal-product dispatch | No supported public out-of-tree actor-registration API |
| Subjects | `this-repo`, `clone`, `app-url`, `local-app`, `terminal-product`, `desktop-cli`, `local-tree` | `this-repo` is dry-run-only; `local-app` needs a caller-supplied executor/provider |
| Task protocol | Hidden criteria and per-task outcomes on supported per-lane CUA paths, including local-agent and desktop-cli | Shared-world, terminal-product, scripted and synthetic routes reject `tasks` before execution |
| Shared state | Sequential and concurrent single-origin shared-world studies with retained evidence | Multi-origin implementation remains gated; concurrent state change does not establish per-action causation |
| Observer | Live/recorded views, participant assignments, action-specific links, saved moments, zoom, comparison and phone-width review | Sparse captures cannot prove every action's effect; visual comparison alone is not a controlled experiment |
| Review and feedback | Verification grades, feedback drafts, portable HTML and redacted bundle derivatives | Sharing requires the appropriate grade; generated findings still need adjudication |
| TUI and serving | Detached starts, run stopping, reclamation, Observer attachment, loopback serving and run library | Stopping a process does not itself prove sandbox cleanup; TUI views over CLI `stats`/`export` remain follow-ups |
| Off-app communication | In-sandbox email/SMS catch and digest-only thread evidence | This does not establish real-provider delivery |
| Mobile and media | Hosted viewport/emulation, desktop geometry checks, bounded dwell and declared camera feed | Physical-device and touch fidelity remain unproven; unsupported microphone declarations are rejected |

Use the [task support matrix](../architecture/task-protocol-support.md),
[actor registry](https://github.com/danielgwilson/humanish/blob/main/src/actor-registry.ts)
and [CLI reference](https://humanish.dev/docs/cli) when choosing a concrete path.
Source behavior and required tests outrank stale status prose.

## Gates And Deferred Work

- Live OSS meta-lab execution remains disabled until repository-derived
  instructions have an isolated credential boundary. Its dry-run and separate
  disposable smoke harness do not open that gate.
- [Multi-origin shared-world work](https://github.com/danielgwilson/humanish/issues/239)
  needs a real adopter's cross-origin requirement and a reviewed implementation
  packet. The ratified design is not implementation authority.
- [Nested provider grants](https://github.com/danielgwilson/humanish/pull/534)
  remain unmerged. Do not assume a nested provider-credential channel exists.
- Paused adopter-deletion work stays paused until its current readiness and
  maintainer decisions permit it. Do not resume it from the historical queue.
- Broader actor/plugin APIs, additional media, registry promotion and TUI
  expansion are follow-ups, not substitutes for a useful maintainer workflow.
  A concrete use case and current issue readiness determine when to take them up.

## Safety And Autonomous Work

Follow [AGENTS.md](../../AGENTS.md), the [invariants](../principles/invariants-and-defaults.md)
and the [public-readiness standard](../release/public-readiness-standard.md).

- Keep `main` clean and work on scoped branches/worktrees. Substantial work
  needs an issue with scope, authority, required proof and stop conditions.
- Existing explicit shipping authority governs implementation and merge;
  otherwise issue readiness does not create authority by itself.
- Never commit secrets, private transcripts/screenshots, customer data or
  private project context. Keep generated proof in ignored `.humanish/` and
  retain needed evidence before removing a worktree.
- Managed paths bind to validated filesystem identities. Stored provider IDs
  are evidence, not cleanup authority; reclaim only resources the operation is
  authorized to own, and keep unknown cleanup explicitly unresolved.
- Verification distinguishes `share_ready`, `local_only` and `blocked`.
  Feedback drafts do not mutate GitHub by default. Live spend, publishing,
  external mutation and broader credential access are explicit choices.
- Provider credential placement is route-specific. The computer-use model key stays
  on the host; the default terminal runtime uses command-scoped credentials. Do not infer safety from an unqualified “keys stay outside” claim.

## Proof Before Shipping

From a clean contributor worktree:

```bash
pnpm install --frozen-lockfile
pnpm release:check
pnpm docs:check
git diff --check
```

For Observer changes, build before its tests and inspect real bundle data at
390px and desktop width. Run `pnpm --filter humanish-observer test` and
`pnpm observer:browser:proof`; preserve the source and limits of each receipt.
For website changes, run site typecheck, build and `registry:check`.
Required CI remains the merge gate.

Before a release, follow the [release procedure](../release/open-source-readiness.md),
including the candidate-package `pnpm release:dogfood` study with authorized
credentials and bounded paid spend. A successful build alone is not participant
proof. Verify the published package and any changed publishing surface.

A disposable, keyless consumer check is:

```bash
npm i -D humanish
npx humanish init --yes
npx humanish run first-run --json
npx humanish verify --run latest --json
npx humanish feedback issue --run latest --repo owner/repo --format markdown
```

This checks installation, preview evidence and feedback generation. A live
claim needs actual participant execution, retained evidence and verified
cleanup. Use N > 1 where the claim needs replication; report cost estimates,
unknowns and failures without turning them into zeros or successes.

Start from the [ramp](../ramp/README.md), choose one changed user outcome, and
close work with what changed, what was checked and what remains uncertain.
