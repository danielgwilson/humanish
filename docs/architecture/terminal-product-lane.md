# Terminal-product real-agent lane (issue #154)

Date: 2026-06-16

Status: SLICE 1 shipped — the config + routing skeleton, DRY-RUN only. The live
in-sandbox backend, the command-scoped credential boundary, cleanup,
interventions, the cost/no-spend ledger, and the product-adapter extension seam
are later slices. See the ratified goal packet
([`docs/goals/terminal-product-lane/goal.md`](../goals/terminal-product-lane/goal.md))
for the full slice plan and the safety contract.

## What this is

A lab lane for **terminal-product real-agent studies**: a real autonomous coding
agent (Codex) discovering and using a CLI/product from its **public surfaces
only**, running **inside an E2B shell** with command-scoped runtime auth, capped
at no-spend, emitting durable terminal/substrate/cost/no-spend/cleanup/
intervention proof that verifies fail-closed. This is distinct from the browser
lanes: it is not testing whether a browser can click a local web app — it tests
whether an autonomous agent can discover and use a CLI/product surface from
public materials.

It rides the established lane-addition pattern (proven by the scripted-browser
and local-app lanes): a new `subject.source` × `execution.target`, a routing
predicate, a backend enum + dispatch, a registered actor with a capability lane,
fail-closed cross-validation, and forward-declared warnings.

## The composition

| Axis | Value |
| --- | --- |
| `subject.source` | `terminal-product` |
| `subject.product` | `{ name, publicSurfaces[] }` — the only world the agent sees |
| `execution.target` | `e2b-terminal` (or absent → implied) |
| `execution.terminal` | `{ transport: exec-stream, stdin: disabled }` |
| `execution.runtimeAuth` | `openai-env` (names-only evidence this slice) |
| `scenario.caps` | `{ maxUsd, maxJobs, maxMinutes }` — the blast-radius budget |
| `policies` | `allowPrivateRepoAccess` / `allowProviderCredentials` / `allowPaymentCredentials` / `allowGitHubMutation`, all DEFAULT FALSE |
| `actors[0].type` | `codex-exec` — a registered terminal actor (`keyPlacement: in-sandbox-command-scoped`) |
| `LabBackend` | `terminal` → `runTerminalProductLab` ([`src/e2b-terminal-lab.ts`](../../src/e2b-terminal-lab.ts)) |

Routing is `routesToTerminalProduct(config)` — the single source of truth that
both `selectLabBackend` and the forward-declared-warning logic consume, mirroring
`routesToComputerUse` / `routesToScriptedBrowser`.

## The safety contract (the lane's reason to exist)

This lane **inverts** the credential-placement default of every other E2B route.
On the computer-use route the model's key stays *outside* the sandbox; here the
agent-under-test runs *inside* with a real `OPENAI_API_KEY`/`CODEX_API_KEY` and
is **presumed exfiltratable**. The doctrine (invariants-and-defaults.md, the
placement rule): *keys live where the keyed process runs — and nowhere else;
blast radius is bounded by key scoping and budgets, not by hoping.*

The inversion is declared as registry metadata, not a code convention: the
terminal actor's capabilities carry `keyPlacement: "in-sandbox-command-scoped"`.
SLICE 1 ships the DECLARED field + value (the contract is honest about where the
key would go); SLICE 2's engine enforces command-scoped injection (only into the
per-command `envs` of the `codex` invocation, never `Sandbox.create({envs})`)
keyed off that capability, plus the deny-by-default credential allowlist, the
positive-allowlist sandbox metadata, the cleanup proof, the interventions ledger,
and a minimal fail-closed cap.

## SLICE 1 scope (DRY-RUN only — what is honest now)

`runTerminalProductLab` implements ONLY the dry-run path: it builds a valid
`mimetic.run-bundle.v1` contract bundle, honestly labeled contract-only, with:

- the subject declared as a terminal-product with its public surfaces, provenance
  **UNPINNED** (the agent drives public surfaces, not a clone — invariant 5);
- the author mission recorded as plaintext (public-safe committed lab text) + a
  **digest** of the full composed prompt (nothing beyond the author mission goes
  plaintext);
- the caps / deny-by-default policies / runtime-auth channel recorded as
  declarations (names only — invariant 1);
- a terminal-kind stream that is an honest **contract placeholder**: stdin
  disabled, empty tail, `transport: snapshot` — **not** `pty` (captured
  non-interactive exec output is never an interactive PTY; invariant 6 + the
  goal packet's PTY ruling). SLICE 2 fills the redacted exec-stream capture;
- empty/placeholder ledgers (substrate lifecycle, command log, terminal event
  stream, interventions, cost) that SLICE 2/3 fill.

The dry-run bundle passes the EXISTING `verifyRun`. Terminal-specific verifier
checks (terminal/transcript presence, lifecycle, cleanup, interventions,
metadata allowlist, no-credential-in-artifacts, no-spend) are SLICE 2/3.

A non-dry-run (live) call returns a structured `MIMETIC_TERMINAL_AGENT_NOT_IMPLEMENTED`
failure (fail-closed, clear code) — it never creates a sandbox, never injects a
key, never spends. SLICE 2 implements the real session.

The DI seams SLICE 2 needs (`loadModule`, `buildSandbox`, `runtimeAuthEnv`,
`detachedTimers`) are declared on `TerminalProductLabHooks` and threaded through
`RunLabOptions.terminalHooks`, mirroring `cuaHooks` / `scriptedHooks` — but only
the dry-run path is implemented this slice.

## The reference adopter (codename-neutral)

The requesting adopter is a public creative-CLI product (see issue #154 for its
concrete public surfaces). Committed source and docs here stay codename-neutral
per the public-surface scan; the committed CI fixture
([`mimetic/labs/terminal-product-demo.yaml`](../../mimetic/labs/terminal-product-demo.yaml))
uses a FICTIONAL mock CLI (`widgetsmith-cli`) with `example.com` surfaces. The
adopter's real public surfaces appear only in operator-run docs and the GitHub
issue, never in scanned committed text.
