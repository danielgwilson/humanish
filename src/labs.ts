import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

export const LAB_MANIFEST_SCHEMA = "mimetic.lab.v1";
export const LAB_LIST_SCHEMA = "mimetic.lab-list.v1";
export const LAB_INSPECT_SCHEMA = "mimetic.lab-inspect.v1";

export type LabKind = "synthetic" | "oss-meta" | "oss-smoke";
export type LabOrigin = "committed" | "ignored" | "explicit";

export interface LabManifest {
  schema: typeof LAB_MANIFEST_SCHEMA;
  id: string;
  kind: LabKind;
  title?: string;
  description?: string;
  sims?: number;
  count?: number;
  limit?: number;
  repos?: string[];
  defaults?: {
    codexAppServer?: boolean;
    dryRun?: boolean;
    open?: boolean;
    redactRepos?: boolean;
  };
}

export interface ResolvedLabManifest {
  manifest: LabManifest;
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
  | ({ ok: true } & ResolvedLabManifest)
  | LabResolveFailure;

export interface LabListResult {
  schema: typeof LAB_LIST_SCHEMA;
  ok: true;
  cwd: string;
  labs: Array<{
    id: string;
    kind: LabKind;
    origin: LabOrigin;
    path: string;
    title?: string;
  }>;
  warnings: string[];
}

export interface LabInspectResult {
  schema: typeof LAB_INSPECT_SCHEMA;
  ok: boolean;
  cwd: string;
  lab: string;
  manifest?: LabManifest;
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

    return parseLabManifest({
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
  const labs = new Map<string, LabListResult["labs"][number]>();
  const dirs = [
    { origin: "committed" as const, dir: path.join(resolvedCwd, committedLabsDir) },
    ...ignoredLabsDirs.map((dir) => ({ origin: "ignored" as const, dir: path.join(resolvedCwd, dir) }))
  ];

  for (const entry of dirs) {
    const names = await safeReadDir(entry.dir);
    for (const name of names.filter((value) => value.endsWith(".yaml") || value.endsWith(".yml"))) {
      const candidatePath = path.join(entry.dir, name);
      const parsed = await parseLabManifest({
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

      const key = `${parsed.manifest.id}:${entry.origin}:${relativeToCwd(resolvedCwd, candidatePath)}`;
      labs.set(key, {
        id: parsed.manifest.id,
        kind: parsed.manifest.kind,
        origin: entry.origin,
        path: relativeToCwd(resolvedCwd, candidatePath),
        ...(parsed.manifest.title ? { title: parsed.manifest.title } : {})
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
    manifest: resolved.manifest,
    origin: resolved.origin,
    path: resolved.path,
    warnings: resolved.warnings
  };
}

async function parseLabManifest(args: {
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
    return {
      ok: false,
      cwd: args.cwd,
      lab: args.lab,
      error: {
        code: "MIMETIC_LAB_INVALID",
        message: error instanceof Error ? error.message : "Lab YAML could not be parsed."
      },
      warnings: args.warnings
    };
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return invalidLab(args, "Lab manifest must be a YAML object.");
  }

  const record = raw as Record<string, unknown>;
  const schema = stringValue(record.schema);
  const id = stringValue(record.id);
  const kind = stringValue(record.kind);
  if (schema !== LAB_MANIFEST_SCHEMA) {
    return invalidLab(args, `Lab schema must be ${LAB_MANIFEST_SCHEMA}.`);
  }
  if (!id || !/^[A-Za-z0-9_.-]+$/.test(id)) {
    return invalidLab(args, "Lab id must be a public-safe token.");
  }
  if (!isLabKind(kind)) {
    return invalidLab(args, "Lab kind must be synthetic, oss-meta, or oss-smoke.");
  }

  const title = stringValue(record.title);
  const description = stringValue(record.description);
  const sims = positiveIntegerValue(record.sims);
  const count = positiveIntegerValue(record.count);
  const limit = positiveIntegerValue(record.limit);
  const repos = repoListValue(record.repos);
  const defaults = defaultsValue(record.defaults);
  const manifest: LabManifest = {
    schema: LAB_MANIFEST_SCHEMA,
    id,
    kind,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(sims === undefined ? {} : { sims }),
    ...(count === undefined ? {} : { count }),
    ...(limit === undefined ? {} : { limit }),
    ...(repos === undefined ? {} : { repos }),
    ...(defaults === undefined ? {} : { defaults })
  };

  const warnings = [...args.warnings];
  if (args.path.endsWith(".yml")) {
    warnings.push("Prefer .yaml for Mimetic-authored lab source; .yml is accepted for compatibility only.");
  }

  return {
    ok: true,
    manifest,
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveIntegerValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
  }
  return undefined;
}

function repoListValue(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    return value.split(",").map((repo) => repo.trim()).filter(Boolean);
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const repos = value.filter((entry): entry is string => typeof entry === "string")
    .map((repo) => repo.trim())
    .filter(Boolean);
  return repos.length > 0 ? repos : undefined;
}

function defaultsValue(value: unknown): LabManifest["defaults"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const defaults: NonNullable<LabManifest["defaults"]> = {};
  if (typeof record.dryRun === "boolean") defaults.dryRun = record.dryRun;
  if (typeof record.open === "boolean") defaults.open = record.open;
  if (typeof record.redactRepos === "boolean") defaults.redactRepos = record.redactRepos;
  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

function isLabKind(kind: string | undefined): kind is LabKind {
  return kind === "synthetic" || kind === "oss-meta" || kind === "oss-smoke";
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
