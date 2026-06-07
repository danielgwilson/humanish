// Compiles a committed persona (mimetic/personas/*.yaml) into actor-neutral
// behavioral directives so persona traits actually drive how the actor uses the
// product, instead of being inert metadata. See docs/architecture/actor-contract.md.
//
// Patience is modeled as FRICTION TOLERANCE, never a turn/tool-call budget: the
// directive tells the actor when, in character, to stop and report the friction.

export type PersonaLevel = "low" | "medium" | "high";

export interface ResolvedPersona {
  id: string;
  name: string;
  summary?: string;
  traits: {
    patience: PersonaLevel;
    skill: PersonaLevel;
    accessibilityNeeds?: string;
  };
  constraints: string[];
}

export interface PersonaDirectives {
  frictionTolerance: string;
  skillBias: string;
  accessibilityBehavior?: string;
  constraints: string[];
  // The directive keys that were actually applied, for trace/fidelity proof.
  traitsApplied: string[];
}

const LEVELS: PersonaLevel[] = ["low", "medium", "high"];

function normalizeLevel(value: unknown, fallback: PersonaLevel = "medium"): PersonaLevel {
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if ((LEVELS as string[]).includes(lowered)) {
      return lowered as PersonaLevel;
    }
  }
  return fallback;
}

// Persona files are committed public-safe source, but they still flow into an
// actor prompt, so replace control characters with spaces and cap length to
// limit prompt-injection surface from a hand-authored persona.
function stripControlChars(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out;
}

function sanitizePersonaText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const cleaned = stripControlChars(value)
    // Neutralize the actor verdict/nonce markers so persona text injected into a
    // prompt cannot forge a verdict line an actor might echo back.
    .replace(/MIMETIC_ACTOR_(?:VERDICT|NONCE)/gi, "MIMETIC_ACTOR_[neutralized]")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) {
    return undefined;
  }
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a YAML-parsed persona object into a normalized ResolvedPersona. `fallback`
 * supplies id/name when the document omits them (or is not a record at all).
 */
export function parseResolvedPersona(raw: unknown, fallback: { id: string; name: string }): ResolvedPersona {
  const record = isRecord(raw) ? raw : {};
  const traits = isRecord(record.traits) ? record.traits : {};
  const id = sanitizePersonaText(record.id, 120) ?? fallback.id;
  const name = sanitizePersonaText(record.name, 120) ?? fallback.name;
  const summary = sanitizePersonaText(record.summary, 280);
  const accessibilityNeeds = sanitizePersonaText(traits.accessibility_needs, 80);
  const constraints = Array.isArray(record.constraints)
    ? record.constraints
        .map((entry) => sanitizePersonaText(entry, 160))
        .filter((entry): entry is string => entry !== undefined)
        .slice(0, 8)
    : [];

  return {
    id,
    name,
    ...(summary === undefined ? {} : { summary }),
    traits: {
      patience: normalizeLevel(traits.patience),
      // Persona YAML uses `technical_confidence`; the directive model calls it skill.
      skill: normalizeLevel(traits.technical_confidence),
      ...(accessibilityNeeds === undefined ? {} : { accessibilityNeeds })
    },
    constraints
  };
}

const FRICTION_TOLERANCE: Record<PersonaLevel, string> = {
  low: "You are impatient: if you hit repeated friction (errors, dead-ends, confusing UI) or stop making progress toward your goal, stop and report exactly what blocked you instead of pushing through.",
  medium: "You have moderate patience: work through some friction, but if you repeatedly fail to make progress toward your goal, stop and report what blocked you.",
  high: "You are determined: push through friction and try recovery paths, but if you reach an unrecoverable dead-end, stop and report it."
};

const SKILL_BIAS: Record<PersonaLevel, string> = {
  low: "You are not technically confident: prefer obvious UI affordances over CLI flags or config, and narrate your confusion whenever the interface is ambiguous.",
  medium: "You have moderate technical confidence: use straightforward paths and try one recovery step before giving up.",
  high: "You are technically confident: use keyboard shortcuts, inspect configuration, and try the recovery paths an expert would."
};

function accessibilityBehavior(needs: string): string {
  const lowered = needs.toLowerCase();
  if (lowered.includes("keyboard")) {
    return "Navigate using the keyboard; treat a control that requires a mouse and offers no keyboard path as a defect and report it.";
  }
  if (lowered.includes("terminal") || lowered.includes("output")) {
    return "You rely on clear terminal output; flag noisy, unreadable, or ambiguous output as a defect.";
  }
  return `You have the accessibility need "${needs}"; treat violations of it as defects and report them.`;
}

export function personaToDirectives(persona: ResolvedPersona): PersonaDirectives {
  const traitsApplied = [`patience:${persona.traits.patience}`, `skill:${persona.traits.skill}`];
  const accessibility = persona.traits.accessibilityNeeds
    ? accessibilityBehavior(persona.traits.accessibilityNeeds)
    : undefined;
  if (persona.traits.accessibilityNeeds) {
    traitsApplied.push(`accessibility:${persona.traits.accessibilityNeeds}`);
  }
  if (persona.constraints.length > 0) {
    traitsApplied.push(`constraints:${persona.constraints.length}`);
  }
  return {
    frictionTolerance: FRICTION_TOLERANCE[persona.traits.patience],
    skillBias: SKILL_BIAS[persona.traits.skill],
    ...(accessibility === undefined ? {} : { accessibilityBehavior: accessibility }),
    constraints: persona.constraints,
    traitsApplied
  };
}

/**
 * Render the persona section injected into an actor prompt. Replaces the bare
 * `Persona: <name>.` line so the persona's friction tolerance, skill, and
 * accessibility behavior actually shape the run. Returns a single space-joined
 * string to match the existing prompt-builder style.
 */
export function renderPersonaPromptSection(persona: ResolvedPersona): string {
  const directives = personaToDirectives(persona);
  const parts = [
    `Persona: ${persona.name}.`,
    ...(persona.summary ? [persona.summary] : []),
    directives.frictionTolerance,
    directives.skillBias,
    ...(directives.accessibilityBehavior ? [directives.accessibilityBehavior] : []),
    ...(directives.constraints.length > 0 ? [`Honor these constraints: ${directives.constraints.join("; ")}.`] : [])
  ];
  return parts.join(" ");
}
