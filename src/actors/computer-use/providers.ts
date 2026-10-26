// The vendors an API-keyed computer-use participant runs on: the environment key each one reads and
// how its CuaProvider is built. A study's brain names the vendor; the route reads the key and the
// session builds the provider through this table, so a vendor plugs in here and nowhere else.

import type { ReasoningEffort } from "../reasoning-effort.js";
import { createAnthropicMessagesProvider } from "./anthropic-provider.js";
import type { CuaProvider } from "./loop.js";
import { createOpenAiResponsesProvider } from "./openai-provider.js";
import type { FetchLike } from "./provider-http.js";

/** What the route decides about an API participant's provider, and the transport tests replace. */
export interface ParticipantProviderOptions {
  apiKey: string;
  /** Absent runs the vendor's default model. */
  model?: string;
  /** Absent sends the vendor's default effort, which the provider records in modelSettings. */
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens?: number;
  /** OpenAI Fast mode. Validation refuses it for a model without a Fast mode rate. */
  serviceTier?: "fast";
  /** One HTTP dispatch per turn, so a request whose usage is lost is never sent twice. */
  singleDispatch?: boolean;
  fetchFn?: FetchLike;
  delayFn?: (ms: number) => Promise<void>;
}

interface ParticipantVendorEntry {
  /** The environment variable that holds the vendor's API key. */
  readonly keyName: string;
  create(options: ParticipantProviderOptions): CuaProvider;
}

export const PARTICIPANT_VENDORS = {
  openai: { keyName: "OPENAI_API_KEY", create: createOpenAiResponsesProvider },
  anthropic: {
    keyName: "ANTHROPIC_API_KEY",
    create: ({ serviceTier, ...options }) => {
      if (serviceTier !== undefined)
        throw new Error(
          "serviceTier is OpenAI Fast mode, which Anthropic participants do not have.",
        );
      return createAnthropicMessagesProvider(options);
    },
  },
} as const satisfies Record<string, ParticipantVendorEntry>;

export type ParticipantVendor = keyof typeof PARTICIPANT_VENDORS;

/**
 * Every vendor's key as `env` holds it, trimmed, empty when unset. A run reads all of them, whatever
 * vendor its participants use, so its scrub removes each one from what it records.
 */
export function participantKeys(
  env: Record<string, string | undefined>,
): Record<ParticipantVendor, string> {
  const keys = Object.entries(PARTICIPANT_VENDORS).map(([vendor, entry]) => [
    vendor,
    env[entry.keyName]?.trim() ?? "",
  ]);
  return Object.fromEntries(keys) as Record<ParticipantVendor, string>;
}
