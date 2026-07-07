# Goal: the terminal-product real-agent lane (issue #154)

Status: ratified 2026-06-16. Decisions below come from a seven-area recon of the v0.7.0
substrate against issue #154's ten acceptance criteria and artifact-parity list, plus the
tech lead's rulings on the open questions. This packet is the ratification record and —
because this lane is the first to place a real provider key *inside* the sandbox — the
**safety contract** every slice must honor.

> Adopter naming: the requesting adopter is a public creative-CLI product (see issue #154 for
> its concrete public surfaces). Committed source/docs here stay codename-neutral per the
> public-surface scan; this doc calls it **the reference adopter**. The committed CI fixture
> uses a neutral mock CLI; the adopter's real public surfaces appear only in operator-run
> docs and the GitHub issue, never in scanned committed text.

## The ask (issue #154)

The reference adopter cannot delete its bespoke real-agent sim for homun yet. homun has
strong Observer/browser/lab primitives but no **terminal-product real-agent study lane**: a
real autonomous agent (Codex) discovering and using a CLI/product from *public surfaces
only*, running *inside* an E2B shell with command-scoped runtime auth, capped at no-spend,
and emitting durable terminal/substrate/cost/no-spend/cleanup/intervention proof that
verifies fail-closed. This is proof-roadmap **layer 6** (the extension seam + in-sandbox
command-scoped key placement) and depth-phase-2 (delete a bespoke sim for homun + a thin
adapter).

## The safety contract (every slice enforces this — by construction and by verifier)

This lane **inverts** the credential-placement default of every existing E2B route. On the
computer-use route the model's key stays *outside* the sandbox; here the agent-under-test
runs *inside* with a real `OPENAI_API_KEY`/`CODEX_API_KEY` and is **presumed
exfiltratable**. The doctrine that governs it (invariants-and-defaults.md, the placement
rule): *keys live where the keyed process runs — and nowhere else; blast radius is bounded
by key scoping and budgets, not by hoping.*

1. **Command-scoped, never sandbox-global.** Runtime auth is injected ONLY into the
   per-command `envs` of the `codex` invocation (`commands.run({envs})`), NEVER into
   `Sandbox.create({envs})` (which is sandbox-global). It is injected command-scoped **from
   the start** — never the meta-lab's inject-globally-then-unset pattern (any failure before
   the unset leaks the key). This is enforced by engine logic keyed off a registry
   `keyPlacement: "in-sandbox-command-scoped"` capability, NOT a code convention.
2. **Bounded by mechanism, not by hope.** The live key is never exercised without a
   fail-closed spend cap in force (`scenario.caps`, minimally `maxUsd: 0` + `maxMinutes`).
   The no-spend proof is **derived from a real ledger**, never asserted. SLICE 2 folds in a
   minimal fail-closed cap; SLICE 3 expands the ledger.
3. **Public surfaces only.** The agent sees only the declared `subject.product.publicSurfaces`
   and the mission. NO clone or inspection of any private/downstream repo.
4. **Deny-by-default credentials.** Only the runtime LLM key enters (command-scoped). GitHub
   write tokens, media/creative-provider keys, payment keys, deploy tokens, and database URLs
   are excluded from the sandbox by construction and their absence is verifier-checked. (This
   is net-new: the meta-lab's env allowlist is *permissive* toward `GITHUB_TOKEN` — that path
   must not be reused verbatim.)
5. **No secret values in evidence.** Every captured byte — the streamed output event stream,
   the normalized transcript, command logs, the agent report, metadata — passes
   `scrubKnownValues` (literal scrub of provisioned values) THEN `redactText` (shape patterns)
   **before persisting**. Literal scrub is necessary but not sufficient over a high-bandwidth
   agent transcript, so pattern redaction runs too, and (if a streaming transport is ever
   built) redaction happens at the source, never streaming raw bytes to a client.
6. **Metadata is a positive allowlist by construction.** A `buildSandboxMetadata(allowlist)`
   helper is the only way metadata is set; a verifier check asserts persisted metadata carries
   no prompts/tokens/user-data/secret shapes.
7. **stdin disabled by default; interventions are first-class.** The terminal runs with stdin
   disabled. The bundle always carries an interventions ledger (empty is valid). If assisted
   input is ever enabled, every event is persisted as an intervention and the run is marked
   `comparableToAutonomousBaseline: false`. Shipping an assisted path before the ledger + flag
   + verify check exist is forbidden (it would let an assisted run masquerade as autonomous
   green proof).
8. **Cleanup is proven.** The sandbox is killed in a finally; a cleanup proof (kill +
   re-list-remaining == 0) is persisted, and a live run that cannot prove teardown fails
   closed.

## Tech-lead rulings on the recon's open questions

- **PTY fidelity:** capture a genuine *streamed* (via `commands.run` `onStdout`/`onStderr`
  callbacks), redacted, append-only output **event stream** (NDJSON) + a normalized
  transcript. stdin is disabled, so this is a non-interactive captured stream — labeled
  **honestly** (not a fake interactive-PTY badge; do not reuse `transport: "pty"` for what is
  captured exec output — invariant 6). True duplex/xterm-frame-accurate replay is **deferred
  to an optional SLICE 5**, filed as a tracking issue, built only if a consumer needs it.
- **Caps:** fold a minimal fail-closed cap into SLICE 2 (above).
- **Mission:** record the author-written mission plaintext (public-safe committed lab text) +
  a digest of the full composed prompt. Nothing beyond the author mission goes plaintext.
- **E2B SDK:** ride the existing `@e2b/desktop` `commands.run`/`files.write` surface (the
  per-command `envs` is the command-scoped key channel). No second optional peer this lane.
- **Layer ordering:** land the lane **scored-by-mission**; SLICE 4 ships the extension *seam*
  (exported contract types + scorer DI hook + adapter-namespaced product nouns), NOT a
  built-in product scorer. The adopter's scorecard is its own thin extension.
- **evidenceClass:** out of scope (Layer 8).

## The slices (ordered, independently shippable, proof-laddered)

**SLICE 0 — blocked-run artifact-reference discipline (AC9).** Fix the live producer bug:
a blocked browser capture (`capture.ok === false`) still sets `embed.kind:"screenshot"` /
`ui.screenshotUrl` / per-step screenshot artifacts (`run.ts` ~858-899) and
`buildBlockedBrowserPersonaSteps` records screenshot paths it never writes
(`scripted-browser-actor.ts` ~625-643), so `verifyRun`'s `missingLocalEvidenceArtifacts`
fails closed on evidence that was never meant to exist. Fix: omit those refs (or write
placeholders) ONLY for blocked steps where the failure IS the evidence — scoped so a
genuinely-broken producer that simply failed to write evidence still fails closed. Extract a
shared "never reference an artifact you didn't write" helper for the terminal lane to inherit.
*Proof (merge gate, $0):* a blocked browser bundle verifies `ok:true` with no missing-artifact
finding; full suite green. No live rung.

**SLICE 1 — terminal-product config + routing skeleton, dry-run only.** Add
`LabSubjectSource: "terminal-product"`, `LabExecutionTarget: "e2b-terminal"`,
`subject.product{name, publicSurfaces}`, `execution.terminal{transport, stdin}` +
`runtimeAuth`, `scenario.caps{maxUsd, maxJobs, maxMinutes}`, four policy booleans
(`allowPrivateRepoAccess`/`allowProviderCredentials`/`allowPaymentCredentials`/`allowGitHubMutation`,
all default false), a `terminal` `ActorLane` + capabilities (incl. `keyPlacement:
"in-sandbox-command-scoped"` as DECLARED metadata) + `ActorId` + descriptor + `getActor`
overload, `actorResolvesToTerminal`/`routesToTerminalProduct` predicate, `LabBackend:
"terminal"` + `selectLabBackend` branch + `program.ts` switch, `forwardDeclaredWarnings`
branch, the fail-closed cross-validation matrix, and a public-safe **mock-CLI** fixture lab
(NEUTRAL name; the reference adopter's surfaces live only as codename-free operator docs).
Backend emits a DRY-RUN contract-only bundle (no E2B, no spend), honestly labeled. *Proof
(merge gate, $0):* `pnpm check`; `lab run <fixture> --dry-run --json --no-open` → verified
contract bundle; `verify --run latest --json` ok; lab list/inspect; forward-declared warnings
correct. No live rung.

**SLICE 2 — live E2B terminal backend + command-scoped credential boundary + cleanup +
interventions + minimal caps (the load-bearing depth slice).** A new
`src/e2b-terminal-lab.ts` orchestrator (mirror of `cua-actor-lab.ts`) on the
`@e2b/desktop` `commands.run` surface: create shell sandbox with `buildSandboxMetadata`
(positive allowlist) + `lifecycle:{onTimeout:"kill"}`; inject runtime auth ONLY into the
per-command `envs` (engine-enforced from `keyPlacement`); run `codex exec --json`
non-interactively (stdin disabled); capture a streamed, scrubbed+redacted output event stream
+ normalized transcript; score by the verdict-nonce marker; persist substrate-lifecycle
ledger, cleanup proof, empty interventions ledger; teardown via `Sandbox.kill`. Add verifier
checks: terminal/transcript presence, lifecycle ledger, cleanup proof, interventions
present-even-if-empty, metadata-allowlist conformance, **and assert no credential value
appears in env/metadata/artifacts**. Deny-by-default credential allowlist. **Fold in a
minimal fail-closed `maxUsd:0`/`maxMinutes` cap** so the live key is bounded by mechanism.
Deterministic CI via a `terminalHooks` DI seam against a **mock CLI** at zero spend.
*Proof:* (merge gate, $0) the `terminalHooks` test runs the full
create→inject→run→capture→teardown path against a fake sandbox + mock CLI, asserting `verify`
ok, the key never in metadata/global-env, cleanup remaining==0, interventions empty-present,
and a blocked run still structurally verifiable. **(live rung — REQUIRED, kept receipt)** one
key-gated E2B+Codex run: real sandbox created+killed, real Codex invoked, runtime auth
command-scoped, no provider/payment/deploy/GitHub/db creds in artifacts, no spend, `verify`
ok. Do NOT merge without BOTH the deterministic test AND the live receipt.

**SLICE 3 — cost/spend ledger + no-spend proof + full caps enforcement.** A cost-ledger
contract (product/media/payment/provider lines; unknowns as `null`, never undefined-omitted
or guessed); `caps.{maxUsd,maxJobs,maxMinutes}` enforced fail-closed (not advisory); a
no-spend proof artifact derived from the ledger; verify checks that fail closed when the
ledger is absent on a live run and when observed spend exceeds caps. *Proof:* deterministic —
a `maxUsd:0` run with a mock CLI that would spend trips fail-closed; a no-spend run produces a
verified no-spend proof; null-for-unknown vs missing-key distinguished. Live rung optional
(reuse SLICE 2's receipt augmented with a real $0 ledger).

**SLICE 4 — product-adapter extension seam (the layer-6 "thin adapter, not a fork"
deliverable).** Export the contract types from `index.ts` (`RunBundle`/`RunStream`/
`RunFeedbackCandidate`/`RunMeaningfulUseScore` — currently NOT exported, which *forces* a fork
because a thin adapter can't type against the contracts); a registrable scorer/feedback
strategy DI hook (generalize `scoreOssMetaMeaningfulUse`); a structured adapter-namespaced
product-noun block on `RunFeedbackCandidate` (public CLI command observed / hosted
success-or-blocker / feedback id / media-job ids / no-media-spend / defection-friction)
WITHOUT hardcoding any adopter's nouns in core; add `e2b-terminal` to the substrate enums.
*Proof:* a conformance test where a thin in-repo example adapter registers a terminal-product
scorer, attaches product nouns, emits a feedback candidate, and the bundle verifies — proving
the seam closes the gap without a fork. No live rung.

## Deferred (named, not built)

- **SLICE 5 (optional):** true duplex PTY raw-event stream + xterm/ANSI-honoring Observer
  replay. The streamed-output event stream + snapshot-tail Observer already satisfies #154's
  evidence asks honestly; frame-accurate PTY is built only if a consumer demands it. Filed as
  a tracking issue.
- **evidenceClass** schema field (Layer 8). **Fan-out** of terminal lanes (rides the deferred
  layer-2 fan-out). Built-in product scorers (live in adopter repos as extensions).

## Proof discipline (every slice)

Deterministic rungs are the merge gate ($0): the credential boundary, cleanup, interventions,
metadata allowlist, and blocked-run-still-verifiable are all proven against fakes/mock CLI.
The single live rung (SLICE 2) is keys-gated, run manually, kept as a receipt under this
packet's `receipts/`, and asserts the safety contract holds against a *real* agent — never
live-only, never without the deterministic twin. Every "live-proven" claim cites a kept
receipt (AGENTS.md).
