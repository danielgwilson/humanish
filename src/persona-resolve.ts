// Resolve committed persona files into compiled personas, for EVERY lane (#381).
//
// #308 gave the terminal lane this: read `humanish/personas/<id>.yaml`, compile the traits into
// behavioral directives, and record truthfully which traits were applied. The computer-use lanes
// never got it — they composed a bare `Persona: <id>.` line and hardcoded `traitsApplied: []`, so
// on browser routes the persona axis was a label rather than a behavior. A live two-lane contrast
// (an impatient expert vs a patient newcomer, same app, same mission) came back with near-identical
// action profiles, which read like evidence that personas do not matter and was actually evidence
// that personas were never applied.
//
// This module is the shared implementation so the two routes cannot drift again: one containment
// rule, one compiler, one fallback polarity.
//
// FAIL-SAFE, not fail-closed — deliberately the opposite polarity to the scorer loader. A persona
// that declared nothing must never be given fabricated traits, so an unsafe id, a missing file, or
// unparseable YAML falls back to the bare id line with a truthful EMPTY traitsApplied (warning only
// when the file existed but could not be read). Silence here is honest; invention would not be.
import { parse as parseYaml } from "yaml";
import path from "node:path";

import { parseResolvedPersona, type ResolvedPersona } from "./persona.js";
import {
  prepareSelectedOutputDirectory,
  readContainedRegularFile,
  type PreparedSelectedOutputDirectory
} from "./selected-output-paths.js";
import { realpath } from "node:fs/promises";

/** Persona ids are file-name segments, never paths: the same grammar the terminal lane enforces. */
export const PERSONA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Title-case an id for the fallback display name (`skeptical-power-user` -> `Skeptical Power User`). */
export function personaTitleFromId(personaId: string): string {
  return personaId
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Resolve ONE committed persona. Returns `null` (never a throw, never a guess) when the id is
 * unsafe or no file exists, so a lane always runs.
 */
export async function resolveCommittedPersona(
  projectRoot: PreparedSelectedOutputDirectory,
  personaId: string
): Promise<{ persona: ResolvedPersona | null; warnings: string[] }> {
  if (!PERSONA_ID_PATTERN.test(personaId)) {
    return { persona: null, warnings: [] };
  }
  for (const candidate of [
    path.posix.join("humanish", "personas", `${personaId}.yaml`),
    path.posix.join("humanish", "personas", `${personaId}.yml`)
  ]) {
    const bytes = await readContainedRegularFile(projectRoot, candidate);
    if (!bytes) continue;
    let raw: unknown;
    try {
      raw = parseYaml(bytes.toString("utf8"));
    } catch {
      return {
        persona: null,
        warnings: [`${candidate} could not be parsed as YAML; the lane ran with the persona id only (no traits applied).`]
      };
    }
    return { persona: parseResolvedPersona(raw, { id: personaId, name: personaTitleFromId(personaId) }), warnings: [] };
  }
  return { persona: null, warnings: [] };
}

/**
 * Resolve every distinct persona id a run will use, once, before lane specs are built. Returning a
 * map keeps the plan builder PURE (it is exported npm surface and asserted pure by tests): the
 * async file reads happen here, and the composer only does a lookup.
 */
export async function resolveCommittedPersonas(
  projectRoot: PreparedSelectedOutputDirectory,
  personaIds: readonly (string | undefined)[]
): Promise<{ personas: Map<string, ResolvedPersona>; warnings: string[] }> {
  const personas = new Map<string, ResolvedPersona>();
  const warnings: string[] = [];
  for (const personaId of new Set(personaIds.filter((id): id is string => typeof id === "string" && id.length > 0))) {
    const resolved = await resolveCommittedPersona(projectRoot, personaId);
    if (resolved.persona) personas.set(personaId, resolved.persona);
    warnings.push(...resolved.warnings);
  }
  return { personas, warnings };
}

/**
 * Every persona id a lab config could put on a browser lane: the per-lane roster when one is
 * declared, otherwise the actor-level persona that every fan-out lane inherits.
 */
export function labPersonaIds(config: {
  actors?: readonly { persona?: string; lanes?: readonly { persona?: string }[] }[];
}): string[] {
  const ids: string[] = [];
  for (const actor of config.actors ?? []) {
    if (actor.persona) ids.push(actor.persona);
    for (const lane of actor.lanes ?? []) {
      if (lane.persona) ids.push(lane.persona);
    }
  }
  return [...new Set(ids)];
}

/**
 * Same resolution from a plain cwd, for the labs that carry a directory string rather than an
 * already-prepared root. Realpath-then-prepare mirrors the cua lab so a symlinked cwd still reads
 * personas from the physical project.
 */
export async function resolveCommittedPersonasForCwd(
  cwd: string,
  personaIds: readonly (string | undefined)[]
): Promise<{ personas: Map<string, ResolvedPersona>; warnings: string[] }> {
  try {
    const physical = await realpath(path.resolve(cwd));
    const projectRoot = await prepareSelectedOutputDirectory(path.dirname(physical), physical);
    return await resolveCommittedPersonas(projectRoot, personaIds);
  } catch {
    return { personas: new Map(), warnings: [] };
  }
}
