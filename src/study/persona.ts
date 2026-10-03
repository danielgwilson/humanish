import { digestText, redactText } from "../evidence/redaction.js";
import type { ActorPersonaRef } from "../actors/contract.js";
import { isRecord } from "../run/type-guards.js";

type PersonaLevel = "low" | "medium" | "high";
export const PERSONA_BACKGROUND_MAX_BYTES = 32 * 1024;
const PERSONA_COMPILER_VERSION = 2;

export class PersonaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonaConfigError";
  }
}

export interface ResolvedPersona {
  id: string;
  name: string;
  summary?: string;
  background?: string;
  /** Digest of the source file, when resolved from disk. */
  sourceDigest?: string;
  traits: {
    patience?: PersonaLevel;
    skill?: PersonaLevel;
    accessibilityNeeds?: string;
  };
  constraints: string[];
}

export interface PersonaDirectives {
  frictionTolerance: string;
  skillBias: string;
  accessibilityBehavior?: string;
  constraints: string[];
  /** Directives included in the prompt, not proof of behavioral adherence. */
  traitsApplied: string[];
}

const LEVELS: PersonaLevel[] = ["low", "medium", "high"];
const PERSONA_FIELDS = new Set([
  "schema",
  "id",
  "name",
  "summary",
  "background",
  "traits",
  "constraints",
]);
const TRAIT_FIELDS = new Set(["patience", "technical_confidence", "accessibility_needs"]);

function cleanText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
    .replace(/HUMANISH_ACTOR_(?:VERDICT|NONCE)/gi, "HUMANISH_ACTOR_[neutralized]")
    .trim();
}

/** Legacy short fields keep their bounds, but every discarded value is diagnosed. */
export function parseResolvedPersona(
  raw: unknown,
  fallback: { id: string; name: string },
  warnings: string[] = [],
): ResolvedPersona {
  const record = isRecord(raw) ? raw : {};
  const traits = isRecord(record.traits) ? record.traits : {};
  if (!isRecord(raw)) warnings.push("Persona must be a mapping; using the legacy defaults.");
  for (const field of Object.keys(record)) {
    if (!PERSONA_FIELDS.has(field))
      warnings.push(
        `Unsupported persona field ${redactText(JSON.stringify(field))}; it is not sent to the participant. Use background for relevant context.`,
      );
  }
  for (const field of Object.keys(traits)) {
    if (!TRAIT_FIELDS.has(field))
      warnings.push(
        `Unsupported persona trait ${redactText(JSON.stringify(field))}; it is not sent to the participant.`,
      );
  }
  const short = (value: unknown, max: number, field: string): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
      warnings.push(`${field} must be text; ignored.`);
      return undefined;
    }
    const cleaned = cleanText(value).replace(/\s+/g, " ");
    if (!cleaned) return undefined;
    if (cleaned.length > max)
      warnings.push(
        `${field} exceeds ${max} characters and was shortened; move detailed context to background.`,
      );
    return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
  };
  let background: string | undefined;
  if (record.background !== undefined) {
    if (typeof record.background !== "string")
      throw new PersonaConfigError("Persona background must be text.");
    background = cleanText(record.background);
    if (!background) throw new PersonaConfigError("Persona background must not be empty.");
    if (
      Buffer.byteLength(record.background, "utf8") > PERSONA_BACKGROUND_MAX_BYTES ||
      Buffer.byteLength(background, "utf8") > PERSONA_BACKGROUND_MAX_BYTES
    ) {
      throw new PersonaConfigError(
        `Persona background exceeds ${PERSONA_BACKGROUND_MAX_BYTES} UTF-8 bytes; shorten it explicitly. No background was truncated.`,
      );
    }
  }
  const level = (field: string): PersonaLevel | undefined => {
    const value = traits[field];
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : undefined;
    if (LEVELS.includes(normalized as PersonaLevel)) return normalized as PersonaLevel;
    if (value !== undefined)
      warnings.push(
        `traits.${field} must be low, medium or high; ${background ? "ignored" : "using medium"}.`,
      );
    return background ? undefined : "medium";
  };
  if (record.traits !== undefined && !isRecord(record.traits))
    warnings.push("Persona traits must be a mapping; invalid traits ignored.");
  if (
    background &&
    Object.keys(traits).some((field) => field === "patience" || field === "technical_confidence")
  ) {
    warnings.push(
      "Background and explicit trait directives are both sent to the participant. Review the brief for conflicting instructions; prose conflicts are not automatically detected.",
    );
  }
  let accessibilityNeeds = short(traits.accessibility_needs, 80, "traits.accessibility_needs");
  if (
    accessibilityNeeds &&
    /^(none[ _-]declared|none|not[ _-]applicable)$/i.test(accessibilityNeeds)
  )
    accessibilityNeeds = undefined;
  if (record.constraints !== undefined && !Array.isArray(record.constraints))
    warnings.push("Persona constraints must be a list; ignored.");
  const allConstraints = Array.isArray(record.constraints) ? record.constraints : [];
  if (allConstraints.length > 8)
    warnings.push(
      "Only the first eight persona constraints are used; move detailed context to background.",
    );
  const constraints = allConstraints
    .slice(0, 8)
    .map((value) => short(value, 160, "constraint"))
    .filter((value): value is string => value !== undefined);
  const patience = level("patience"),
    skill = level("technical_confidence");
  const summary = short(record.summary, 280, "summary");
  return {
    id: short(record.id, 120, "id") ?? fallback.id,
    name: short(record.name, 120, "name") ?? fallback.name,
    ...(summary === undefined ? {} : { summary }),
    ...(background === undefined ? {} : { background }),
    traits: {
      ...(patience === undefined ? {} : { patience }),
      ...(skill === undefined ? {} : { skill }),
      ...(accessibilityNeeds === undefined ? {} : { accessibilityNeeds }),
    },
    constraints,
  };
}

const FRICTION_TOLERANCE: Record<PersonaLevel, string> = {
  low: "You are impatient: if you hit repeated friction or stop making progress toward your goal, you are likely to stop. Describe what you actually encountered.",
  medium:
    "You have moderate patience: you will work through some friction, but may stop if further effort no longer seems worthwhile.",
  high: "You are determined: you are willing to spend effort on recovery when the goal matters to you, but may stop at an unrecoverable dead-end.",
};
const SKILL_BIAS: Record<PersonaLevel, string> = {
  low: "You are not technically confident and generally rely on familiar, visible controls. Describe confusion only when you actually encounter it.",
  medium:
    "You have moderate technical confidence and generally use straightforward paths through the product.",
  high: "You are technically confident and comfortable with keyboard shortcuts and advanced options on the surfaces this product gives you.",
};
function accessibilityBehavior(needs: string): string {
  if (/keyboard[ _-]first/i.test(needs))
    return "You prefer keyboard navigation, but can use a pointer when needed. Describe any difficulty you encounter switching between them.";
  if (/keyboard[ _-]only/i.test(needs))
    return "You can only use the keyboard. If an essential control has no discoverable keyboard path, describe where you could not proceed.";
  if (/terminal|output/i.test(needs))
    return "You rely on clear terminal output. Describe any difficulty understanding the output you actually encounter.";
  return `Your accessibility requirement is: ${needs}. Use the available interface within this requirement and describe any difficulty you encounter.`;
}
export function personaToDirectives(persona: ResolvedPersona): PersonaDirectives {
  const { patience, skill, accessibilityNeeds } = persona.traits;
  const traitsApplied = [
    ...(patience ? [`patience:${patience}`] : []),
    ...(skill ? [`skill:${skill}`] : []),
  ];
  if (accessibilityNeeds) traitsApplied.push(`accessibility:${accessibilityNeeds}`);
  if (persona.constraints.length) traitsApplied.push(`constraints:${persona.constraints.length}`);
  return {
    frictionTolerance: patience ? FRICTION_TOLERANCE[patience] : "",
    skillBias: skill ? SKILL_BIAS[skill] : "",
    ...(accessibilityNeeds
      ? { accessibilityBehavior: accessibilityBehavior(accessibilityNeeds) }
      : {}),
    constraints: persona.constraints,
    traitsApplied,
  };
}
export function renderPersonaPromptSection(persona: ResolvedPersona): string {
  const directives = personaToDirectives(persona);
  return [
    `Persona: ${persona.name}.`,
    persona.summary,
    persona.background ? `Background:\n${persona.background}` : undefined,
    directives.frictionTolerance,
    directives.skillBias,
    directives.accessibilityBehavior,
    persona.constraints.length
      ? `Honor these constraints: ${persona.constraints.join("; ")}.`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Only the authored persona section; excludes task criteria, runtime grants and inbox URLs. */
export function personaBrief(
  persona: ResolvedPersona,
  scrub: (text: string) => string = (text) => text,
): NonNullable<ActorPersonaRef["brief"]> {
  const original = renderPersonaPromptSection(persona),
    text = redactText(scrub(original));
  return {
    compilerVersion: PERSONA_COMPILER_VERSION,
    text,
    digest: digestText(original),
    redacted: text !== original,
    ...(persona.sourceDigest ? { sourceDigest: persona.sourceDigest } : {}),
  };
}

export function scrubPersonaBrief(
  persona: ActorPersonaRef,
  scrub: (text: string) => string,
): ActorPersonaRef {
  if (!persona.brief) return persona;
  const text = redactText(scrub(persona.brief.text));
  return {
    ...persona,
    brief: {
      ...persona.brief,
      text,
      redacted: persona.brief.redacted || text !== persona.brief.text,
    },
  };
}
