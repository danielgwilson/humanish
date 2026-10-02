// The terminal-product bundle contract shared by its producer (src/routes/terminal/) and verify: the
// artifact file names, the cost categories, and the local-actor verdict marker. One definition, so
// the producer and verifier cannot drift.

import { escapeRegExp } from "./text.js";

export const TERMINAL_EVENTS_ARTIFACT = "terminal-events.ndjson";
export const TERMINAL_TRANSCRIPT_ARTIFACT = "terminal-transcript.txt";
export const TERMINAL_LEDGERS_ARTIFACT = "terminal-ledgers.json";

/** The cost categories the terminal route meters. product/media/payment are adapter signals; core can
 *  populate the provider line from the actor trace's tokenUsage.costUsd when present. */
export type CostCategory = "product" | "media" | "payment" | "provider";

/** The four cost categories, in a fixed order so the ledger shape is stable across runs. */
export const COST_CATEGORIES: readonly CostCategory[] = [
  "product",
  "media",
  "payment",
  "provider",
] as const;

/**
 * Strip ANSI/control noise from a captured terminal transcript into stable, scannable text. Pure
 * (no IO). Exported so the terminal-product route (src/routes/terminal/live-sandbox.ts) normalizes
 * its captured exec stream exactly as the local-actor routes do: the verdict-nonce scorer is only
 * sound against the same normalization the marker is matched on, so the logic must not diverge.
 */
export function normalizeLocalActorTranscript(transcript: string): string {
  return transcript
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[78=>]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

type ActorVerdict = "passed" | "blocked" | "failed";

/**
 * Extract the per-run verdict from a normalized transcript: the agent must print exactly
 * `HUMANISH_ACTOR_VERDICT=<status> HUMANISH_ACTOR_NONCE=<nonce>`, and the nonce is mandatory so a
 * bare marker (echoed or replayed from untrusted text) can never forge a verdict. Pure (no IO).
 * Exported so the terminal-product route scores its in-sandbox `codex exec` run by the same marker;
 * divergent verdict logic would let the two routes disagree about what "passed" means.
 */
export function extractLocalActorVerdict(
  transcript: string,
  verdictNonce: string,
): ActorVerdict | null {
  const compactTranscript = transcript.replace(/\s+/g, "");
  // The per-run nonce is mandatory: a bare HUMANISH_ACTOR_VERDICT=<status>
  // marker echoed by an actor (or replayed from untrusted text) must never
  // satisfy verdict extraction.
  const match = new RegExp(
    `HUMANISH_ACTOR_VERDICT=(passed|blocked|failed)HUMANISH_ACTOR_NONCE=${escapeRegExp(verdictNonce)}`,
    "i",
  ).exec(compactTranscript);
  if (!match) {
    return null;
  }

  return match[1]?.toLowerCase() as ActorVerdict;
}
