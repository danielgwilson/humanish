# Homun Ramp

Status: public-safe contributor and agent ramp.

Use this page when you are starting cold on `homun`. It is meant to be
useful without chat history, private notes, local machine paths, or maintainer
context.

## First Read

Read these in order:

1. [`AGENTS.md`](../../AGENTS.md) for public boundary and engineering rules.
2. [`docs/principles/invariants-and-defaults.md`](../principles/invariants-and-defaults.md) — the constitution: which rules are invariants and which are overridable defaults.
3. [`README.md`](../../README.md) for install, commands, and package shape.
4. [`docs/goals/current.md`](../goals/current.md) for the active product goal.
5. [`docs/goals/proof-roadmap/goal.md`](https://github.com/danielgwilson/homun/blob/main/docs/goals/proof-roadmap/goal.md) for the ratified proof architecture (repo-only; not shipped in the npm package, hence the absolute link).
6. [`docs/product/open-source-install-experience.md`](../product/open-source-install-experience.md) for first-run UX.
7. [`docs/roadmap/world-class-open-source-v0.md`](../roadmap/world-class-open-source-v0.md) for staged delivery history (historical; see its status banner).
8. [`docs/architecture/observer.md`](../architecture/observer.md) for Observer architecture.
9. [`docs/contracts/run-bundle.md`](../contracts/run-bundle.md) and [`docs/contracts/policy.md`](../contracts/policy.md) for proof contracts.
10. [`docs/release/public-readiness-standard.md`](../release/public-readiness-standard.md) before deciding what must be scrubbed.
11. [`docs/release/open-source-readiness.md`](../release/open-source-readiness.md) before touching public packaging or repository visibility.

## Mental Model

Homun is a persona simulation harness for apps, CLIs, and agent-facing product
flows.

- `homun/` is committed source: personas, scenarios, policy, adapters, and
  lab manifests.
- `.homun/` is ignored runtime state: runs, Observer output, transcripts,
  reviews, temporary clones, and local evidence.
- Homun source uses `.yaml` for human-authored simulation intent, `.ts` for
  executable integration, and JSON/NDJSON for generated artifacts.
- A run bundle is the source of truth.
- The Observer is the projection that makes that truth reviewable.
- Feedback commands turn verified evidence into public-safe issue drafts.

If a change does not improve one of those loops, it probably belongs elsewhere.

## Current State

Homun has a working public package shape and a safe first-run path:

```bash
pnpm install --frozen-lockfile
pnpm release:check
pnpm homun -- watch --json --no-open
pnpm homun -- verify --run latest --json
```

Implemented:

- `commander` CLI with stable command help;
- `init`, `doctor`, `run`, `watch`, `verify`, `review`, `runs`, and `feedback`;
- synthetic run bundles;
- public-safety verification with machine-readable `shareSafety.status`
  (`share_ready`, `local_only`, or `blocked`);
- mission-control Observer over UI, CLI, TUI, and Codex UI stream contracts;
- public-safe feedback issue drafts without GitHub API mutation, gated on
  `share_ready` evidence;
- skills.sh-compatible agent skill;
- first-class lab manifest resolution through `homun/labs/*.yaml` and
  ignored `.homun/labs/*.yaml` overlays — `homun.lab.v2` compositions
  (`src/lab-config.ts`), one engine, no hardcoded lab kinds;
- a pluggable actor registry with four registered actors
  (`src/actor-registry.ts`); on the computer-use routes `actors[0].type` is a
  real dispatch key;
- a computer-use route and clone subject provider: `subject.source: app-url`
  drives a lab-owner loopback app in a hosted desktop, and `subject.source:
  clone` + `serve` clones, installs, and serves a real app in-sandbox from
  config before the actor drives it (`src/cua-actor-lab.ts`);
- experimental maintainer OSS meta-lab and disposable OSS smoke harness;
- OSS dogfood setup-quality filesystem artifacts rendered from the Observer Files
  tab with private-run previews suppressed by default.

Still not good enough:

- live `--app-url` browser proof now supports app-specific executable
  `browser.steps` in `homun/scenarios/*.yaml`, with headed provider-backed
  public proof against two app/tool targets;
- live PTY and Codex UI lanes need stronger completion health;
- OSS lab lanes can report nested Observer health, target app readiness, actor
  evidence, setup-quality filesystem checks, and nested browser step summaries
  when a target app starts, but need repeated fresh-agent trials across more
  disposable public apps;
- Observer evidence has real screenshots/traces for browser app proof; richer
  multi-step product journeys and broader multi-persona matrices remain the next
  gap.

## First Commands

From a clean checkout:

```bash
git status --short --branch
pnpm install --frozen-lockfile
pnpm release:check
pnpm homun -- watch --json --no-open
pnpm homun -- runs --json
pnpm homun -- lab list
```

For local product feel:

```bash
pnpm homun -- watch
```

For public OSS dogfood without credentials:

```bash
pnpm homun -- lab run oss --dry-run --json --no-open
pnpm homun -- lab run oss-smoke --limit 1 --json
```

For private/local dogfood, author an ignored lab manifest under
`.homun/labs/` or `.homun/local/labs/`, then invoke it explicitly with an
ignored env file:

```bash
pnpm homun -- watch .homun/labs/local-dogfood.yaml --env-file .homun/local/provider.env
```

## How To Pick Work

Start from [`docs/goals/current.md`](../goals/current.md).

Prefer work that makes Homun more believable to a new maintainer:

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
- focused unit or contract tests;
- a generated run bundle under ignored `.homun/`;
- Observer screenshots or health output;
- `homun verify` results;
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
