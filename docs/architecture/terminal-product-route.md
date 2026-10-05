# Terminal-product route

The live terminal-product route has shipped since `0.8.0`, with the in-sandbox runtime,
explicit credential placement (an E2B egress proxy by default, or command-scoped), exact-id cleanup proof, an interventions ledger, a cost and
no-spend ledger, caps, and product scoring and feedback hooks. The
[original plan](https://github.com/danielgwilson/humanish/blob/main/docs/history/goals/terminal-product-lane/goal.md)
holds the build order and the safety contract.

## What this is

A study route for **terminal-product real-agent studies**: a real autonomous coding
agent (Codex) discovering and using a CLI/product from its **public surfaces
only**, running **inside an E2B shell** with declared runtime-auth placement and
spend/time caps, emitting durable terminal/substrate/cost/no-spend/cleanup/
intervention proof that verifies fail-closed. This is distinct from the browser
routes. It tests whether an autonomous agent can discover and use a CLI/product
surface from public materials. It does not test whether a browser can click a
local web app.

It follows the pattern the scripted-browser and local-app routes added: a new
`subject.source` × `execution.target` pairing, a `terminal` case in `routeOf(config)`
and its dispatch, a registered actor that declares the run kind in its capabilities,
fail-closed cross-validation, and forward-declared warnings.

## The composition

| Axis                              | Value                                                                                                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subject.source`                  | `terminal-product`                                                                                                                                    |
| `subject.product`                 | `{ name, publicSurfaces[], install?, workdir?, upload? }`: the only world the agent sees                                                              |
| `execution.target`                | `e2b-terminal` (or absent → implied)                                                                                                                  |
| `execution.terminal`              | `{ transport: exec-stream, stdin: disabled }`                                                                                                         |
| `execution.runtimeAuth`           | `openai-egress` (default) or opt-in `openai-env`; names-only durable evidence                                                                         |
| `execution.runtime.version`       | Optional exact `@openai/codex` version; observed before keyed execution                                                                               |
| `actor.model` / `reasoningEffort` | Passed to Codex as `--model` (default `gpt-5.6-sol`) and `-c model_reasoning_effort`; declarations, not observed provider identity                    |
| `caps`                            | `{ maxUsd, maxJobs, maxMinutes }`: the blast-radius budget; `maxUsd > 0` is refused: no adopter cost source exists until issue 347 lands              |
| `policies`                        | `allowPrivateRepoAccess` / `allowProviderCredentials` / `allowPaymentCredentials` / `allowGitHubMutation`, all default false                          |
| `actor.type`                      | `codex-exec`: a registered terminal actor (`keyPlacement: in-sandbox-command-scoped`)                                                                 |
| route                             | `terminal` → `admitTerminalPlan` ([`src/routes/terminal/route.ts`](https://github.com/danielgwilson/humanish/blob/main/src/routes/terminal/route.ts)) |

Routing is `routeOf` (`src/study/plan.ts`). It sends every `terminal-product` subject to
this route, even with an unregistered actor, so this route refuses the actor.
`isTerminalProductComposition(config)` (`src/study/routing.ts`) also feeds the forward-declared
warnings.

## Repeating a terminal study with the same runtime

```yaml
actor:
  type: codex-exec
  model: gpt-5.6-sol
  reasoningEffort: low
execution:
  target: e2b-terminal
  runtime:
    version: 0.153.3
```

An explicit version must be exact semver; tags, ranges, URLs, and extra runtime
fields fail at parsing. Before the keyed actor command, humanish runs an unkeyed
`npx @openai/codex@<selector> --version` command with a 60-second deadline.
A malformed result, nonzero exit, or requested/observed mismatch fails the participant
and reclaims its owned sandbox. When the version is omitted, the probe resolves
`latest` once and execution uses the exact version it reported.

`actor.json`, the bundle's terminal actor, and `terminal-ledgers.json` retain
`humanish.actor-runtime.v1`: requested and observed versions, verification status,
the requested model and where it came from, declared effort, and the usage granularity.
The observed executable version also appears as `providerVersion`.

Codex's `--json` stream does not name the model it used, and its built-in default can change
with any release. So the route always passes `--model`: the study's `actor.model`
(`modelStatus: declared`), or humanish's participant default `gpt-5.6-sol`
(`modelStatus: humanish_default`). Bundles written before 0.107.0 record
`runtime_default_unobserved` with no requested model.
Dry runs record declarations only, in a `terminal-lab.runtime.declared` event.

These settings make a study's request reproducible, but do not attest the actual
provider model or add a provider spending limit. humanish prices the agent's tokens from the
requested model. Codex `turn.completed` usage sums every request in a turn, so no request's own
size is known and no per-request long-context tier can be applied. The estimate prices every token
at the base tier, with cached input at the cached rate, and says so with
`basis: aggregated_turns_base_rate`. It is an estimate, not a measurement. The cost ledger
checked against `caps.maxUsd` keeps the provider line unmeasured, and the studied
product's no-spend boundary still needs separate interpretation.

## Runtime auth: raw-key placement and remaining provider access

`execution.runtimeAuth: openai-egress` is the default: a study that declares no
`runtimeAuth` keeps the raw key outside the sandbox, as if it declared:

```yaml
execution:
  target: e2b-terminal
  runtimeAuth: openai-egress
  terminal:
    transport: exec-stream
    stdin: disabled
```

`openai-egress` resolves the same host key (`CODEX_API_KEY` first, otherwise
`OPENAI_API_KEY`) and supplies it only to E2B's host-side network rule for
`api.openai.com`. The rule sets the HTTPS `Authorization` header. The sandbox's
Codex command receives the nonsecret value `humanish-egress-auth-placeholder`
under `CODEX_API_KEY`, plus `CODEX_CA_CERTIFICATE` pointing at E2B's existing
system CA bundle (`/etc/ssl/certs/ca-certificates.crt`) so TLS verification trusts
the platform's proxy CA. humanish does not disable TLS verification or download
an unauthenticated CA. The sandbox receives no raw runtime key in command env, sandbox env,
files, metadata, or captured evidence. The host still scrubs the actual key from
output and errors, including errors during sandbox creation.

This mode supports the default OpenAI endpoint only. humanish explicitly sets Codex's
built-in `openai` provider and `openai_base_url` to `https://api.openai.com/v1` for
that invocation. It does not support a custom provider, proxy base URL, or regional
endpoint under this mode; a study that needs one declares `openai-env`. E2B
header rules are a public-beta capability;
`tests/routes/terminal/runtime-auth.test.ts` checks the local contract against the
installed Desktop SDK (the lockfile has `@e2b/desktop` 2.4.0, resolving `e2b` 2.49.0).

**The sandbox still has a spendable OpenAI proxy capability.** Every process can
make authenticated requests to that host from sandbox creation until teardown,
including bootstrap/setup commands and commands launched outside Codex. Calls
made outside Codex may be absent from its usage ledger. This mode does not impose
a provider-side spending limit, restrict models/API paths, or make
`caps.maxUsd` a preventive provider budget. A hard provider budget needs
a separately enforced control; do not infer zero spend from an unmeasured ledger
line.

Public internet discovery stays unrestricted unless the study already declares
`execution.egressAllow`. The mode preserves that allowlist and its deny-all
fallback without adding hosts. If an allowlist omits `api.openai.com`, provider
requests can fail. E2B domain allowlists are routing controls rather than strict
destination isolation on shared infrastructure. An existing exact OpenAI host
rule is rejected instead of silently overwritten.

`execution.runtimeAuth: openai-env` is the opt-in alternative. It supplies
`CODEX_API_KEY` command-scoped to Codex, with `OPENAI_API_KEY` also supplied when
that was the host source. Child processes can read and use the raw key, and so can
anything the agent runs or a page it reads asks it to run.

Evidence records the selected auth mode and the residual proxy capability.
Resolved live actor traces use `keyPlacement: external` in `openai-egress`; the
actor registry continues to describe the default `in-sandbox-command-scoped`
placement. Dry runs record declarations and prove no live proxy behavior.

The upstream contracts are documented in [E2B internet access and network
rules](https://docs.e2b.dev/network/internet-access) and [Codex advanced
configuration](https://developers.openai.com/codex/config-advanced),
[Codex custom CA bundles](https://developers.openai.com/codex/auth#custom-ca-bundles),
and [E2B's CA installer](https://github.com/e2b-dev/infra/blob/main/packages/envd/internal/host/cacerts.go).
E2B's installed
SDK documents that transformed headers override request headers. Deterministic
request/redaction tests do not establish live wire behavior. The [2026-09-05
transport receipt](https://github.com/danielgwilson/humanish/blob/main/docs/evidence/terminal-product/2026-09-05-runtime-egress-auth.md)
records the controlled live header/auth checks and their scope.

## Runtime prerequisite

The terminal route reuses a working Node >=20 and npm from the calling shell.
Otherwise it installs the pinned official Node 22.23.2 Linux x64 or arm64 archive,
downloaded over verified HTTPS and checked against an architecture-specific
SHA256 committed in the bootstrap. It does not refresh apt repositories or fetch
an unpinned checksum beside the archive. Node 22 is a supported LTS line on the
[official release schedule](https://nodejs.org/en/about/previous-releases); the
trusted hashes come from its [release manifest](https://nodejs.org/dist/v22.23.2/SHASUMS256.txt).

Installation requires `curl`, `sha256sum`, `tar`, `gzip`, `mktemp`, and passwordless
`sudo`. Only a verified archive is extracted into a root-owned versioned directory
under `/opt/humanish`; `/usr/local/bin` links make Node/npm/npx available to later
shells. In that new distribution only, a missing built-in npm `prefix` defaults
to `/usr/local`, so global product executables use the existing PATH. Existing
distribution settings and higher-priority npm overrides are preserved; an adopter
override can still choose a bin directory outside PATH. The installer changes no
user/global npm configuration, global permissions, or shell startup files. It
checks Node/npm in both ordinary and sudo shells after installation. The existing
runtime fast path preserves user-specific installations; a later sudo product
install can still fail if that installation is absent from sudo's PATH.

The [global executable receipt](https://github.com/danielgwilson/humanish/blob/main/docs/evidence/terminal-product/2026-09-05-global-npm-prefix.md)
records the regression found after the initial runtime-only proof and its stock
desktop checks. npm documents [global executable locations](https://docs.npmjs.com/cli/v10/configuring-npm/folders#executables)
and the [distribution built-in configuration](https://docs.npmjs.com/cli/v10/configuring-npm/npmrc#built-in-config-file).

An egress allowlist must permit `nodejs.org` if the runtime needs installation,
as well as the registries and product surfaces the study uses. Missing tools,
unsupported architectures, a failed download or checksum, and a failed runtime
check stop the participant before Codex. Downloads have finite connection, transfer, and
retry bounds within the existing five-minute bootstrap deadline.

The `desktop-cli` computer-use route uses this same Node/npm prerequisite when
`subject.product.install` is omitted or declares a Node command. With install omitted,
the participant arrives at an open terminal with Node/npm available; the product
remains uninstalled for them to discover and install from its public surfaces. Runtime
setup runs unkeyed and a failed bootstrap stops before the participant starts. A
declared non-Node install keeps its existing runtime behavior. The desktop route's
runtime step has the same five-minute bootstrap deadline (`NODE_BOOTSTRAP_TIMEOUT_MS`,
`src/subject/node-bootstrap.ts`); a declared install step keeps its ten-minute
deadline.

## The original command-scoped safety contract

The `openai-env` mode **inverts** the credential-placement default of every other E2B route.
On the computer-use route the model's key stays _outside_ the sandbox; under `openai-env` the
agent-under-test runs _inside_ with a real `OPENAI_API_KEY`/`CODEX_API_KEY` and is **presumed
exfiltratable**. The placement rule in invariants-and-defaults.md
applies: _keys live where the keyed process runs, and nowhere else;
blast radius is bounded by key scoping and budgets, not by hoping._

The inversion is declared as registry metadata, not a code convention: the
terminal actor's capabilities carry `keyPlacement: "in-sandbox-command-scoped"`.
The route keys off that capability and injects the key only into the per-command
`envs` of the `codex` invocation, never `Sandbox.create({envs})`. The route also
has a deny-by-default credential allowlist, positive-allowlist sandbox metadata,
the cleanup proof, the interventions ledger and a minimal fail-closed cap.

## Test seams

The route reads `env` and `scorer` from its options (`src/routes/terminal/types.ts`), and a test
passes its seams (`desktopModule`, `renderObserver`, `now`, `costProbe`) as `StudyDeps`
(`src/study/study-deps.ts`).

## The product-adapter extension seam

An adopter attaches product-specific scoring and feedback as a thin in-repo extension, without
forking core. Core ships the seam and no built-in product scorer; the adopter's scorecard lives in
the adopter's repo:

- **Exported contract types** a thin adapter types against from the package barrel
  (`humanish`) alone, never through a deep `src/` import: `RunBundle`,
  `RunFeedbackCandidate`, `RunAdapterScore`, `RunAdapterArtifact`, `ActorTrace`,
  `AdapterScorerModule` and `TerminalProductScoringContext`. The ledger, cost and
  no-spend shapes are reached through that context's fields, as
  `TerminalProductScoringContext["ledgers"]`.
- **A registrable scorer / feedback module**, `RunStudyOptions.scorer` (an
  `AdapterScorerModule`): `score?(ctx) => RunAdapterScore | Promise<…>` and
  `deriveFeedback?(ctx) => RunFeedbackCandidate[] | Promise<…>`, where this route's
  `ctx` is a `TerminalProductScoringContext`. The older `terminalHooks.score` and
  `terminalHooks.deriveFeedback` were removed with the bag. The route calls the
  hooks over the fully-assembled, redacted evidence and attaches the results
  (`bundle.adapterScore`, appended `bundle.feedbackCandidates`) without core knowing
  any product noun. Default (no hook) behavior is unchanged: the mission-based verdict
  stands alone.
- **Adapter-namespaced product nouns.** Product-specific concepts (public
  CLI/product command observed, hosted product success-or-blocker, feedback
  id/draft, media/job/asset ids, no-media/no-provider-spend proof,
  defection/friction risk) ride only under a single namespaced field
  (`RunFeedbackCandidate.adapter: { namespace, data }` and
  `RunAdapterScore.{namespace, data}`) so core's enums stay product-agnostic and
  a future inert-field audit never misfires. No adopter noun is hardcoded into a
  core enum (avoiding closed-taxonomy rot); `e2b-terminal` is added to the
  substrate enum so a terminal-agent candidate names the substrate it ran on.

The seam is fail-closed: the route scrubs+redacts the returned payloads and drops
any malformed score/candidate with a warning, and `verifyRun` re-checks the
surviving shapes, so a bad extension never poisons a verifiable bundle. Proven by
`tests/routes/terminal/product-adapter-seam.test.ts` (a thin in-repo example adapter
typing against the barrel only, registering a scorer, attaching namespaced nouns,
emitting a candidate; the bundle verifies). That test is a contract proof; the
live end-to-end route receipt is linked from the status note.

The adopter's real scorecard is its own thin extension. The end-to-end route's
live receipt is kept under the terminal-product goal. Duplex PTY replay is not
built.

## The reference adopter (codename-neutral)

The requesting adopter is a public creative-CLI product. Committed source and docs here
stay codename-neutral per the public-surface scan; the committed CI fixture
([`humanish/studies/terminal-product-demo.yaml`](https://github.com/danielgwilson/humanish/blob/main/humanish/studies/terminal-product-demo.yaml))
uses a fictional mock CLI (`widgetsmith-cli`) with `example.com` surfaces. The adopter's
real public surfaces appear only in operator-run docs and a GitHub issue, never in
scanned committed text.
