import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { parseLabConfig, type LabConfig } from "./lab-config.js";

export { LAB_CONFIG_SCHEMA } from "./lab-config.js";
export type { LabConfig } from "./lab-config.js";

export const LAB_LIST_SCHEMA = "mimetic.lab-list.v1";
export const LAB_INSPECT_SCHEMA = "mimetic.lab-inspect.v1";

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
    code: "MIMETIC_LAB_NOT_FOUND" | "MIMETIC_LAB_INVALID";
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

const committedLabsDir = path.join("mimetic", "labs");
const ignoredLabsDirs = [
  path.join(".mimetic", "labs"),
  path.join(".mimetic", "local", "labs")
] as const;

export async function resolveLabManifest(cwd: string, lab: string): Promise<LabResolveResult> {
  const resolvedCwd = path.resolve(cwd);
  const warnings: string[] = [];
  const candidates = labLooksLikePath(lab)
    ? [{ origin: "explicit" as const, path: path.resolve(resolvedCwd, lab) }]
    : [
        { origin: "committed" as const, path: path.join(resolvedCwd, committedLabsDir, `${lab}.yaml`) },
        { origin: "committed" as const, path: path.join(resolvedCwd, committedLabsDir, `${lab}.yml`) },
        ...ignoredLabsDirs.flatMap((dir) => [
          { origin: "ignored" as const, path: path.join(resolvedCwd, dir, `${lab}.yaml`) },
          { origin: "ignored" as const, path: path.join(resolvedCwd, dir, `${lab}.yml`) }
        ])
      ];

  for (const candidate of candidates) {
    if (!await fileExists(candidate.path)) {
      continue;
    }

    return parseResolvedLab({
      cwd: resolvedCwd,
      lab,
      origin: candidate.origin,
      path: candidate.path,
      warnings
    });
  }

  return {
    ok: false,
    cwd: resolvedCwd,
    lab,
    error: {
      code: "MIMETIC_LAB_NOT_FOUND",
      message: `Lab not found: ${lab}. Look in mimetic/labs/ or pass a .yaml path.`
    },
    warnings
  };
}

export async function listLabManifests(cwd: string): Promise<LabListResult> {
  const resolvedCwd = path.resolve(cwd);
  const warnings: string[] = [];
  const labs = new Map<string, LabListEntry>();
  const dirs = [
    { origin: "committed" as const, dir: path.join(resolvedCwd, committedLabsDir) },
    ...ignoredLabsDirs.map((dir) => ({ origin: "ignored" as const, dir: path.join(resolvedCwd, dir) }))
  ];

  for (const entry of dirs) {
    const names = await safeReadDir(entry.dir);
    for (const name of names.filter((value) => value.endsWith(".yaml") || value.endsWith(".yml"))) {
      const candidatePath = path.join(entry.dir, name);
      const parsed = await parseResolvedLab({
        cwd: resolvedCwd,
        lab: name.replace(/\.(?:ya?ml)$/i, ""),
        origin: entry.origin,
        path: candidatePath,
        warnings: []
      });
      if (!parsed.ok) {
        warnings.push(`${relativeToCwd(resolvedCwd, candidatePath)}: ${parsed.error.message}`);
        continue;
      }

      const key = `${parsed.config.id}:${entry.origin}:${relativeToCwd(resolvedCwd, candidatePath)}`;
      labs.set(key, {
        id: parsed.config.id,
        source: parsed.config.subject.source,
        origin: entry.origin,
        path: relativeToCwd(resolvedCwd, candidatePath),
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

async function parseResolvedLab(args: {
  cwd: string;
  lab: string;
  origin: LabOrigin;
  path: string;
  warnings: string[];
}): Promise<LabResolveResult> {
  let raw: unknown;
  try {
    raw = parse(await readFile(args.path, "utf8"));
  } catch (error: unknown) {
    return invalidLab(args, error instanceof Error ? error.message : "Lab YAML could not be parsed.");
  }

  const parsed = parseLabConfig(raw);
  if (!parsed.ok) {
    return invalidLab(args, parsed.error.message);
  }

  const warnings = [...args.warnings, ...parsed.warnings];
  if (args.path.endsWith(".yml")) {
    warnings.push("Prefer .yaml for Mimetic-authored lab source; .yml is accepted for compatibility only.");
  }

  return {
    ok: true,
    config: parsed.config,
    origin: args.origin,
    path: relativeToCwd(args.cwd, args.path),
    warnings
  };
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
      code: "MIMETIC_LAB_INVALID",
      message
    },
    warnings: args.warnings
  };
}

function labLooksLikePath(lab: string): boolean {
  return lab.endsWith(".yaml")
    || lab.endsWith(".yml")
    || lab.includes("/")
    || lab.includes("\\")
    || lab.startsWith(".");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function safeReadDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

function relativeToCwd(cwd: string, filePath: string): string {
  const relative = path.relative(cwd, filePath);
  return relative && !relative.startsWith("..") ? relative : filePath;
}
