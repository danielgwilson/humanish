import { studyPersonaIds, resolveCommittedPersonasForCwd } from "./persona-resolve.js";
import { personaBrief, PersonaConfigError } from "./persona.js";
import type { ActorPersonaRef } from "../actors/contract.js";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { parseStudy } from "./config.js";
import { STUDY_SCHEMA, type StudyConfig } from "./types.js";
import {
  assertPreparedSelectedOutputDirectory,
  assertSafeOutputPathSegment,
  prepareSelectedOutputDirectory,
  readContainedRegularFile,
  type PreparedSelectedOutputDirectory,
} from "../run/contained-output.js";
import { isNodeError } from "../run/type-guards.js";
import { studyFileCandidates, studyFileStem, STUDY_DIRECTORIES } from "./files.js";

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
    code: "HUMANISH_STUDY_NOT_FOUND" | "HUMANISH_STUDY_INVALID" | "HUMANISH_STUDY_AMBIGUOUS";
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
  /** Why `run` refuses this file by name: its stem also names a file in the other directory family. */
  error?: string;
}

export interface StudyListResult {
  schema: typeof STUDY_LIST_SCHEMA;
  ok: true;
  cwd: string;
  studies: StudyListEntry[];
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

  // A studies/ file wins over every labs/ file. The same stem under both families is an error, so
  // neither file silently shadows the other.
  const candidates = studyFileCandidates(lab);
  for (const candidate of candidates) {
    const read = await readManagedManifest(projectRoot, candidate.relativePath);
    if (read.status === "missing") {
      continue;
    }
    if (read.status === "unsafe") {
      return invalidStudy({ cwd: resolvedCwd, lab, warnings }, read.message);
    }
    if (candidate.directory.family === "studies") {
      for (const other of candidates.filter((entry) => entry.directory.family === "labs")) {
        const present = await inspectManagedPath(projectRoot, other.relativePath, "file");
        if (present.status !== "missing")
          return ambiguousStudy(
            resolvedCwd,
            lab,
            [candidate.relativePath, other.relativePath],
            warnings,
          );
      }
    }
    return parseResolvedStudy({
      cwd: resolvedCwd,
      lab,
      origin: candidate.directory.origin,
      path: path.join(resolvedCwd, candidate.relativePath),
      warnings,
      contents: read.contents,
    });
  }

  return studyNotFound(resolvedCwd, lab, warnings);
}

export async function listStudyManifests(cwd: string): Promise<StudyListResult> {
  const resolvedCwd = path.resolve(cwd);
  const warnings: string[] = [];
  const listed = new Map<string, StudyListEntry>();
  const projectRoot = await bindProjectRoot(resolvedCwd);
  if (!projectRoot) {
    return {
      schema: STUDY_LIST_SCHEMA,
      ok: true,
      cwd: resolvedCwd,
      studies: [],
      warnings: ["Project root failed containment validation; study files were skipped."],
    };
  }

  let legacyFiles = 0;
  // Each stem's files by directory family, to mark the stems that name a file in both.
  const stems = new Map<string, { studies?: string; legacy?: string; keys: string[] }>();

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
      const stem = stemSlot(stems, studyFileStem(name) ?? name);
      stem[entry.family === "studies" ? "studies" : "legacy"] ??= relativeToCwd(
        resolvedCwd,
        path.join(resolvedCwd, relativePath),
      );

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
      });
      if (!parsed.ok) {
        warnings.push(`${relativeToCwd(resolvedCwd, requestedPath)}: ${parsed.error.message}`);
        continue;
      }
      if (legacyStudyWarning(parsed.path, parsed.config.schema) !== undefined) legacyFiles += 1;

      const key = `${parsed.config.id}:${entry.origin}:${relativeToCwd(resolvedCwd, requestedPath)}`;
      stem.keys.push(key);
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

  if (legacyFiles > 0) {
    warnings.push(
      `${legacyFiles === 1 ? "One study file uses" : `${legacyFiles} study files use`} humanish.lab.v2 or a labs/ directory, which 0.109 stops reading. humanish migrate converts and moves the v2 files; humanish study show names the fix for each file.`,
    );
  }
  for (const [name, stem] of stems) {
    if (stem.studies === undefined || stem.legacy === undefined) continue;
    const error = `${name} names two files, ${stem.studies} and ${stem.legacy}; running it by name fails until you delete one (humanish migrate moves a kept labs/ file).`;
    for (const key of stem.keys) {
      const entry = listed.get(key);
      if (entry) entry.error = error;
    }
  }

  return {
    schema: STUDY_LIST_SCHEMA,
    ok: true,
    cwd: resolvedCwd,
    studies: [...listed.values()].sort((left, right) =>
      `${left.origin}:${left.id}`.localeCompare(`${right.origin}:${right.id}`),
    ),
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

  const parsed = parseStudy(raw);
  if (!parsed.ok) {
    return invalidStudy(args, parsed.error.message);
  }

  const warnings = [...args.warnings, ...parsed.warnings];
  const legacy = legacyStudyWarning(relativeToCwd(args.cwd, args.path), parsed.config.schema);
  if (legacy !== undefined) warnings.push(legacy);
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
 * What 0.109 stops reading in this file: the humanish.lab.v2 format, a labs/ directory, or both, and
 * what to run about it. Undefined for a v3 file outside the labs/ directories.
 */
function legacyStudyWarning(relativePath: string, schema: string): string | undefined {
  const retiredDirectory = STUDY_DIRECTORIES.find(
    (directory) =>
      directory.family === "labs" && path.dirname(relativePath) === directory.relativeDir,
  );
  // A file discovery parsed has one of two schemas, so not v3 is v2.
  const v2 = schema !== STUDY_SCHEMA;
  if (retiredDirectory !== undefined) {
    const studies = retiredDirectory.relativeDir.replace(/labs$/, "studies");
    return v2
      ? `${relativePath} is a humanish.lab.v2 file in ${retiredDirectory.relativeDir}/, and 0.109 reads neither. Run humanish migrate to convert it and move it to ${studies}/.`
      : `${relativePath} is in ${retiredDirectory.relativeDir}/, which 0.109 stops reading. Move it to ${studies}/.`;
  }
  return v2
    ? `${relativePath} is a humanish.lab.v2 file, which 0.109 stops reading. Run humanish migrate ${relativePath} to convert it.`
    : undefined;
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

function stemSlot(
  stems: Map<string, { studies?: string; legacy?: string; keys: string[] }>,
  name: string,
): { studies?: string; legacy?: string; keys: string[] } {
  let slot = stems.get(name);
  if (slot === undefined) {
    slot = { keys: [] };
    stems.set(name, slot);
  }
  return slot;
}

/** The same stem under a studies/ and a labs/ directory: discovery reads neither. */
function ambiguousStudy(
  cwd: string,
  name: string,
  paths: [studiesPath: string, labsPath: string],
  warnings: string[],
): StudyResolveFailure {
  const [studiesPath, labsPath] = paths.map((entry) => entry.replace(/\\/g, "/"));
  return {
    ok: false,
    cwd,
    study: name,
    error: {
      code: "HUMANISH_STUDY_AMBIGUOUS",
      message: `${name} names two files, ${studiesPath} and ${labsPath}. Delete the one you do not want; if you keep ${labsPath}, run humanish migrate to move it. Or pass the path of the one to run.`,
    },
    warnings,
  };
}

function studyNotFound(cwd: string, lab: string, warnings: string[]): StudyResolveFailure {
  return {
    ok: false,
    cwd,
    study: lab,
    error: {
      code: "HUMANISH_STUDY_NOT_FOUND",
      message: `Study not found: ${lab}. Look in humanish/studies/ or humanish/labs/, or pass a .yaml path.`,
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
