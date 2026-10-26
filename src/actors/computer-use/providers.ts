// The vendors an API-keyed computer-use participant runs on: the environment key each one reads,
// how its CuaProvider is built, the model it runs when a study names none, the effort levels it
// documents and the screenshots it can read. A study's brain names the vendor; planning reads the
// limits, the route reads the key and the session builds the provider through this table, so a
// vendor plugs in here, in its model rows (models.ts) and nowhere else in the participant path.

import { REASONING_EFFORTS, type ReasoningEffort } from "../reasoning-effort.js";
import {
  DEFAULT_ANTHROPIC_CU_MODEL,
  createAnthropicMessagesProvider,
} from "./anthropic-provider.js";
import { ANTHROPIC_EFFORTS, frameSizeReason } from "./anthropic-wire.js";
import type { CuaProvider } from "./loop.js";
import { DEFAULT_OPENAI_CU_MODEL, createOpenAiResponsesProvider } from "./openai-provider.js";
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
  /** The model a participant on this vendor runs when the study names none. */
  readonly defaultModel: string;
  /** Every effort level the vendor documents; a model it does not list is checked against these. */
  readonly efforts: readonly ReasoningEffort[];
  /** Why the vendor's models cannot read a width x height screenshot; absent when any size works. */
  readonly frameReason?: (width: number, height: number) => string | undefined;
  create(options: ParticipantProviderOptions): CuaProvider;
}

const VENDORS = {
  openai: {
    keyName: "OPENAI_API_KEY",
    defaultModel: DEFAULT_OPENAI_CU_MODEL,
    efforts: REASONING_EFFORTS,
    create: createOpenAiResponsesProvider,
  },
  anthropic: {
    keyName: "ANTHROPIC_API_KEY",
    defaultModel: DEFAULT_ANTHROPIC_CU_MODEL,
    efforts: ANTHROPIC_EFFORTS,
    frameReason: frameSizeReason,
    create: ({ serviceTier, ...options }) => {
      if (serviceTier !== undefined)
        throw new Error(
          "serviceTier is OpenAI Fast mode, which Anthropic participants do not have.",
        );
      return createAnthropicMessagesProvider(options);
    },
  },
} as const satisfies Record<string, ParticipantVendorEntry>;

export type ParticipantVendor = keyof typeof VENDORS;

/** The environment variable names of the vendors' keys. */
export type ParticipantKeyName = (typeof VENDORS)[ParticipantVendor]["keyName"];

export const PARTICIPANT_VENDORS: Readonly<
  Record<ParticipantVendor, ParticipantVendorEntry & { readonly keyName: ParticipantKeyName }>
> = VENDORS;

/** The vendor names a study's actor.provider may take, in table order. */
export const PARTICIPANT_VENDOR_NAMES = Object.keys(PARTICIPANT_VENDORS) as ParticipantVendor[];

export const isParticipantVendor = (value: unknown): value is ParticipantVendor =>
  typeof value === "string" && Object.hasOwn(PARTICIPANT_VENDORS, value);

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
