// Shared contained persona resolution for browser and terminal participants.
import { parse as parseYaml } from "yaml";
import path from "node:path";

import { parseResolvedPersona, PersonaConfigError, type ResolvedPersona } from "./persona.js";
import {
  prepareSelectedOutputDirectory,
  readContainedRegularFile,
  type PreparedSelectedOutputDirectory,
} from "../run/contained-output.js";
import { digestText, redactText } from "../evidence/redaction.js";
import { realpath } from "node:fs/promises";

/** Persona ids are file-name segments, never paths: the same grammar the terminal lane enforces. */
const PERSONA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Title-case an id for the fallback display name (`skeptical-power-user` -> `Skeptical Power User`). */
export function personaTitleFromId(personaId: string): string {
  return personaId
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Where a persona id resolves, in order: a committed persona wins over a machine-local one. */
const PERSONA_DIRECTORIES = [
  path.posix.join("humanish", "personas"),
  path.posix.join(".humanish", "local", "personas"),
] as const;

/**
 * Resolve ONE persona from `humanish/personas/`, then the ignored `.humanish/local/personas/`.
 * Returns `null` with a warning when the id is unsafe or no file exists. Invalid rich backgrounds
 * reject the study before execution.
 */
export async function resolveCommittedPersona(
  projectRoot: PreparedSelectedOutputDirectory,
  personaId: string,
): Promise<{ persona: ResolvedPersona | null; warnings: string[] }> {
  if (!PERSONA_ID_PATTERN.test(personaId)) {
    return {
      persona: null,
      warnings: ["Persona id is not a safe filename; using the id only (no persona context)."],
    };
  }
  for (const candidate of PERSONA_DIRECTORIES.flatMap((directory) => [
    path.posix.join(directory, `${personaId}.yaml`),
    path.posix.join(directory, `${personaId}.yml`),
  ])) {
    const bytes = await readContainedRegularFile(projectRoot, candidate);
    if (!bytes) continue;
    let raw: unknown;
    try {
      raw = parseYaml(bytes.toString("utf8"));
    } catch {
      return {
        persona: null,
        warnings: [
          `${candidate} could not be parsed as YAML; the lane ran with the persona id only (no traits applied).`,
        ],
      };
    }
    const warnings: string[] = [];
    const persona = parseResolvedPersona(
      raw,
      { id: personaId, name: personaTitleFromId(personaId) },
      warnings,
    );
    persona.sourceDigest = digestText(bytes.toString("utf8"));
    return { persona, warnings: warnings.map((warning) => `${candidate}: ${warning}`) };
  }
  return {
    persona: null,
    warnings: [
      `Persona ${redactText(personaId)} has no readable file under humanish/personas or .humanish/local/personas; using the id only (no persona context).`,
    ],
  };
}

/**
 * Resolve every distinct persona id a run will use, once, before lane specs are built. Returning a
 * map keeps the plan builder PURE (it is exported npm surface and asserted pure by tests): the
 * async file reads happen here, and the composer only does a lookup.
 */
export async function resolveCommittedPersonas(
  projectRoot: PreparedSelectedOutputDirectory,
  personaIds: readonly (string | undefined)[],
): Promise<{ personas: Map<string, ResolvedPersona>; warnings: string[] }> {
  const personas = new Map<string, ResolvedPersona>();
  const warnings: string[] = [];
  for (const personaId of new Set(
    personaIds.filter((id): id is string => typeof id === "string" && id.length > 0),
  )) {
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
  personaIds: readonly (string | undefined)[],
): Promise<{ personas: Map<string, ResolvedPersona>; warnings: string[] }> {
  try {
    const physical = await realpath(path.resolve(cwd));
    const projectRoot = await prepareSelectedOutputDirectory(path.dirname(physical), physical);
    return await resolveCommittedPersonas(projectRoot, personaIds);
  } catch (error) {
    if (error instanceof PersonaConfigError) throw error;
    return {
      personas: new Map(),
      warnings: ["Persona directory could not be read; no persona context was loaded."],
    };
  }
}
