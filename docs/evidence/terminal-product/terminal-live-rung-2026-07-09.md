# Live rung receipt: terminal-product real-agent lane, 2026-07-09

The first kept live receipt for the `terminal-product` lane: a real Codex
agent, running inside a hosted E2B shell, studied a public agent-facing CLI
product (the reference adopter from issue #154) from its declared public
surfaces and ran the product's own free, zero-spend onboarding guide, all
within `$0` no-spend caps, with cleanup proven by exact sandbox id.

## Result (kept run id: `terminal-2026-07-09T06-33-41-888Z-3afb2e17`)

- `session.status: passed`, `completionReason: goal_satisfied`, verdict
  nonce-verified (the agent emitted its passed marker with the run nonce).
- Lifecycle, in order: `run.created` -> `sandbox.created` ->
  `sandbox.ready` -> `runtime.bootstrapped` -> `exec.started` ->
  `exec.completed` -> `cleanup.verified` -> `cost.measured`.
- **Runtime bootstrap worked**: the stock sandbox image had no agent
  runtime on PATH; the unkeyed in-sandbox bootstrap installed Node, and the
  agent ran via `npx -y @openai/codex@latest exec
  --dangerously-bypass-approvals-and-sandbox`. This closes the exit-127
  blocker from issue #159.
- **Agent behavior (from the redacted transcript)**: fetched the three
  declared public surfaces (the machine-readable contract, the skill
  document, and the `.well-known` agent-skills index), understood the
  guide-first no-spend onboarding, ran the product's free guide command, and
  reported without crossing into any paid path.
- **No-spend proof (derived, not asserted)**: `noSpend.satisfied: true`,
  `maxUsd: 0`, `knownTotalUsd: 0`. Unmeasured provider/product/media/payment
  lines are recorded as unmeasured (the null-vs-known-zero discipline), never
  guessed at zero.
- **Cleanup proven BY EXACT ID**: `cleanup.reason: "reclaimed by id;
  getInfo(id) confirms the exact sandbox no longer exists
  (SandboxNotFoundError)"`, `remaining: 0`. homun never called
  `Sandbox.list`. This is the first LIVE exercise of the by-id cleanup
  doctrine (invariant 7): a shared operator E2B key is safe because the
  harness only ever reclaims the exact sandbox it created.
- `homun verify`: ok, 15/15 checks, `shareSafety.status: share_ready`.

## Credential boundary (held live)

The runtime key was injected only command-scoped into the single agent
invocation, never into `Sandbox.create` and never sandbox-global. The
persisted ledgers and transcript record env var NAMES only. `E2B_API_KEY`
authenticated `Sandbox.create` on the host and never entered the sandbox.

## Environment

- A shared operator `E2B_API_KEY` (NOT a dedicated/isolated key) plus a
  runtime key, `HOMUN_LIVE_CODEX=1` to leave dry-run. The shared key is safe
  by construction after the by-id cleanup change; no isolated E2B account is
  required.
- One sandbox created, reclaimed by id, bounded by a 10-minute session cap.

## What this closes and what remains

- Closes the honest gap in the terminal-product lane goal packet: the lane's
  mechanics + credential boundary were proven deterministically; this is the
  kept live "a real agent completed a task" receipt (issue #159).
- Optional durability follow-up: a custom E2B image with the agent runtime
  preinstalled would drop the per-run `npx` bootstrap fetch. Not required for
  this receipt.
