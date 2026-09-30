import { commandDigestOf } from "../../subject/state.js";
import { SUBJECT_DIR } from "../../subject/steps.js";
import type { Shell } from "../../substrates/shell.js";
import { runDetachedStep, type DetachedTimers } from "../../substrates/detached.js";
import { type LabConfig, type LabSubjectStateCheckpoint } from "../../lab/types.js";
import { redactText } from "../../evidence/redaction.js";
import { type SharedWorldCheckpoint } from "../../run/shared-world-evidence.js";

// Per-checkpoint probe budget (read-only aggregate probes are fast).
const CHECKPOINT_TIMEOUT_MS = 60_000;

/** Combine a snapshot's per-probe digests into ONE sha256-16 (digest-only; no raw value). */
export function combineCheckpointDigest(parts: string[]): string {
  return commandDigestOf(parts.join("\n"));
}

/**
 * Run ONE checkpoint snapshot LIVE: each declared probe runs read-only via the detached
 * primitive; its stdout is literal-scrubbed (provisioned values + the probe's declared redact
 * literals, folded into `scrub`) then pattern-redacted, then digested. Only the COMBINED digest
 * persists — never the raw value (the seed-step lockdown). Unique step names per snapshot prevent
 * stale-status reuse across snapshots.
 */
export async function runCheckpointSnapshot(args: {
  shell: Shell;
  snapshotIndex: number;
  name: string;
  checkpoints: LabSubjectStateCheckpoint[];
  prevDigest: string | undefined;
  scrub: (text: string) => string;
  requestTimeoutMs: number;
  timers: DetachedTimers;
}): Promise<SharedWorldCheckpoint> {
  const parts: string[] = [];
  for (const probe of args.checkpoints) {
    const result = await runDetachedStep(args.shell, {
      name: `checkpoint-${args.snapshotIndex}-${probe.name}`,
      command: probe.command,
      cwd: SUBJECT_DIR,
      timeoutMs: CHECKPOINT_TIMEOUT_MS,
      requestTimeoutMs: args.requestTimeoutMs,
      ...args.timers,
    });
    const scrubbed = redactText(args.scrub(result.logTail));
    parts.push(`${probe.name}=${commandDigestOf(scrubbed)}`);
  }
  const digest = combineCheckpointDigest(parts);
  return {
    kind: "checkpoint",
    name: args.name,
    digest,
    deltaFromPrev: args.prevDigest !== undefined && digest !== args.prevDigest,
  };
}

/** sha256-16 over the ordered seed-step command digests — the seeded-state RECIPE identity. */
export function seedRecipeDigest(config: LabConfig): string {
  const seed = config.subject.state?.seed ?? [];
  return commandDigestOf(
    seed.map((step) => `${step.name}:${commandDigestOf(step.command)}`).join("\n"),
  );
}
