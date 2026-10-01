// The terminal route's persona. The dry path (dry-run.ts) and the live path (session.ts) both
// resolve it here, so the persona line their prompts start with and the persona ref their bundles
// record come from one place. Each path keeps its own prompt and its own set of scrubbed secrets.
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { ActorPersonaRef } from "../../actors/contract.js";
import {
  personaBrief,
  personaToDirectives,
  renderPersonaPromptSection,
  type ResolvedPersona,
} from "../../lab/persona.js";
import { resolveCommittedPersona } from "../../lab/persona-resolve.js";
import type { TerminalPlan } from "../../lab/plan-types.js";
import { prepareSelectedOutputDirectory } from "../../run/contained-output.js";

/** A terminal run's persona, resolved against the project's committed persona files. */
export interface TerminalPersona {
  personaId: string;
  physicalCwd: string;
  /** The persona section the agent prompt starts with. */
  personaLine: string;
  /** The committed persona, or null when no file resolved and only the id is used. */
  resolved: ResolvedPersona | null;
}

/** Resolves the plan's persona; the resolver's warnings go into `warnings`. */
export async function resolveTerminalPersona(args: {
  plan: TerminalPlan;
  cwd: string;
  warnings: string[];
}): Promise<TerminalPersona> {
  const personaId = args.plan.personaId ?? "autonomous-terminal-agent";
  const physicalCwd = await realpath(args.cwd);
  // Resolve the committed persona so its traits actually shape the agent prompt (#308); fail-safe to
  // the bare persona id (no traits applied) when no persona file is committed.
  const projectRoot = await prepareSelectedOutputDirectory(path.dirname(physicalCwd), physicalCwd);
  const { persona, warnings } = await resolveCommittedPersona(projectRoot, personaId);
  args.warnings.push(...warnings);
  return {
    personaId,
    physicalCwd,
    personaLine: persona ? renderPersonaPromptSection(persona) : `persona: ${personaId}`,
    resolved: persona,
  };
}

/** The persona ref a terminal bundle records; `scrub` removes known secret values from the brief. */
export function terminalPersonaRef(
  persona: TerminalPersona,
  promptDigest: string,
  scrub: (text: string) => string,
): ActorPersonaRef {
  const { resolved } = persona;
  return {
    id: persona.personaId,
    traitsApplied: resolved ? personaToDirectives(resolved).traitsApplied : [],
    promptDigest,
    ...(resolved ? { brief: personaBrief(resolved, scrub) } : {}),
  };
}
