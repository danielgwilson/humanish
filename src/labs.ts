import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { parseLabConfig, type LabConfig } from "./lab-config.js";
import {
  assertPreparedSelectedOutputDirectory,
  assertSafeOutputPathSegment,
  prepareSelectedOutputDirectory,
  readContainedRegularFile,
  type PreparedSelectedOutputDirectory
} from "./selected-output-paths.js";

export { LAB_CONFIG_SCHEMA } from "./lab-config.js";
export type { LabConfig } from "./lab-config.js";

export const LAB_LIST_SCHEMA = "humanish.lab-list.v1";
export const LAB_INSPECT_SCHEMA = "humanish.lab-inspect.v1";

export type LabOrigin = "committed" | "ignored" | "explicit";

export interface ResolvedLabConfig {
  config: LabConfig;
  origin: LabOrigin;
  path: string;
  warnings: string[];
}

export interface LabResolveFailure {
  ok: false;
  cwd: string;
  lab: string;
  error: {
    code: "HUMANISH_LAB_NOT_FOUND" | "HUMANISH_LAB_INVALID";
    message: string;
  };
  warnings: string[];
}

export type LabResolveResult =
  | ({ ok: true } & ResolvedLabConfig)
  | LabResolveFailure;

export interface LabListEntry {
  id: string;
  source: LabConfig["subject"]["source"];
  origin: LabOrigin;
  path: string;
  title?: string;
}

export interface LabListResult {
  schema: typeof LAB_LIST_SCHEMA;
  ok: true;
  cwd: string;
  labs: LabListEntry[];
  warnings: string[];
}

export interface LabInspectResult {
  schema: typeof LAB_INSPECT_SCHEMA;
  ok: boolean;
  cwd: string;
  lab: string;
  config?: LabConfig;
  origin?: LabOrigin;
  path?: string;
  error?: LabResolveFailure["error"];
  warnings: string[];
}

type ManifestReadResult =
  | { status: "missing" }
  | { status: "unsafe"; message: string }
  | { status: "ok"; contents: string };

interface ManagedDirectoryBinding {
  dev: bigint;
  ino: bigint;
  physicalPath: string;
}

type ManagedDirectoryResult =
  | { status: "missing" }
  | { status: "unsafe"; message: string }
  | { status: "ok"; binding: ManagedDirectoryBinding };

const committedLabsDir = path.join("humanish", "labs");
const ignoredLabsDirs = [
  path.join(".humanish", "labs"),
  path.join(".humanish", "local", "labs")
] as const;

export async function resolveLabManifest(cwd: string, lab: string): Promise<LabResolveResult> {
  const resolvedCwd = path.resolve(cwd);
  const warnings: string[] = [];
  const projectRoot = await bindProjectRoot(resolvedCwd);
  if (!projectRoot) {
    return invalidLab({ cwd: resolvedCwd, lab, warnings }, "Project root failed containment validation.");
  }

  if (labLooksLikePath(lab)) {
    const requestedPath = path.resolve(resolvedCwd, lab);
    const read = await readExplicitManifest(projectRoot, requestedPath);
    if (read.status === "missing") {
      return labNotFound(resolvedCwd, lab, warnings);
    }
    if (read.status === "unsafe") {
      return invalidLab({ cwd: resolvedCwd, lab, warnings }, read.message);
    }
    return parseResolvedLab({
      cwd: resolvedCwd,
      lab,
      origin: "explicit",
      path: requestedPath,
      warnings,
      contents: read.contents
    });
  }

  const candidates = [
    { origin: "committed" as const, relativePath: path.join(committedLabsDir, `${lab}.yaml`) },
    { origin: "committed" as const, relativePath: path.join(committedLabsDir, `${lab}.yml`) },
    ...ignoredLabsDirs.flatMap((dir) => [
      { origin: "ignored" as const, relativePath: path.join(dir, `${lab}.yaml`) },
      { origin: "ignored" as const, relativePath: path.join(dir, `${lab}.yml`) }
    ])
  ];

  for (const candidate of candidates) {
    const requestedPath = path.join(resolvedCwd, candidate.relativePath);
    const read = await readManagedManifest(projectRoot, candidate.relativePath);
    if (read.status === "missing") {
      continue;
    }
    if (read.status === "unsafe") {
      return invalidLab({ cwd: resolvedCwd, lab, warnings }, read.message);
    }
    return parseResolvedLab({
      cwd: resolvedCwd,
      lab,
      origin: candidate.origin,
      path: requestedPath,
      warnings,
      contents: read.contents
    });
  }

  return labNotFound(resolvedCwd, lab, warnings);
}

export async function listLabManifests(cwd: string): Promise<LabListResult> {
  const resolvedCwd = path.resolve(cwd);
  const warnings: string[] = [];
  const labs = new Map<string, LabListEntry>();
  const projectRoot = await bindProjectRoot(resolvedCwd);
  if (!projectRoot) {
    return {
      schema: LAB_LIST_SCHEMA,
      ok: true,
      cwd: resolvedCwd,
      labs: [],
      warnings: ["Project root failed containment validation; managed lab manifests were skipped."]
    };
  }

  const dirs = [
    { origin: "committed" as const, relativeDir: committedLabsDir },
    ...ignoredLabsDirs.map((relativeDir) => ({ origin: "ignored" as const, relativeDir }))
  ];

  for (const entry of dirs) {
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
      warnings.push(`${entry.relativeDir}: unsafe managed lab directory; skipped.`);
      continue;
    }

    for (const name of names.filter((value) => value.endsWith(".yaml") || value.endsWith(".yml"))) {
      let relativePath: string;
      try {
        assertSafeOutputPathSegment(name, "Lab manifest name");
        relativePath = path.join(entry.relativeDir, name);
      } catch {
        warnings.push(`${entry.relativeDir}: unsafe lab manifest name; skipped.`);
        continue;
      }

      const requestedPath = path.join(resolvedCwd, relativePath);
      const read = await readManagedManifest(projectRoot, relativePath);
      if (read.status !== "ok") {
        warnings.push(`${relativeToCwd(resolvedCwd, requestedPath)}: ${read.status === "unsafe" ? read.message : "manifest changed while it was listed; skipped."}`);
        continue;
      }

      const parsed = parseResolvedLab({
        cwd: resolvedCwd,
        lab: name.replace(/\.(?:ya?ml)$/i, ""),
        origin: entry.origin,
        path: requestedPath,
        warnings: [],
        contents: read.contents
      });
      if (!parsed.ok) {
        warnings.push(`${relativeToCwd(resolvedCwd, requestedPath)}: ${parsed.error.message}`);
        continue;
      }

      const key = `${parsed.config.id}:${entry.origin}:${relativeToCwd(resolvedCwd, requestedPath)}`;
      labs.set(key, {
        id: parsed.config.id,
        source: parsed.config.subject.source,
        origin: entry.origin,
        path: relativeToCwd(resolvedCwd, requestedPath),
        ...(parsed.config.title ? { title: parsed.config.title } : {})
      });
    }
  }

  return {
    schema: LAB_LIST_SCHEMA,
    ok: true,
    cwd: resolvedCwd,
    labs: [...labs.values()].sort((left, right) => `${left.origin}:${left.id}`.localeCompare(`${right.origin}:${right.id}`)),
    warnings
  };
}

export async function inspectLabManifest(cwd: string, lab: string): Promise<LabInspectResult> {
  const resolved = await resolveLabManifest(cwd, lab);
  if (!resolved.ok) {
    return {
      schema: LAB_INSPECT_SCHEMA,
      ok: false,
      cwd: resolved.cwd,
      lab,
      error: resolved.error,
      warnings: resolved.warnings
    };
  }

  return {
    schema: LAB_INSPECT_SCHEMA,
    ok: true,
    cwd: path.resolve(cwd),
    lab,
    config: resolved.config,
    origin: resolved.origin,
    path: resolved.path,
    warnings: resolved.warnings
  };
}

function parseResolvedLab(args: {
  cwd: string;
  lab: string;
  origin: LabOrigin;
  path: string;
  warnings: string[];
  contents: string;
}): LabResolveResult {
  let raw: unknown;
  try {
    raw = parse(args.contents);
  } catch (error: unknown) {
    return invalidLab(args, error instanceof Error ? error.message : "Lab YAML could not be parsed.");
  }

  const parsed = parseLabConfig(raw);
  if (!parsed.ok) {
    return invalidLab(args, parsed.error.message);
  }

  const warnings = [...args.warnings, ...parsed.warnings];
  if (args.path.endsWith(".yml")) {
    warnings.push("Prefer .yaml for Humanish-authored lab source; .yml is accepted for compatibility only.");
  }

  return {
    ok: true,
    config: parsed.config,
    origin: args.origin,
    path: relativeToCwd(args.cwd, args.path),
    warnings
  };
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
  relativePath: string
): Promise<ManifestReadResult> {
  const inspected = await inspectManagedPath(projectRoot, relativePath, "file");
  if (inspected.status !== "ok") {
    return inspected;
  }
  const contents = await readContainedRegularFile(projectRoot, relativePath.replace(/\\/g, "/"));
  if (!contents) {
    return { status: "unsafe", message: "Managed lab manifest changed or failed containment validation." };
  }
  return { status: "ok", contents: contents.toString("utf8") };
}

async function readExplicitManifest(
  projectRoot: PreparedSelectedOutputDirectory,
  requestedPath: string
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
      return { status: "unsafe", message: "Explicit lab manifest must resolve to a single-link regular file." };
    }

    const handle = await open(physicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat({ bigint: true });
      if (
        !opened.isFile()
        || opened.nlink !== 1n
        || opened.dev !== before.dev
        || opened.ino !== before.ino
      ) {
        return { status: "unsafe", message: "Explicit lab manifest changed before it could be read safely." };
      }
      const contents = await handle.readFile();
      const [currentPhysicalPath, after] = await Promise.all([
        realpath(requestedPath),
        lstat(physicalPath, { bigint: true })
      ]);
      await assertPreparedSelectedOutputDirectory(projectRoot);
      if (
        currentPhysicalPath !== physicalPath
        || !after.isFile()
        || after.isSymbolicLink()
        || after.nlink !== 1n
        || after.dev !== before.dev
        || after.ino !== before.ino
      ) {
        return { status: "unsafe", message: "Explicit lab manifest changed while it was being read." };
      }
      return { status: "ok", contents: contents.toString("utf8") };
    } finally {
      await handle.close();
    }
  } catch {
    return { status: "unsafe", message: "Explicit lab manifest failed containment validation." };
  }
}

async function bindManagedDirectory(
  projectRoot: PreparedSelectedOutputDirectory,
  relativePath: string
): Promise<ManagedDirectoryResult> {
  const inspected = await inspectManagedPath(projectRoot, relativePath, "directory");
  if (inspected.status !== "ok") {
    return inspected;
  }
  return {
    status: "ok",
    binding: {
      dev: inspected.dev,
      ino: inspected.ino,
      physicalPath: inspected.physicalPath
    }
  };
}

async function inspectManagedPath(
  projectRoot: PreparedSelectedOutputDirectory,
  relativePath: string,
  expectedKind: "directory" | "file"
): Promise<
  | { status: "missing" }
  | { status: "unsafe"; message: string }
  | { status: "ok"; dev: bigint; ino: bigint; physicalPath: string }
> {
  try {
    await assertPreparedSelectedOutputDirectory(projectRoot);
    const segments = relativePath.replace(/\\/g, "/").split("/");
    let current = projectRoot.physicalPath;
    for (const [index, segment] of segments.entries()) {
      assertSafeOutputPathSegment(segment, "Managed lab path segment");
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
        return { status: "unsafe", message: "Managed lab paths must not contain symbolic links." };
      }
      if (!leaf && !stats.isDirectory()) {
        return { status: "unsafe", message: "Managed lab path parents must be directories." };
      }
      if (leaf && expectedKind === "directory" && !stats.isDirectory()) {
        return { status: "unsafe", message: "Managed lab directory has an unsafe file type." };
      }
      if (leaf && expectedKind === "file" && (!stats.isFile() || stats.nlink !== 1n)) {
        return { status: "unsafe", message: "Managed lab manifest must be a single-link regular file." };
      }
      if (leaf) {
        await assertPreparedSelectedOutputDirectory(projectRoot);
        return { status: "ok", dev: stats.dev, ino: stats.ino, physicalPath: current };
      }
    }
  } catch {
    return { status: "unsafe", message: "Managed lab path failed containment validation." };
  }
  return { status: "missing" };
}

async function assertManagedDirectoryBinding(
  projectRoot: PreparedSelectedOutputDirectory,
  relativePath: string,
  binding: ManagedDirectoryBinding
): Promise<void> {
  await assertPreparedSelectedOutputDirectory(projectRoot);
  const current = await inspectManagedPath(projectRoot, relativePath, "directory");
  if (
    current.status !== "ok"
    || current.physicalPath !== binding.physicalPath
    || current.dev !== binding.dev
    || current.ino !== binding.ino
  ) {
    throw new Error("Managed lab directory identity changed after it was bound.");
  }
}

function invalidLab(args: {
  cwd: string;
  lab: string;
  warnings: string[];
}, message: string): LabResolveFailure {
  return {
    ok: false,
    cwd: args.cwd,
    lab: args.lab,
    error: {
      code: "HUMANISH_LAB_INVALID",
      message
    },
    warnings: args.warnings
  };
}

function labNotFound(cwd: string, lab: string, warnings: string[]): LabResolveFailure {
  return {
    ok: false,
    cwd,
    lab,
    error: {
      code: "HUMANISH_LAB_NOT_FOUND",
      message: `Lab not found: ${lab}. Look in humanish/labs/ or pass a .yaml path.`
    },
    warnings
  };
}

function labLooksLikePath(lab: string): boolean {
  return lab.endsWith(".yaml")
    || lab.endsWith(".yml")
    || lab.includes("/")
    || lab.includes("\\")
    || lab.startsWith(".");
}

function relativeToCwd(cwd: string, filePath: string): string {
  const relative = path.relative(cwd, filePath);
  return relative && !relative.startsWith("..") ? relative : filePath;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
