# humanish Ramp

Use this page when you are starting cold on `humanish`. It is meant to be
useful without chat history, private notes, local machine paths, or maintainer
context. It is the last step of the reading order in
[CONTRIBUTING.md](../../CONTRIBUTING.md#read-these-in-order) and adds current state, how to pick
work and the quality bar.

## First Read

Start with three things:

1. The files in [CONTRIBUTING.md's reading order](../../CONTRIBUTING.md#read-these-in-order).
2. The current task and [`docs/goals/current.md`](../goals/current.md) for current
   product status. Explicit task direction takes precedence over historical queues.
3. Instructions in the component being changed, then its relevant contracts.

Use the references below as needed. Historical plans are context, not a backlog
to resume automatically. Keep one concise current task handoff with the requested
outcome, demonstrated behavior, next complete result, constraints and rejected or
deferred approaches; link evidence rather than repeating its chronology.

| When working on                            | Reference                                                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Install, commands or first-run UX          | [`README.md`](../../README.md), [install experience](../product/open-source-install-experience.md)                                                                             |
| Security, evidence handling or defaults    | [Invariants and defaults](../principles/invariants-and-defaults.md)                                                                                                            |
| Observer                                   | [Observer architecture](../architecture/observer.md) and its component instructions                                                                                            |
| Bundle formats or policy                   | [Run bundle](../contracts/run-bundle.md), [policy](../contracts/policy.md)                                                                                                     |
| Public artifacts or packaging              | [Public-readiness standard](../release/public-readiness-standard.md), [release procedure](../release/open-source-readiness.md)                                                 |
| Proof architecture or historical decisions | [Proof roadmap](https://github.com/danielgwilson/humanish/blob/main/docs/goals/proof-roadmap/goal.md), [historical delivery roadmap](../roadmap/world-class-open-source-v0.md) |

## Mental Model

humanish is a persona simulation harness for apps, CLIs, and agent-facing product
flows.

- `humanish/` is committed source: lab manifests, personas, scenarios and
  coverage notes.
- `.humanish/` is ignored runtime state: runs, Observer output, transcripts,
  reviews, temporary clones, and local evidence.
- humanish source uses `.yaml` for human-authored simulation intent and
  JSON/NDJSON for generated artifacts.
- A run bundle is the source of truth.
- The Observer is the projection that makes that truth reviewable.
- Feedback commands turn verified evidence into public-safe issue drafts.

If a change does not improve one of those loops, it probably belongs elsewhere.

## Current State

[CHANGELOG.md](../../CHANGELOG.md) lists what each version changed. This section describes
what the source supports now.

humanish has a working public package shape and a safe first-run path.

Implemented:

- `commander` CLI with stable command help;
- `init`, `doctor`, `run`, `watch`, `verify`, `review`, `runs`, `analyze`, and `feedback`;
- study analysis with bounded provider admission, a live-run default and opt-out, immutable findings,
  source-bound corrections and evidence-linked Observer review;
- synthetic run bundles;
- public-safety verification with machine-readable `shareSafety.status`
  (`share_ready`, `local_only`, or `blocked`);
- mission-control Observer over UI, CLI, TUI, and Codex UI stream contracts;
- public-safe feedback issue drafts without GitHub API mutation, gated on
  `share_ready` evidence;
- skills.sh-compatible agent skill;
- first-class lab manifest resolution through `humanish/labs/*.yaml` and
  ignored `.humanish/labs/*.yaml` overlays, as `humanish.lab.v2` compositions
  (`src/lab/config.ts`) with one engine and no hardcoded lab kinds;
- a first-party actor registry with five registered descriptors
  (`src/actors/registry.ts`); `actors[0].type` is a real dispatch key on the
  computer-use, scripted-browser, and terminal-product routes;
- a computer-use route and clone subject provider: `subject.source: app-url`
  drives a lab-owner loopback app in a hosted desktop, and `subject.source:
clone` + `serve` clones, installs, and serves a real app in-sandbox from
  config before the actor drives it (`src/routes/computer-use/route.ts`);
- seven declared subject sources: `this-repo` (dry-run-only), `clone`, `app-url`,
  `local-app` (library-assisted, in-process, no desktop), `terminal-product`,
  `desktop-cli` (computer-use participant at a terminal), and `local-tree`;
  each route fails closed on unsupported combinations;
- bounded per-lane-world fan-out (`actors[0].count`, `lanes[]`, or `roster[]`),
  backed by deterministic and kept live proof;
- concurrent single-origin shared-world execution with deterministic and kept
  live proof; verify still reads bundles from the sequential route removed in
  0.106.0 (unreleased);
- `subject.source: local-tree`, which packages one selected working tree with a
  content pin before using the same provision-and-serve path as clone subjects;
- an off-app comms funnel for email-gated flows: a vendor-neutral in-sandbox
  catch redirects the app's own send API, a persona reads a minimal inbox surface
  and clicks through, and a digest-only `humanish.comms-thread.v1` artifact
  records the thread with no raw address, link, or code. It is wired into the
  computer-use and concurrent shared-world routes and live-proven on computer-use.
  SMS is not yet a configured execution route;
- resolved-persona directives that actually shape the actor prompt on the
  terminal-product route (traits are applied and recorded in the actor trace, not
  decorative), reusing the same `persona.ts` compiler as the computer-use lane;
- a CLI-loadable adopter scorer seam (`review.scorer.ref` in the lab manifest, or
  a `--scorer <path>` override): a config-declared `.mjs` supplies
  `{score, deriveFeedback, deriveArtifacts}`, resolved with the same containment
  as `scenario.ref` and digest-pinned in the bundle
  (`humanish.scorer-provenance.v1`); a config-declared scorer that fails to render
  a pass fails the run on the scorer-capable routes, while library callers keep
  the additive behavior (`costProbe` stays library-only); on the terminal route
  the scoring context carries the FULL normalized transcript (byte-identical to
  the persisted `terminal-transcript.txt`) instead of the ~2KB tail projection. The
  [scorer example](../../examples/scorer/README.md) attaches one from the CLI and from a
  library caller;
- containment checks for managed run storage, Observer and feedback reads,
  actor artifacts, lab discovery, Git metadata, and source archives;
- cleanup inspection receipts that do not treat mutable run-bundle IDs as
  provider-mutation authority;
- every route publishes through the run lifecycle (`runScope` and `Run` in
  `src/run/run.ts`): computer-use, shared-world, scripted, terminal, and the preview's
  `runDryRun`.

Still not good enough:

- capability receipts are not adopter replacement: no first-party deletion
  branch has yet removed a bespoke generic harness while preserving
  decision-equivalent proof;
- the five actor descriptors are a closed first-party union, not a supported
  out-of-tree actor-registration API;
- multi-origin shared-world is an accepted design direction, but remains
  unimplemented and gated on a real adopter proving the need;
- the README hero is the drawDB real-application study, a legible capture of a
  studied public subject (drawDB is not a humanish adopter); coverage beyond that single
  studied subject (the stratified breadth panel) remains open.

## Check which compositions a lab can declare

`parseLabConfig` (`src/lab/config.ts`) enforces this matrix through `compositionReason`
(`src/lab/composition-rules.ts`), which uses the predicates in `src/lab/routing.ts` and the reasons
in `src/lab/validation.ts`. The route entries check it again
for library callers. `tests/fixtures/task-route-preflight/labs.json` holds one lab for each
accepted row except the local browser row. `tests/lab/task-route-preflight.test.ts` checks that
each of those labs routes as shown. `tests/run-lab-local-substrate.test.ts` covers the local
browser row. Accepted rows have further required fields, such as `subject.serve` on `clone`, and
the parse error names the missing one. The computer-use actors are `openai-computer-use` and
`local-agent`.

| Route (backend name)                       | `subject.source`                                 | `execution.target`       | `actors[0].type`                       | Result                                                                         |
| ------------------------------------------ | ------------------------------------------------ | ------------------------ | -------------------------------------- | ------------------------------------------------------------------------------ |
| `computer-use` (`cua`)                     | `app-url`                                        | `e2b-desktop`            | a computer-use actor                   | Supported                                                                      |
| `computer-use` (`cua`)                     | `app-url`                                        | `local`                  | a computer-use actor                   | Supported on a local Firecracker desktop, inside Lima on macOS                 |
| `computer-use` (`cua`)                     | `clone`, `local-tree`                            | `e2b-desktop`            | a computer-use actor                   | Supported                                                                      |
| `computer-use` (`cua`)                     | `desktop-cli`                                    | `e2b-desktop` or absent  | a computer-use actor                   | Supported                                                                      |
| `computer-use` (`cua`)                     | `local-app`                                      | `local` or absent        | a computer-use actor                   | Library only; the CLI refuses it with `HUMANISH_CUA_LAB_LOCAL_APP_NO_EXECUTOR` |
| `shared-world` (`concurrent-shared-world`) | `clone`, `local-tree` + `topology: shared-world` | `e2b-desktop`            | a computer-use actor                   | Supported                                                                      |
| `shared-world` (`concurrent-shared-world`) | `app-url` + `topology: shared-world`             | `e2b-desktop`            | a computer-use actor                   | Supported with `policies.allowPublicTargets: true`                             |
| `scripted`                                 | `app-url` with a loopback URL                    | `local` or absent        | `scripted-browser`                     | Supported                                                                      |
| `scripted`                                 | `clone`                                          | `e2b-desktop`            | `scripted-browser`                     | Supported                                                                      |
| `terminal`                                 | `terminal-product`                               | `e2b-terminal` or absent | `codex-exec`                           | Supported                                                                      |
| `preview` (`synthetic`)                    | `this-repo`                                      | absent                   | not `scripted-browser` or `codex-exec` | Dry run only                                                                   |
| none                                       | any other pairing                                | any                      | any                                    | Refused at parse with `HUMANISH_LAB_INVALID`                                   |

The fixture's `supported` field records which routes accept declared `actors[0].tasks`. The
computer-use labs in the fixture accept them. The other routes refuse them at parse.

## First Commands

From a clean checkout:

```bash
git status --short --branch
pnpm install --frozen-lockfile
pnpm humanish lab list
pnpm humanish watch --json --no-open   # a keyless preview run
pnpm humanish runs --json
pnpm vitest run tests/<file>           # one test file: the fast loop
pnpm check                             # the full local gate
pnpm release:check                     # what CI runs; last, before a pull request
```

For local product feel:

```bash
pnpm humanish watch
```

For private/local dogfood, author an ignored lab manifest under
`.humanish/labs/` or `.humanish/local/labs/`, then invoke it explicitly with an
ignored env file:

```bash
pnpm humanish watch .humanish/labs/local-dogfood.yaml --env-file .humanish/local/provider.env
```

## How To Pick Work

Start from [`docs/goals/current.md`](../goals/current.md).

Prefer work that makes humanish more believable to a new maintainer:

- a command becomes easier to run;
- a run bundle becomes more truthful;
- Observer evidence becomes more inspectable;
- verification catches a real bad state;
- feedback drafts become more actionable;
- public-safety gates catch a class of leak or stale residue.

If no GitHub issue exists for substantial work, draft one with the repo issue
template before building. Use labels to communicate authority, area, risk, and
required proof.

## Quality Bar

Do not close a change on narrative alone.

Useful proof includes:

- `pnpm release:check`;
- `pnpm release:dogfood` before a tag (see below);
- focused unit or contract tests;
- a generated run bundle under ignored `.humanish/`;
- Observer screenshots or health output;
- `humanish verify` results;
- public-surface scan output;
- fresh clone checks for packaging or release work.

A green subset is not the same thing as complete coverage. If something is not
covered, name it as a gap.

## Public Boundary

Assume this repository is public even when local or remote visibility says it is
private.

Never commit or paste:

- PII or PHI;
- secrets, keys, tokens, cookies, or raw env files;
- raw private transcripts;
- private screenshots;
- private customer or patient data;
- local machine paths;
- private upstream code or operational details.

Use synthetic examples, redacted evidence, and env var names without values.

## Embarrassment Filter

Before committing, ask:

- Would this make sense to someone who found the repo through npm?
- Would I be comfortable with this file quoted in a public issue?
- Does this depend on private chat memory?
- Does it mention removed docs, private machine paths, or internal-only names?
- Does it claim product proof when it only proves a contract?

If the answer is uncomfortable, rewrite it, synthesize it, or keep it out of the
repo.

## Hand-Off Format

End substantial work with:

- what changed;
- what proof passed;
- what remains uncertain;
- the next best issue or command.

Future agents should be able to continue from the repo, not from the previous
chat transcript.

## Before you tag: send a participant to meet the build

```bash
pnpm release:dogfood     # needs OPENAI_API_KEY + E2B_API_KEY; costs about a dollar
```

`release:check` proves the code is internally consistent. It cannot tell you whether
someone landing on this build can get anywhere with it. That gap has cost a release:
`0.56.0` passed every check and shipped a regression that hid a run's
price at exactly the moment a person was deciding whether to set keys up. A
synthetic participant found it hours later.

So the last gate before a tag is the product's own first-contact study, pointed at
the release candidate. It packs the tarball, uploads it into the sandbox, and has a
real autonomous agent install that tarball. Installing `humanish@latest` instead would
measure the last release, the one artifact we already know about.

It prints the participant's report and fails the gate if they could not get there.
**Read the report even when it passes.** The verdict is a marker the participant
sets; the paragraph underneath it is the finding, and it has twice repeated an
adoption problem we already knew about in words no test could produce.

This spends money and needs keys, so it is deliberately NOT part of `release:check`
and never runs in CI. The lab's caps hold product spend to `$0`; what it costs is
the agent's own tokens and a few sandbox-minutes. The agent's model key stays outside
the sandbox in an E2B egress rule (`runtimeAuth: openai-egress`), and its `web_search`
fetches run on the model provider's side, so an error from one says nothing about the
sandbox's network.
