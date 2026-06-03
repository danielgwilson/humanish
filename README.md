# mimetic-cli

Open-source-safe persona simulation for apps, CLIs, and agent-facing product
flows.

Mimetic gives a project a repeatable way to ask: what happens when realistic
synthetic users, with different goals and tolerances, try to use this thing?
It creates committed simulation source under `mimetic/`, ignored run evidence
under `.mimetic/`, a watchable Observer UI, verification gates, and public-safe
feedback drafts.

![Mimetic Observer mission control: synthetic personas attempting first-run setup across browser, CLI, TUI, and Codex lanes, with blocked and failed lanes surfaced for review](https://unpkg.com/mimetic-cli@latest/docs/assets/mimetic-oss-lab-observer.png?v=0.1.4)

## Install

```bash
npm i -D mimetic-cli
npx mimetic init --yes
npx mimetic watch
```

For coding agents, install the repo skill first:

```bash
npx skills add danielgwilson/mimetic-cli --skill mimetic-cli
```

The skill lives at [`skills/mimetic-cli/SKILL.md`](skills/mimetic-cli/SKILL.md)
for skills.sh discovery.

## Public-Safety Boundary

Mimetic is designed for public repositories and public issue queues.

Do not commit, emit, paste, preserve, or generate PII, PHI, secrets, keys,
tokens, raw private transcripts, private screenshots, private customer data,
private patient data, or private source snippets.

Use synthetic personas, synthetic examples, redacted evidence pointers, and
env var names without values. Generated run bundles belong under ignored
`.mimetic/`.

## How It Works

```text
mimetic/      committed source plane: personas, scenarios, policy, adapters
.mimetic/    ignored runtime plane: runs, Observer output, reviews, local state
```

The first-run path does not require credentials:

```bash
npx mimetic doctor
npx mimetic watch
npx mimetic verify --run latest --json
npx mimetic feedback issue --run latest --repo owner/repo --format markdown
```

`mimetic watch` starts a fresh four-lane synthetic run, renders the Observer,
opens it in the browser, serves it over localhost, and keeps the shell attached.
The CI-safe equivalent is:

```bash
npx mimetic watch --json --no-open
```

## Commands

| Command | Purpose |
| --- | --- |
| `mimetic init` | Scaffold committed `mimetic/` source and ignored `.mimetic/` runtime state. |
| `mimetic doctor` | Explain readiness and missing setup. |
| `mimetic run --dry-run` | Generate a synthetic run bundle without browser, keys, or provider spend. |
| `mimetic watch` | Run sims, open Observer, and keep watching. |
| `mimetic verify` | Validate a run bundle and public-safety gates. |
| `mimetic review` | Read review evidence for a run. |
| `mimetic runs` | List local runs and latest pointers. |
| `mimetic feedback issue` | Print a public-safe GitHub issue draft without API mutation. |
| `mimetic lab oss` | Experimental Observer-of-Observers for headed authorized-repo app setup attempts. |
| `mimetic lab oss-smoke` | Disposable clone smoke test against public OSS repos. |

## OSS Lab

The experimental authorized-repo dogfood loop is:

```bash
pnpm mimetic -- lab oss
pnpm mimetic -- lab oss --repos developit/mitt,lukeed/clsx,sindresorhus/is-plain-obj,ai/nanoid
```

With `E2B_API_KEY` and `OPENAI_API_KEY` present, Mimetic launches headed E2B
desktop lanes, uploads the local package tarball, clones each assigned
repository inside the sandbox, initializes Mimetic, runs nested proof commands,
starts the target app when a runnable script is present, opens desktop/mobile
app windows plus the nested Observer in the sandbox browser, and starts a
nonblocking Codex actor attempt.
Install the optional desktop substrate first:

```bash
npm i -D @e2b/desktop
```

The contract-safe path for agents and CI is:

```bash
pnpm mimetic -- lab oss --dry-run --json --no-open
```

`mimetic lab oss` accepts GitHub `owner/repo` slugs. Private repositories are
maintainer-only and require an authorized `GH_TOKEN` or `GITHUB_TOKEN` in the
runtime environment. When a GitHub token is present, durable run artifacts
redact repo labels by default; pass `--no-redact-repos` only for public-safe
repo selections. Live E2B stream URLs are runtime-only for the attached
Observer server and are not persisted to `run.json` or `observer-data.json`.
Local bundles remain ignored under `.mimetic/`; do not publish private
screenshots, logs, or upstream details.

## Development

```bash
pnpm install
pnpm check
pnpm public-surface:scan
pnpm pack:dry-run
```

Local dogfood:

```bash
pnpm mimetic:watch
pnpm mimetic:verify
pnpm mimetic:feedback
```

## Docs

- [Ramp for future contributors and agents](docs/ramp/README.md)
- [Current goals](docs/goals/current.md)
- [Project layout](docs/architecture/project-layout.md)
- [Observer architecture](docs/architecture/observer.md)
- [OSS lab POC](docs/architecture/oss-lab-poc.md)
- [Feedback contract](docs/contracts/feedback.md)
- [Open-source install experience](docs/product/open-source-install-experience.md)
- [Self-driving harness principles](docs/principles/self-driving-harness.md)
- [World-class open-source v0 roadmap](docs/roadmap/world-class-open-source-v0.md)
- [Open-source release readiness](docs/release/open-source-readiness.md)
- [Public readiness standard](docs/release/public-readiness-standard.md)

## Release Status

This package is prepared for public npm packaging, but publication is still a
human release action. Do not run `npm publish` unless the maintainer explicitly
approves it in the current context.
