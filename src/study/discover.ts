import { studyPersonaIds, resolveCommittedPersonasForCwd } from "./persona-resolve.js";
import { personaBrief, PersonaConfigError } from "./persona.js";
import type { ActorPersonaRef } from "../actors/contract.js";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { parseStudy } from "./config.js";
import { V2_SCHEMA, type StudyConfig } from "./types.js";
import {
  assertPreparedSelectedOutputDirectory,
  assertSafeOutputPathSegment,
  prepareSelectedOutputDirectory,
  readContainedRegularFile,
  type PreparedSelectedOutputDirectory,
} from "../run/contained-output.js";
import { isNodeError } from "../run/type-guards.js";
import { studyFileCandidates, STUDY_DIRECTORIES } from "./files.js";

const STUDY_LIST_SCHEMA = "humanish.study-list.v1";
const STUDY_SHOW_SCHEMA = "humanish.study-show.v1";

type StudyOrigin = "committed" | "ignored" | "explicit";

interface ResolvedStudyConfig {
  config: StudyConfig;
  origin: StudyOrigin;
  path: string;
  warnings: string[];
}

export interface StudyResolveFailure {
  ok: false;
  cwd: string;
  /** The study the caller asked for, as given. */
  study: string;
  error: {
    code:
      | "HUMANISH_STUDY_NOT_FOUND"
      | "HUMANISH_STUDY_INVALID"
      | "HUMANISH_STUDY_V2_UNSUPPORTED"
      | "HUMANISH_STUDY_RETIRED_DIRECTORY";
    message: string;
  };
  warnings: string[];
}

export type StudyResolveResult = ({ ok: true } & ResolvedStudyConfig) | StudyResolveFailure;

export interface StudyListEntry {
  id: string;
  source: StudyConfig["subject"]["source"];
  origin: StudyOrigin;
  path: string;
  title?: string;
  /**
   * The manifest's own first sentence. The list is where someone decides which study to open, and a
   * list of names cannot answer "what is this one" for a project with twenty labs in it; the
   * stakeholder feedback that added this was, verbatim, "so i know wtf they are".
   */
  description?: string;
}

/** A file in a study directory that humanish no longer reads, with what to do about it. */
interface RetiredStudyFile {
  path: string;
  code: "HUMANISH_STUDY_V2_UNSUPPORTED" | "HUMANISH_STUDY_RETIRED_DIRECTORY";
  message: string;
}

export interface StudyListResult {
  schema: typeof STUDY_LIST_SCHEMA;
  ok: true;
  cwd: string;
  studies: StudyListEntry[];
  /** Each also has its message in `warnings`. */
  retired: RetiredStudyFile[];
  warnings: string[];
}

export interface StudyInspectResult {
  /** Persona context only, before route instructions and runtime grants. */
  personas?: Array<{ id: string; resolved: boolean; brief?: ActorPersonaRef["brief"] }>;
  schema: typeof STUDY_SHOW_SCHEMA;
  ok: boolean;
  cwd: string;
  /** The study the caller asked for, as given. */
  study: string;
  config?: StudyConfig;
  origin?: StudyOrigin;
  path?: string;
  error?: StudyResolveFailure["error"];
  warnings: string[];
}

type ManifestReadResult =
  | { status: "missing" }
  | { status: "unsafe"; message: string }
  | { status: "ok"; contents: string };

interface ManagedDirectoryBinding {
  birthtimeNs: bigint;
  dev: bigint;
  ino: bigint;
  physicalPath: string;
}

type ManagedDirectoryResult =
  | { status: "missing" }
  | { status: "unsafe"; message: string }
  | { status: "ok"; binding: ManagedDirectoryBinding };

export async function resolveStudyManifest(cwd: string, lab: string): Promise<StudyResolveResult> {
  const resolvedCwd = path.resolve(cwd);
  const warnings: string[] = [];
  const projectRoot = await bindProjectRoot(resolvedCwd);
  if (!projectRoot) {
    return invalidStudy(
      { cwd: resolvedCwd, lab, warnings },
      "Project root failed containment validation.",
    );
  }

  if (studyLooksLikePath(lab)) {
    const requestedPath = path.resolve(resolvedCwd, lab);
    const read = await readExplicitManifest(projectRoot, requestedPath);
    if (read.status === "missing") {
      return studyNotFound(resolvedCwd, lab, warnings);
    }
    if (read.status === "unsafe") {
      return invalidStudy({ cwd: resolvedCwd, lab, warnings }, read.message);
    }
    return parseResolvedStudy({
      cwd: resolvedCwd,
      lab,
      origin: "explicit",
      path: requestedPath,
      warnings,
      contents: read.contents,
    });
  }

  // The studies/ directories are read in order. A name found only under a labs/ directory is
  // refused with what to do about it, so the user is not told the study does not exist.
  for (const candidate of studyFileCandidates(lab)) {
    const read = await readManagedManifest(projectRoot, candidate.relativePath);
    if (read.status === "missing") {
      continue;
    }
    if (read.status === "unsafe") {
      return invalidStudy({ cwd: resolvedCwd, lab, warnings }, read.message);
    }
    return parseResolvedStudy({
      cwd: resolvedCwd,
      lab,
      origin: candidate.directory.origin,
      path: path.join(resolvedCwd, candidate.relativePath),
      warnings,
      contents: read.contents,
      retiredDirectory: candidate.directory.family === "labs",
    });
  }

  return studyNotFound(resolvedCwd, lab, warnings);
}

export async function listStudyManifests(cwd: string): Promise<StudyListResult> {
  const resolvedCwd = path.resolve(cwd);
  const warnings: string[] = [];
  const retired: RetiredStudyFile[] = [];
  const listed = new Map<string, StudyListEntry>();
  const projectRoot = await bindProjectRoot(resolvedCwd);
  if (!projectRoot) {
    return {
      schema: STUDY_LIST_SCHEMA,
      ok: true,
      cwd: resolvedCwd,
      studies: [],
      retired: [],
      warnings: ["Project root failed containment validation; study files were skipped."],
    };
  }

  for (const entry of STUDY_DIRECTORIES) {
    const directory = await bindManagedDirectory(projectRoot, entry.relativeDir);
    if (directory.status === "missing") {
      continue;
    }
    if (directory.status === "unsafe") {
      warnings.push(`${entry.relativeDir}: ${directory.message}`);
      continue;
    }

    let names: string[];
    try {
      names = await readdir(directory.binding.physicalPath);
      await assertManagedDirectoryBinding(projectRoot, entry.relativeDir, directory.binding);
    } catch {
      warnings.push(`${entry.relativeDir}: unsafe managed study directory; skipped.`);
      continue;
    }

    for (const name of names.filter((value) => value.endsWith(".yaml") || value.endsWith(".yml"))) {
      let relativePath: string;
      try {
        assertSafeOutputPathSegment(name, "Study file name");
        relativePath = path.join(entry.relativeDir, name);
      } catch {
        warnings.push(`${entry.relativeDir}: unsafe study file name; skipped.`);
        continue;
      }
      const requestedPath = path.join(resolvedCwd, relativePath);
      const read = await readManagedManifest(projectRoot, relativePath);
      if (read.status !== "ok") {
        warnings.push(
          `${relativeToCwd(resolvedCwd, requestedPath)}: ${read.status === "unsafe" ? read.message : "study file changed while it was listed; skipped."}`,
        );
        continue;
      }

      const parsed = parseResolvedStudy({
        cwd: resolvedCwd,
        lab: name.replace(/\.(?:ya?ml)$/i, ""),
        origin: entry.origin,
        path: requestedPath,
        warnings: [],
        contents: read.contents,
        retiredDirectory: entry.family === "labs",
      });
      if (!parsed.ok) {
        const { code, message } = parsed.error;
        if (
          code === "HUMANISH_STUDY_V2_UNSUPPORTED" ||
          code === "HUMANISH_STUDY_RETIRED_DIRECTORY"
        ) {
          // The message already starts with the file's path.
          retired.push({ path: relativeToCwd(resolvedCwd, requestedPath), code, message });
          warnings.push(message);
        } else {
          warnings.push(`${relativeToCwd(resolvedCwd, requestedPath)}: ${message}`);
        }
        continue;
      }

      const key = `${parsed.config.id}:${entry.origin}:${relativeToCwd(resolvedCwd, requestedPath)}`;
      listed.set(key, {
        id: parsed.config.id,
        source: parsed.config.subject.source,
        origin: entry.origin,
        path: relativeToCwd(resolvedCwd, requestedPath),
        ...(parsed.config.title ? { title: parsed.config.title } : {}),
        ...(typeof parsed.config.description === "string" &&
        parsed.config.description.trim().length > 0
          ? { description: parsed.config.description.trim() }
          : {}),
      });
    }
  }

  return {
    schema: STUDY_LIST_SCHEMA,
    ok: true,
    cwd: resolvedCwd,
    studies: [...listed.values()].sort((left, right) =>
      `${left.origin}:${left.id}`.localeCompare(`${right.origin}:${right.id}`),
    ),
    retired,
    warnings,
  };
}

export async function inspectStudyManifest(cwd: string, lab: string): Promise<StudyInspectResult> {
  const resolved = await resolveStudyManifest(cwd, lab);
  if (!resolved.ok) {
    return {
      schema: STUDY_SHOW_SCHEMA,
      ok: false,
      cwd: resolved.cwd,
      study: lab,
      error: resolved.error,
      warnings: resolved.warnings,
    };
  }

  let personaResolution;
  try {
    personaResolution = await resolveCommittedPersonasForCwd(cwd, studyPersonaIds(resolved.config));
  } catch (error) {
    if (!(error instanceof PersonaConfigError)) throw error;
    return {
      schema: STUDY_SHOW_SCHEMA,
      ok: false,
      cwd: path.resolve(cwd),
      study: lab,
      error: { code: "HUMANISH_STUDY_INVALID", message: error.message },
      warnings: resolved.warnings,
    };
  }
  return {
    schema: STUDY_SHOW_SCHEMA,
    personas: studyPersonaIds(resolved.config).map((id) => {
      const persona = personaResolution.personas.get(id);
      return { id, resolved: !!persona, ...(persona ? { brief: personaBrief(persona) } : {}) };
    }),
    ok: true,
    cwd: path.resolve(cwd),
    study: lab,
    config: resolved.config,
    origin: resolved.origin,
    path: resolved.path,
    warnings: [...resolved.warnings, ...personaResolution.warnings],
  };
}

function parseResolvedStudy(args: {
  cwd: string;
  lab: string;
  origin: StudyOrigin;
  path: string;
  warnings: string[];
  contents: string;
  /** Found by name or listed in a labs/ directory, which humanish no longer reads. */
  retiredDirectory?: boolean;
}): StudyResolveResult {
  let raw: unknown;
  try {
    raw = parse(args.contents);
  } catch (error: unknown) {
    return invalidStudy(
      args,
      error instanceof Error ? error.message : "The study file's YAML could not be parsed.",
    );
  }

  const refusal = retiredStudyRefusal(
    relativeToCwd(args.cwd, args.path).replace(/\\/g, "/"),
    raw,
    args.retiredDirectory === true,
  );
  if (refusal !== undefined) {
    return { ok: false, cwd: args.cwd, study: args.lab, error: refusal, warnings: args.warnings };
  }

  const parsed = parseStudy(raw);
  if (!parsed.ok) {
    return invalidStudy(args, parsed.error.message);
  }

  const warnings = [...args.warnings, ...parsed.warnings];
  if (args.path.endsWith(".yml")) {
    warnings.push("Prefer .yaml for study files; .yml is accepted for compatibility only.");
  }

  return {
    ok: true,
    config: parsed.config,
    origin: args.origin,
    path: relativeToCwd(args.cwd, args.path),
    warnings,
  };
}

/**
 * Why humanish refuses this file, or undefined. A humanish.lab.v2 file is refused wherever it is,
 * and `humanish migrate` converts it (and moves it out of a labs/ directory). A v3 file is refused
 * only when it was found by name in a labs/ directory; an explicit path to it still runs.
 */
function retiredStudyRefusal(
  relativePath: string,
  raw: unknown,
  retiredDirectory: boolean,
): StudyResolveFailure["error"] | undefined {
  const directory = path.posix.dirname(relativePath);
  const studies = directory.replace(/labs$/, "studies");
  // migrate moves a v2 file out of a labs/ directory however the file was named.
  const inLabs = STUDY_DIRECTORIES.some(
    (entry) => entry.family === "labs" && entry.relativeDir.replace(/\\/g, "/") === directory,
  );
  // migrate refuses a path outside its --cwd, so a file outside the project gets its own directory.
  const migrate = path.isAbsolute(relativePath)
    ? `humanish migrate --cwd ${shellPath(path.dirname(relativePath))} ${shellPath(path.basename(relativePath))}`
    : `humanish migrate ${shellPath(relativePath)}`;
  if (typeof raw === "object" && raw !== null && (raw as { schema?: unknown }).schema === V2_SCHEMA)
    return {
      code: "HUMANISH_STUDY_V2_UNSUPPORTED",
      message: inLabs
        ? `${relativePath} is a humanish.lab.v2 file in ${directory}/, which humanish no longer reads. Run ${migrate} to convert it and move it to ${studies}/.`
        : `${relativePath} is a humanish.lab.v2 file, which humanish no longer reads. Run ${migrate} to convert it.`,
    };
  if (retiredDirectory)
    return {
      code: "HUMANISH_STUDY_RETIRED_DIRECTORY",
      message: `${relativePath} is in ${directory}/, which humanish no longer reads. Move it to ${studies}/.`,
    };
  return undefined;
}

/** A path as one shell argument: quoted when the shell would split or expand it, never an option. */
function shellPath(value: string): string {
  const arg = value.startsWith("-") ? `./${value}` : value;
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

async function bindProjectRoot(cwd: string): Promise<PreparedSelectedOutputDirectory | null> {
  try {
    const lexical = await lstat(cwd);
    if (!lexical.isDirectory() && !lexical.isSymbolicLink()) {
      return null;
    }
    return await prepareSelectedOutputDirectory(path.dirname(cwd), cwd);
  } catch {
    return null;
  }
}

async function readManagedManifest(
  projectRoot: PreparedSelectedOutputDirectory,
  relativePath: string,
): Promise<ManifestReadResult> {
  const inspected = await inspectManagedPath(projectRoot, relativePath, "file");
  if (inspected.status !== "ok") {
    return inspected;
  }
  const contents = await readContainedRegularFile(projectRoot, relativePath.replace(/\\/g, "/"));
  if (!contents) {
    return {
      status: "unsafe",
      message: "The study file changed or failed containment validation.",
    };
  }
  return { status: "ok", contents: contents.toString("utf8") };
}

async function readExplicitManifest(
  projectRoot: PreparedSelectedOutputDirectory,
  requestedPath: string,
): Promise<ManifestReadResult> {
  try {
    await assertPreparedSelectedOutputDirectory(projectRoot);
    try {
      await lstat(requestedPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { status: "missing" };
      }
      throw error;
    }

    const physicalPath = await realpath(requestedPath);
    const before = await lstat(physicalPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
      return {
        status: "unsafe",
        message: "The study file path must resolve to a single-link regular file.",
      };
    }

    const handle = await open(physicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat({ bigint: true });
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino
      ) {
        return {
          status: "unsafe",
          message: "The study file changed before it could be read safely.",
        };
      }
      const contents = await handle.readFile();
      const [currentPhysicalPath, after] = await Promise.all([
        realpath(requestedPath),
        lstat(physicalPath, { bigint: true }),
      ]);
      await assertPreparedSelectedOutputDirectory(projectRoot);
      if (
        currentPhysicalPath !== physicalPath ||
        !after.isFile() ||
        after.isSymbolicLink() ||
        after.nlink !== 1n ||
        after.dev !== before.dev ||
        after.ino !== before.ino
      ) {
        return {
          status: "unsafe",
          message: "The study file changed while it was being read.",
        };
      }
      return { status: "ok", contents: contents.toString("utf8") };
    } finally {
      await handle.close();
    }
  } catch {
    return { status: "unsafe", message: "The study file path failed containment validation." };
  }
}

async function bindManagedDirectory(
  projectRoot: PreparedSelectedOutputDirectory,
  relativePath: string,
): Promise<ManagedDirectoryResult> {
  const inspected = await inspectManagedPath(projectRoot, relativePath, "directory");
  if (inspected.status !== "ok") {
    return inspected;
  }
  return {
    status: "ok",
    binding: {
      birthtimeNs: inspected.birthtimeNs,
      dev: inspected.dev,
      ino: inspected.ino,
      physicalPath: inspected.physicalPath,
    },
  };
}

async function inspectManagedPath(
  projectRoot: PreparedSelectedOutputDirectory,
  relativePath: string,
  expectedKind: "directory" | "file",
): Promise<
  | { status: "missing" }
  | { status: "unsafe"; message: string }
  | { status: "ok"; birthtimeNs: bigint; dev: bigint; ino: bigint; physicalPath: string }
> {
  try {
    await assertPreparedSelectedOutputDirectory(projectRoot);
    const segments = relativePath.replace(/\\/g, "/").split("/");
    let current = projectRoot.physicalPath;
    for (const [index, segment] of segments.entries()) {
      assertSafeOutputPathSegment(segment, "Study file path segment");
      current = path.join(current, segment);
      let stats;
      try {
        stats = await lstat(current, { bigint: true });
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return { status: "missing" };
        }
        throw error;
      }
      const leaf = index === segments.length - 1;
      if (stats.isSymbolicLink()) {
        return {
          status: "unsafe",
          message: "Study directory paths must not contain symbolic links.",
        };
      }
      if (!leaf && !stats.isDirectory()) {
        return { status: "unsafe", message: "Study file path parents must be directories." };
      }
      if (leaf && expectedKind === "directory" && !stats.isDirectory()) {
        return { status: "unsafe", message: "A study directory has an unsafe file type." };
      }
      if (leaf && expectedKind === "file" && (!stats.isFile() || stats.nlink !== 1n)) {
        return {
          status: "unsafe",
          message: "A study file must be a single-link regular file.",
        };
      }
      if (leaf) {
        await assertPreparedSelectedOutputDirectory(projectRoot);
        return {
          status: "ok",
          birthtimeNs: stats.birthtimeNs,
          dev: stats.dev,
          ino: stats.ino,
          physicalPath: current,
        };
      }
    }
  } catch {
    return { status: "unsafe", message: "A study file path failed containment validation." };
  }
  return { status: "missing" };
}

async function assertManagedDirectoryBinding(
  projectRoot: PreparedSelectedOutputDirectory,
  relativePath: string,
  binding: ManagedDirectoryBinding,
): Promise<void> {
  await assertPreparedSelectedOutputDirectory(projectRoot);
  const current = await inspectManagedPath(projectRoot, relativePath, "directory");
  if (
    current.status !== "ok" ||
    current.physicalPath !== binding.physicalPath ||
    current.birthtimeNs !== binding.birthtimeNs ||
    current.dev !== binding.dev ||
    current.ino !== binding.ino
  ) {
    throw new Error("Managed study directory identity changed after it was bound.");
  }
}

function invalidStudy(
  args: {
    cwd: string;
    lab: string;
    warnings: string[];
  },
  message: string,
): StudyResolveFailure {
  return {
    ok: false,
    cwd: args.cwd,
    study: args.lab,
    error: {
      code: "HUMANISH_STUDY_INVALID",
      message,
    },
    warnings: args.warnings,
  };
}

function studyNotFound(cwd: string, lab: string, warnings: string[]): StudyResolveFailure {
  return {
    ok: false,
    cwd,
    study: lab,
    error: {
      code: "HUMANISH_STUDY_NOT_FOUND",
      message: `Study not found: ${lab}. Look in humanish/studies/, or pass a .yaml path.`,
    },
    warnings,
  };
}

function studyLooksLikePath(lab: string): boolean {
  return (
    lab.endsWith(".yaml") ||
    lab.endsWith(".yml") ||
    lab.includes("/") ||
    lab.includes("\\") ||
    lab.startsWith(".")
  );
}

function relativeToCwd(cwd: string, filePath: string): string {
  const relative = path.relative(cwd, filePath);
  return relative && !relative.startsWith("..") ? relative : filePath;
}
