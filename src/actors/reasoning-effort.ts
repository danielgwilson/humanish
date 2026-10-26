// The provider-declared reasoning-effort vocabulary, kept in its own module so the study schema and
// the OpenAI provider can share it without the schema depending on a provider.
//
// Why this exists: effort was reachable in the provider and unreachable from a study. Every
// computer-use run humanish had ever done was therefore the provider default, not by decision but
// by omission. Effort changes who the participant is, the same way a persona prompt does
// (docs/principles/actor-fidelity.md: capability settings are recruiting decisions), so pinning it
// invisibly meant every persona finding was really a finding about that persona at medium, with the
// second half unsaid.
//
// Support is model-dependent. OpenAI documents the vocabulary below as the union across models and
// lists each model's subset on its model page. OPENAI_MODEL_EFFORTS records the subsets read from
// those pages, which the analysis models (src/analysis/models.ts) and the participant models
// (src/actors/computer-use/models.ts) both check against. A model with no recorded subset is
// checked against the union only, and a level it does not accept fails on the first turn with the
// provider's own message rather than being silently downgraded. Silent downgrade is the worse
// failure: it would record an effort the run did not actually use.

/** The documented vocabulary, ordered from least to most reasoning. */
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/** For error messages: the vocabulary as an inline list. */
export function reasoningEffortNames(): string {
  return REASONING_EFFORTS.join(", ");
}

/**
 * `reasoning.effort` values from each model's page under developers.openai.com/api/docs/models
 * (read 2026-10-21). None of them lists `minimal`; gpt-6-astra and gpt-6.1-sol also refuse `none`.
 */
export const OPENAI_MODEL_EFFORTS = {
  "gpt-6-astra": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6.1-sol": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-5.5": ["none", "low", "medium", "high", "xhigh"],
  "gpt-5.6": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-sol": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-terra": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
} as const satisfies Record<string, readonly ReasoningEffort[]>;
