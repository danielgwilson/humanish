// The models an API computer-use participant runs: the vendor that serves each one and the
// reasoning efforts each accepts. A study's one real choice is the model, so this table picks the
// vendor from it, and `actor.provider` names the vendor of a model the table does not list yet.
// Parsing, planning and the benchmark resolve a participant's model here and nowhere else.

import { OPENAI_MODEL_EFFORTS, type ReasoningEffort } from "../reasoning-effort.js";
import {
  PARTICIPANT_VENDORS,
  PARTICIPANT_VENDOR_NAMES,
  isParticipantVendor,
  type ParticipantVendor,
} from "./providers.js";

interface ParticipantModel {
  readonly vendor: ParticipantVendor;
  readonly efforts: readonly ReasoningEffort[];
}

const openai = (efforts: readonly ReasoningEffort[]): ParticipantModel => ({
  vendor: "openai",
  efforts,
});

/**
 * Every participant model src/run/pricing.ts prices, with its vendor. OpenAI's model pages list
 * no effort levels for computer-use-preview, gpt-5.6-cyber and the Daybreak aliases, so those take
 * OpenAI's documented union, and a level the model refuses fails on the first turn.
 */
export const PARTICIPANT_MODELS: Readonly<Record<string, ParticipantModel>> = {
  ...Object.fromEntries(
    Object.entries(OPENAI_MODEL_EFFORTS).map(([model, efforts]) => [model, openai(efforts)]),
  ),
  "computer-use-preview": openai(PARTICIPANT_VENDORS.openai.efforts),
  "gpt-5.6-cyber": openai(PARTICIPANT_VENDORS.openai.efforts),
  "daybreak-blue-latest": openai(PARTICIPANT_VENDORS.openai.efforts),
  "daybreak-red-latest": openai(PARTICIPANT_VENDORS.openai.efforts),
  // Anthropic's effort documentation, read 2026-10-26: Claude Haiku 5.5 takes output_config.effort
  // low, medium, high, xhigh and max.
  "claude-haiku-5-5": { vendor: "anthropic", efforts: ["low", "medium", "high", "xhigh", "max"] },
};

/** The vendor a study with no model and no actor.provider runs on. */
const DEFAULT_VENDOR: ParticipantVendor = "openai";

/** A participant's model as planning uses it, or why the study cannot run it. */
export type ParticipantModelResolution =
  | {
      readonly ok: true;
      readonly vendor: ParticipantVendor;
      /** The model id the provider is asked for: the study's, else the vendor's default. */
      readonly model: string;
      /** Whether the table lists the model; an unlisted one is checked against its vendor only. */
      readonly listed: boolean;
      /** The effort levels a participant on this model may declare. */
      readonly efforts: readonly ReasoningEffort[];
    }
  | { readonly ok: false; readonly reason: string };

const listedModel = (model: string): ParticipantModel | undefined =>
  Object.hasOwn(PARTICIPANT_MODELS, model) ? PARTICIPANT_MODELS[model] : undefined;

const listedNames = (): string => Object.keys(PARTICIPANT_MODELS).sort().join(", ");

/**
 * The vendor and model a participant runs, from `actor.model` and `actor.provider`:
 *
 * - a listed model runs on the table's vendor, and a `provider` that disagrees is refused;
 * - an unlisted model runs on `provider`, checked against that vendor's effort levels only, and
 *   is refused without one, since nothing else says which vendor serves it;
 * - no model runs `provider`'s default model, else OpenAI's.
 */
export function resolveParticipantModel(
  model: string | undefined,
  provider?: string,
): ParticipantModelResolution {
  if (provider !== undefined && !isParticipantVendor(provider))
    return {
      ok: false,
      reason: `actor.provider "${provider}" is not a participant vendor humanish runs. Use one of: ${PARTICIPANT_VENDOR_NAMES.join(", ")}.`,
    };
  if (model === undefined) {
    const vendor = provider ?? DEFAULT_VENDOR;
    return resolveParticipantModel(PARTICIPANT_VENDORS[vendor].defaultModel, vendor);
  }
  const listed = listedModel(model);
  if (listed !== undefined) {
    if (provider !== undefined && provider !== listed.vendor)
      return {
        ok: false,
        reason: `actor.provider "${provider}" does not serve ${model}, which runs on ${listed.vendor}. Remove actor.provider.`,
      };
    return { ok: true, vendor: listed.vendor, model, listed: true, efforts: listed.efforts };
  }
  if (provider !== undefined)
    return {
      ok: true,
      vendor: provider,
      model,
      listed: false,
      efforts: PARTICIPANT_VENDORS[provider].efforts,
    };
  return {
    ok: false,
    reason: `actor.model "${model}" is not a participant model humanish lists, so it cannot tell which vendor serves it. Listed models: ${listedNames()}. To run a model humanish does not list yet, set actor.provider to its vendor (${PARTICIPANT_VENDOR_NAMES.join(" or ")}); it then runs unpriced, and a spend cap is refused.`,
  };
}

/**
 * The actor types whose participants run on a provider key, each with the vendor it pins.
 * `computer-use` takes the vendor from the model; `openai-computer-use` is the same actor with
 * the vendor pinned to OpenAI, and keeps running any model id there, as it always has.
 */
const API_PARTICIPANT_ACTORS: Readonly<Record<string, ParticipantVendor | undefined>> = {
  "computer-use": undefined,
  "openai-computer-use": "openai",
};

/** Whether participants of actor `type` run on a provider key. */
export const isApiParticipantActor = (type: string | undefined): boolean =>
  type !== undefined && Object.hasOwn(API_PARTICIPANT_ACTORS, type);

/** Whether actor `type` takes `actor.provider`: an API participant actor with no pinned vendor. */
export const takesProvider = (type: string | undefined): boolean =>
  isApiParticipantActor(type) && API_PARTICIPANT_ACTORS[type!] === undefined;

/**
 * The model an actor's participants run, or undefined for an actor that is not an API participant.
 * A model the table assigns to another vendor than the actor's pinned one is refused with the
 * actor type that runs it.
 */
export function actorParticipantModel(
  actor: { readonly type: string; readonly model?: string; readonly provider?: string } | undefined,
): ParticipantModelResolution | undefined {
  if (actor === undefined || !isApiParticipantActor(actor.type)) return undefined;
  const pinned = API_PARTICIPANT_ACTORS[actor.type];
  if (pinned === undefined) return resolveParticipantModel(actor.model, actor.provider);
  const listed = actor.model === undefined ? undefined : listedModel(actor.model);
  if (listed !== undefined && listed.vendor !== pinned)
    return {
      ok: false,
      reason: `actor.type ${actor.type} runs ${pinned} models, and ${actor.model} runs on ${listed.vendor}. Set actor.type: computer-use, which takes the vendor from actor.model.`,
    };
  return resolveParticipantModel(actor.model, pinned);
}

/** Why a participant on `resolved` cannot declare `effort` at `path`, or undefined when it can. */
export function participantEffortReason(
  resolved: Extract<ParticipantModelResolution, { ok: true }>,
  effort: ReasoningEffort | undefined,
  path: string,
): string | undefined {
  if (effort === undefined || resolved.efforts.includes(effort)) return undefined;
  const accepts = resolved.listed
    ? `${resolved.model} accepts`
    : `${resolved.vendor} documents for its models`;
  return `${path} is ${effort}, which is not a level ${accepts}. Use one of: ${resolved.efforts.join(", ")}.`;
}
