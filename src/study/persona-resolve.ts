// Shared contained persona resolution for browser and terminal participants.
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import path from "node:path";

import { parseResolvedPersona, PersonaConfigError, type ResolvedPersona } from "./persona.js";
import {
  prepareSelectedOutputDirectory,
  readContainedRegularFile,
  PROJECT_FILE_MAX_BYTES,
  refusalText,
  type PreparedSelectedOutputDirectory,
} from "../run/contained-output.js";
import { digestText, redactText } from "../evidence/redaction.js";
import { isRecord } from "../run/type-guards.js";
import { realpath } from "node:fs/promises";
import { participantList } from "./study-fields.js";
import type { StudyConfig } from "./types.js";
import { routeOf, type StudyRoute } from "./routing.js";
import { computerUseParticipants, sharedWorldParticipants } from "./plan-participants.js";

/** Persona ids are file-name segments, never paths: the same grammar the terminal route enforces. */
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

/** Whether a missing persona file stops the study. */
interface PersonaResolveOptions {
  /**
   * True, the default, for an id the study names that reaches a participant. False for a route's
   * built-in fallback id, which no study named, and for an id that reaches no participant: with no
   * file, or with a file that is not a YAML mapping, it runs with the id only and a warning.
   */
  readonly required?: boolean;
}

/**
 * The persona file a reader can paste for `personaId`: what the error message offers. The id is
 * quoted where YAML would read it as something other than text, such as `2024`.
 */
function pastePersonaFile(personaId: string): string {
  const id = stringifyYaml(personaId).trimEnd();
  return [
    "schema: humanish.persona.v1",
    `id: ${id}`,
    `name: ${id}`,
    "# background: >-",
    "#   A short, fictional description of who this person is and what they want.",
  ].join("\n");
}

/**
 * Resolve one persona from `humanish/personas/`, then the ignored `.humanish/local/personas/`.
 * A persona the study names must resolve: an unsafe id, no file, or a file that is not YAML throws
 * a PersonaConfigError, as do an invalid rich background and a file that is there and cannot be
 * read. With `required: false` the first three return `null` with a warning instead.
 */
export async function resolveCommittedPersona(
  projectRoot: PreparedSelectedOutputDirectory,
  personaId: string,
  options: PersonaResolveOptions = {},
): Promise<{ persona: ResolvedPersona | null; warnings: string[] }> {
  const required = options.required ?? true;
  const id = redactText(personaId);
  if (!PERSONA_ID_PATTERN.test(personaId)) {
    if (required)
      throw new PersonaConfigError(
        `Persona ${JSON.stringify(id)} cannot be a persona file name, so humanish cannot find a file for it. A persona id starts with a letter or digit and holds only letters, digits, - and _. Rename the persona in the study and in its file, or remove the persona line from the study.`,
      );
    return {
      persona: null,
      warnings: ["Persona id is not a safe filename; using the id only (no persona context)."],
    };
  }
  const candidates = PERSONA_DIRECTORIES.flatMap((directory) => [
    path.posix.join(directory, `${personaId}.yaml`),
    path.posix.join(directory, `${personaId}.yml`),
  ]);
  for (const candidate of candidates) {
    const read = await readContainedRegularFile(projectRoot, candidate, PROJECT_FILE_MAX_BYTES);
    if (read.status === "missing") continue;
    // A candidate that is there and refused stops resolution: the next file is another persona.
    if (read.status === "refused")
      throw new PersonaConfigError(
        `Persona ${id}: ${refusalText(candidate, read)}. Fix or remove that file; a lower-priority persona file is not used in its place.`,
      );
    const bytes = read.bytes;
    let raw: unknown;
    try {
      raw = parseYaml(bytes.toString("utf8"));
    } catch (error) {
      if (required)
        throw new PersonaConfigError(
          `Persona ${id}: ${candidate} is not valid YAML (${yamlProblem(error)}), so the participants would get none of it. Fix the file, or remove the persona line from the study.`,
        );
      return {
        persona: null,
        warnings: [
          `${candidate} could not be parsed as YAML; the participant ran with the persona id only (no traits applied).`,
        ],
      };
    }
    if (required && !isRecord(raw))
      throw new PersonaConfigError(
        `Persona ${id}: ${candidate} holds no persona fields${raw === null ? ", because it is empty" : ""}. A persona file is a YAML mapping of fields such as id, name and background. Add them, or remove the persona line from the study.`,
      );
    const warnings: string[] = [];
    const persona = parseResolvedPersona(
      raw,
      { id: personaId, name: personaTitleFromId(personaId) },
      warnings,
    );
    persona.sourceDigest = digestText(bytes.toString("utf8"));
    return { persona, warnings: warnings.map((warning) => `${candidate}: ${warning}`) };
  }
  if (required)
    throw new PersonaConfigError(
      [
        `The study names persona ${id}, and it has no persona file, so its participants would get only the id. humanish looked for ${candidates.join(", ")}. The file name must be the persona id followed by .yaml.`,
        `Add the file, for example humanish/personas/${id}.yaml:`,
        pastePersonaFile(id),
        "That file gives the participant the persona's name and the medium patience and technical confidence sentences. A background is what makes it a persona: add one where the comment shows. Or remove the persona line from the study.",
      ].join("\n\n"),
    );
  return {
    persona: null,
    warnings: [
      `Persona ${id} has no readable file under humanish/personas or .humanish/local/personas; using the id only (no persona context).`,
    ],
  };
}

/** The first line of a YAML parser error, which names the line and column it stopped at. */
function yamlProblem(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactText((message.split("\n")[0] ?? message).replace(/:\s*$/, ""));
}

/**
 * Resolve every distinct persona id a run will use, once, before participant specs are built. Returning a
 * map keeps the plan builder pure (it is exported npm surface and asserted pure by tests): the
 * async file reads happen here, and the composer only does a lookup.
 */
export async function resolveCommittedPersonas(
  projectRoot: PreparedSelectedOutputDirectory,
  personaIds: readonly (string | undefined)[],
  options: PersonaResolveOptions = {},
): Promise<{ personas: Map<string, ResolvedPersona>; warnings: string[] }> {
  const personas = new Map<string, ResolvedPersona>();
  const warnings: string[] = [];
  for (const personaId of new Set(
    personaIds.filter((id): id is string => typeof id === "string" && id.length > 0),
  )) {
    const resolved = await resolveCommittedPersona(projectRoot, personaId, options);
    if (resolved.persona) personas.set(personaId, resolved.persona);
    warnings.push(...resolved.warnings);
  }
  return { personas, warnings };
}

/**
 * Every persona id a study config could put on a browser participant: the roster when one is
 * declared, otherwise the actor-level persona that every fan-out participant inherits.
 */
export function studyPersonaIds(config: StudyConfig): string[] {
  const ids: string[] = [];
  const persona = config.actor?.persona;
  if (persona) ids.push(persona);
  for (const entry of participantList(config) ?? []) {
    if (entry.persona) ids.push(entry.persona);
  }
  return [...new Set(ids)];
}

/**
 * Same resolution from a plain cwd, for the labs that carry a directory string rather than an
 * already-prepared root. Realpath-then-prepare mirrors the computer-use route so a symlinked cwd
 * still reads personas from the physical project.
 */
export async function resolveCommittedPersonasForCwd(
  cwd: string,
  personaIds: readonly (string | undefined)[],
  options: PersonaResolveOptions = {},
): Promise<{ personas: Map<string, ResolvedPersona>; warnings: string[] }> {
  let projectRoot: PreparedSelectedOutputDirectory;
  try {
    const physical = await realpath(path.resolve(cwd));
    projectRoot = await prepareSelectedOutputDirectory(path.dirname(physical), physical);
  } catch {
    if ((options.required ?? true) && personaIds.some(Boolean))
      throw new PersonaConfigError(
        `The project directory ${redactText(path.resolve(cwd))} could not be read, so the personas the study names could not be found. Run humanish from a project directory you can read.`,
      );
    return {
      personas: new Map(),
      warnings: ["Persona directory could not be read; no persona context was loaded."],
    };
  }
  return resolveCommittedPersonas(projectRoot, personaIds, options);
}

/** The routes that send each participant its persona. The scripted and preview routes record the id only. */
const ROUTES_THAT_SEND_PERSONAS: ReadonlySet<StudyRoute> = new Set([
  "computer-use",
  "shared-world",
  "terminal",
]);

/** Whether `route` sends each participant its persona, so a persona that reaches one needs its file. */
export function routeSendsPersonas(route: StudyRoute): boolean {
  return ROUTES_THAT_SEND_PERSONAS.has(route);
}

/**
 * The persona ids that reach a participant: each planned participant's on the computer-use and
 * shared-world routes, the agent's on the terminal route, and none on the routes that send no
 * persona. An `actor.persona` that every roster entry overrides reaches no one.
 */
function participantPersonaIds(config: StudyConfig): (string | undefined)[] {
  switch (routeOf(config)) {
    case "computer-use":
      return computerUseParticipants(config).map((participant) => participant.personaId);
    case "shared-world":
      return sharedWorldParticipants(config).participants.map(
        (participant) => participant.personaId,
      );
    case "terminal":
      return [config.actor?.persona];
    default:
      return [];
  }
}

/**
 * Every persona the study names (`studyPersonaIds`), resolved from a plain cwd. A persona that
 * reaches a participant on a route that sends personas must resolve: with no readable file it
 * throws a PersonaConfigError before anything runs. Any other named persona, such as one on the
 * scripted route or an `actor.persona` every participant overrides, keeps the warning. A caller with
 * a plan passes its participants' persona ids, which a run's count can add to.
 */
export async function resolveStudyPersonas(
  cwd: string,
  config: StudyConfig,
  reaching: readonly (string | undefined)[] = participantPersonaIds(config),
): Promise<{ personas: Map<string, ResolvedPersona>; warnings: string[] }> {
  const required = new Set(reaching.filter((id): id is string => Boolean(id)));
  const rest = studyPersonaIds(config).filter((id) => !required.has(id));
  const named = await resolveCommittedPersonasForCwd(cwd, [...required]);
  const others = await resolveCommittedPersonasForCwd(cwd, rest, { required: false });
  return {
    personas: new Map([...named.personas, ...others.personas]),
    warnings: [...named.warnings, ...others.warnings],
  };
}
