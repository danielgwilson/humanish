// The provider-declared reasoning-effort vocabulary, kept in its own module so the lab schema and
// the OpenAI provider can share it without the schema depending on a provider.
//
// WHY THIS EXISTS AT ALL: effort was reachable in the provider and unreachable from a lab. Every
// computer-use run humanish had ever done was therefore the provider default — not by decision but
// by omission (#497). Effort changes who the PARTICIPANT is, the same way a persona prompt does
// (docs/principles/actor-fidelity.md: capability settings are recruiting decisions), so pinning it
// invisibly meant every persona finding was really a finding about that persona at medium, with the
// second half unsaid.
//
// SUPPORT IS MODEL-DEPENDENT. OpenAI documents the vocabulary below as the union across models and
// states plainly that "supported values are model-dependent"; there is no offline way to know which
// subset a given model id accepts. So this module refuses to pretend: it validates that a lab asked
// for a REAL effort level, and a model that does not support the one it was asked for fails on the
// first turn with the provider's own message rather than being silently downgraded. Silent
// downgrade is the worse failure — it would record an effort the run did not actually use.

/** The documented vocabulary, ordered from least to most reasoning. */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/** For error messages: the vocabulary as an inline list. */
export function reasoningEffortNames(): string {
  return REASONING_EFFORTS.join(", ");
}
