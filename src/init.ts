import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { AGENTS_SECTION_MARKER, agentsSection, firstRunGuidance, starterActorFor, type FirstRunEnvironment } from "./first-run-path.js";
import { detectLocalAgents } from "./local-agent-cli.js";

import {
  humanishScripts,
  runtimeDirectories,
  starterFiles,
  starterFilesFor
} from "./init-templates.js";
import {
  assertPreparedSelectedOutputDirectory,
  prepareContainedOutputDirectory,
  prepareSelectedOutputDirectory,
  readContainedRegularFile,
  type PreparedSelectedOutputDirectory,
  writeContainedOutputFile
} from "./selected-output-paths.js";

export const INIT_RESPONSE_SCHEMA = "humanish.init-result.v1";

export interface InitOptions {
  cwd: string;
  dryRun?: boolean;
  yes?: boolean;
  /** Injected so a test can decide what credentials this machine appears to have. */
  env?: NodeJS.ProcessEnv;
}

export type InitMode = "dry-run" | "applied" | "needs-confirmation";

export interface InitChange {
  path: string;
  action: "create" | "mkdir" | "update" | "skip";
  target: "source" | "runtime" | "gitignore" | "package-json";
  reason: string;
}

export interface InitResult {
  schema: typeof INIT_RESPONSE_SCHEMA;
  ok: boolean;
  mode: InitMode;
  cwd: string;
  changes: InitChange[];
  warnings: string[];
  /**
   * The next one or two commands, already resolved against THIS machine's credentials. Present on
   * an applied init; absent on a dry-run or a failure, where there is no "next" yet.
   */
  nextSteps?: string[];
  error?: {
    code:
      | "HUMANISH_CONFIRMATION_REQUIRED"
      | "HUMANISH_INVALID_CWD"
      | "HUMANISH_INVALID_PACKAGE_JSON"
      | "HUMANISH_UNSAFE_PROJECT_PATH";
    message: string;
  };
}

interface PlannedWrite {
  absolutePath: string;
  relativePath: string;
  contents: string;
  target: InitChange["target"];
}

interface PackagePlan {
  write?: PlannedWrite;
  change: InitChange;
  warnings: string[];
  error?: InitResult["error"];
}

export async function runInit(options: InitOptions): Promise<InitResult> {
  const requestedCwd = path.resolve(options.cwd);
  const mode = getMode(options);
  const warnings: string[] = [];
  const changes: InitChange[] = [];
  const writes: PlannedWrite[] = [];
  const dirs: Array<{ absolutePath: string; relativePath: string }> = [];
  const cwdCheck = await validateCwd(requestedCwd);

  if (cwdCheck) {
    return {
      schema: INIT_RESPONSE_SCHEMA,
      ok: false,
      mode,
      cwd: requestedCwd,
      changes,
      warnings,
      error: cwdCheck
    };
  }
  const cwd = await realpath(requestedCwd);
  const preparedProjectRoot = await prepareSelectedOutputDirectory(path.dirname(cwd), cwd);
  const initialPathCheck = await validateInitProjectPaths(cwd);
  if (initialPathCheck) {
    return {
      schema: INIT_RESPONSE_SCHEMA,
      ok: false,
      mode,
      cwd: requestedCwd,
      changes,
      warnings,
      error: initialPathCheck
    };
  }

  // Leave instructions for the NEXT agent. AGENTS.md is the cross-vendor convention (agents.md) —
  // Codex, Claude Code, Cursor, Aider and others read it — and increasingly the thing that runs
  // `humanish init` is a coding agent doing setup on someone's behalf. Without this, the agent
  // that arrives tomorrow finds a humanish/ directory and no idea what to do with it.
  //
  // APPEND-ONLY and idempotent: an existing AGENTS.md is a file someone wrote, so humanish adds its
  // own section once and never rewrites theirs.
  {
    const agentsPath = "AGENTS.md";
    const existingAgents = await readTextIfExists(preparedProjectRoot, agentsPath);
    const section = agentsSection();
    if (existingAgents === null) {
      changes.push({ path: agentsPath, action: "create", target: "source", reason: "how a coding agent runs humanish here" });
      writes.push({
        absolutePath: path.join(cwd, agentsPath),
        relativePath: agentsPath,
        contents: `# AGENTS.md\n${section}`,
        target: "source"
      });
    } else if (existingAgents.includes(AGENTS_SECTION_MARKER)) {
      changes.push({ path: agentsPath, action: "skip", target: "source", reason: "humanish section already present" });
    } else {
      changes.push({ path: agentsPath, action: "update", target: "source", reason: "append how a coding agent runs humanish" });
      writes.push({
        absolutePath: path.join(cwd, agentsPath),
        relativePath: agentsPath,
        contents: `${existingAgents.replace(/\s*$/, "")}\n${section}`,
        target: "source"
      });
    }
  }

  // The starter live lab is written for the brain this machine can actually use. Shipping it as
  // openai-computer-use on a machine with no provider key but a signed-in Codex would hand someone
  // a file that asks for a credential they were just told they do not need (#505).
  const starterActor = starterActorFor(await firstRunEnvironment(options.env ?? process.env));
  for (const file of starterFilesFor(starterActor)) {
    const absolutePath = path.join(cwd, file.path);
    const existing = await readTextIfExists(preparedProjectRoot, file.path);

    if (existing === null) {
      changes.push({
        path: file.path,
        action: "create",
        target: file.plane,
        reason: "public-safe starter file"
      });
      writes.push({
        absolutePath,
        relativePath: file.path,
        contents: file.contents,
        target: file.plane
      });
    } else if (existing === file.contents) {
      changes.push({
        path: file.path,
        action: "skip",
        target: file.plane,
        reason: "already matches starter"
      });
    } else {
      changes.push({
        path: file.path,
        action: "skip",
        target: file.plane,
        reason: "existing file would not be overwritten"
      });
      warnings.push(`Skipped existing ${file.path}; Humanish never overwrites user files during init.`);
    }
  }

  for (const directory of runtimeDirectories) {
    const absolutePath = path.join(cwd, directory.path);
    const exists = await pathExists(preparedProjectRoot, directory.path);

    changes.push({
      path: directory.path,
      action: exists ? "skip" : "mkdir",
      target: directory.plane,
      reason: exists ? "already exists" : "ignored runtime directory"
    });

    if (!exists) {
      dirs.push({ absolutePath, relativePath: directory.path });
    }
  }

  const gitignorePlan = await planGitignore(preparedProjectRoot, cwd);
  changes.push(gitignorePlan.change);

  if (gitignorePlan.write) {
    writes.push(gitignorePlan.write);
  }

  const packagePlan = await planPackageJson(preparedProjectRoot, cwd);
  changes.push(packagePlan.change);
  warnings.push(...packagePlan.warnings);

  if (packagePlan.error) {
    return {
      schema: INIT_RESPONSE_SCHEMA,
      ok: false,
      mode,
      cwd: requestedCwd,
      changes,
      warnings,
      error: packagePlan.error
    };
  }

  if (packagePlan.write) {
    writes.push(packagePlan.write);
  }

  if (mode === "needs-confirmation") {
    return {
      schema: INIT_RESPONSE_SCHEMA,
      ok: false,
      mode,
      cwd: requestedCwd,
      changes,
      warnings,
      error: {
        code: "HUMANISH_CONFIRMATION_REQUIRED",
        message: "Re-run with --dry-run to inspect or --yes to apply safe generated changes."
      }
    };
  }

  if (mode === "applied") {
    await assertPreparedSelectedOutputDirectory(preparedProjectRoot);
    const applyPathCheck = await validateInitProjectPaths(cwd);
    if (applyPathCheck) {
      return {
        schema: INIT_RESPONSE_SCHEMA,
        ok: false,
        mode,
        cwd: requestedCwd,
        changes,
        warnings,
        error: applyPathCheck
      };
    }

    for (const directory of dirs) {
      await prepareContainedOutputDirectory(preparedProjectRoot, directory.relativePath);
    }

    for (const write of writes) {
      await writeContainedOutputFile(preparedProjectRoot, write.relativePath, write.contents, "utf8");
    }
  }

  return {
    schema: INIT_RESPONSE_SCHEMA,
    ok: true,
    mode,
    cwd: requestedCwd,
    changes,
    warnings,
    // Resolved against THIS machine, because a next step that cannot work is worse than none.
    ...(mode === "applied" ? { nextSteps: await resolveFirstRunGuidance(options.env ?? process.env) } : {})
  };
}

/**
 * What to tell the operator (or the agent acting for them) to do next. Credential PRESENCE only —
 * no value is read, and the local-agent check asks whether a credential file exists, never what is
 * in it.
 */
async function resolveFirstRunGuidance(env: NodeJS.ProcessEnv): Promise<string[]> {
  return firstRunGuidance(await firstRunEnvironment(env));
}

/** Credential PRESENCE only. No value is read, and the local-agent check asks whether a file
 *  exists, never what is in it. */
async function firstRunEnvironment(env: NodeJS.ProcessEnv): Promise<FirstRunEnvironment> {
  const agents = await detectLocalAgents().catch(() => []);
  return {
    hasE2bKey: (env.E2B_API_KEY ?? "").trim().length > 0,
    hasProviderKey: (env.OPENAI_API_KEY ?? "").trim().length > 0,
    localAgents: agents.filter((agent) => agent.credentialsPresent).map((agent) => agent.label)
  };
}

async function validateInitProjectPaths(cwd: string): Promise<InitResult["error"] | null> {
  const targets = [
    ...starterFiles.map((file) => ({ path: file.path, kind: "file" as const })),
    ...runtimeDirectories.map((directory) => ({ path: directory.path, kind: "directory" as const })),
    { path: ".gitignore", kind: "file" as const },
    { path: "package.json", kind: "file" as const }
  ];

  for (const targetSpec of targets) {
    const relativePath = targetSpec.path;
    const target = path.resolve(cwd, relativePath);
    if (!isPathInside(cwd, target)) {
      return unsafeProjectPath(relativePath);
    }

    const parts = path.relative(cwd, target).split(path.sep).filter(Boolean);
    let current = cwd;
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      try {
        const stats = await lstat(current);
        const isLeaf = index === parts.length - 1;
        if (
          stats.isSymbolicLink()
          || (!isLeaf && !stats.isDirectory())
          || (isLeaf && targetSpec.kind === "file" && (!stats.isFile() || stats.nlink > 1))
          || (isLeaf && targetSpec.kind === "directory" && !stats.isDirectory())
        ) {
          return unsafeProjectPath(relativePath);
        }
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          break;
        }
        return unsafeProjectPath(relativePath);
      }
    }
  }

  return null;
}

function unsafeProjectPath(relativePath: string): NonNullable<InitResult["error"]> {
  return {
    code: "HUMANISH_UNSAFE_PROJECT_PATH",
    message: `Init target must stay inside the project, use the expected regular-file or directory kind, and not traverse symbolic links or hardlinked files: ${relativePath}`
  };
}

function getMode(options: InitOptions): InitMode {
  if (options.dryRun) {
    return "dry-run";
  }

  if (options.yes) {
    return "applied";
  }

  return "needs-confirmation";
}

async function planGitignore(
  projectRoot: PreparedSelectedOutputDirectory,
  cwd: string
): Promise<{ write?: PlannedWrite; change: InitChange }> {
  const relativePath = ".gitignore";
  const absolutePath = path.join(cwd, relativePath);
  const existing = await readTextIfExists(projectRoot, relativePath);
  const currentLines = existing?.split(/\r?\n/) ?? [];
  const envIndex = currentLines.lastIndexOf(".env*");
  const envExampleIndex = currentLines.lastIndexOf("!.env.example");
  const needsEnv = envIndex === -1;
  const needsEnvExample = envExampleIndex === -1
    || (envIndex !== -1 && envExampleIndex < envIndex)
    || needsEnv;
  const missingLines = [
    ...(currentLines.includes(".humanish/") ? [] : [".humanish/"]),
    ...(needsEnv ? [".env*"] : []),
    ...(needsEnvExample ? ["!.env.example"] : [])
  ];

  if (missingLines.length === 0) {
    return {
      change: {
        path: relativePath,
        action: "skip",
        target: "gitignore",
        reason: "already ignores Humanish runtime and env files"
      }
    };
  }

  const prefix = existing && existing.trim().length > 0
    ? trimTrailingNewlines(existing) + "\n\n"
    : "";
  const contents = `${prefix}# Humanish runtime and local secrets\n${missingLines.join("\n")}\n`;

  return {
    write: {
      absolutePath,
      relativePath,
      contents,
      target: "gitignore"
    },
    change: {
      path: relativePath,
      action: existing === null ? "create" : "update",
      target: "gitignore",
      reason: `add ${missingLines.join(", ")}`
    }
  };
}

async function planPackageJson(projectRoot: PreparedSelectedOutputDirectory, cwd: string): Promise<PackagePlan> {
  const relativePath = "package.json";
  const absolutePath = path.join(cwd, relativePath);
  const existing = await readTextIfExists(projectRoot, relativePath);

  if (existing === null) {
    return {
      change: {
        path: relativePath,
        action: "skip",
        target: "package-json",
        reason: "package.json not found"
      },
      warnings: ["Skipped package.json scripts because package.json was not found."]
    };
  }

  let parsed: { scripts?: Record<string, unknown>; [key: string]: unknown };

  try {
    parsed = JSON.parse(existing) as { scripts?: Record<string, unknown>; [key: string]: unknown };
  } catch {
    return {
      change: {
        path: relativePath,
        action: "skip",
        target: "package-json",
        reason: "package.json is not valid JSON"
      },
      warnings: ["package.json is not valid JSON; init did not apply partial changes."],
      error: {
        code: "HUMANISH_INVALID_PACKAGE_JSON",
        message: "package.json is not valid JSON. Fix it before running humanish init."
      }
    };
  }

  if (!isRecord(parsed)) {
    return {
      change: {
        path: relativePath,
        action: "skip",
        target: "package-json",
        reason: "package.json root is not an object"
      },
      warnings: ["package.json root is not an object; init did not apply partial changes."],
      error: {
        code: "HUMANISH_INVALID_PACKAGE_JSON",
        message: "package.json root must be an object. Fix it before running humanish init."
      }
    };
  }

  const scripts = isRecord(parsed.scripts) ? { ...parsed.scripts } : {};
  const missingScripts: Record<string, string> = {};
  const conflictingScripts: string[] = [];

  for (const [name, command] of Object.entries(humanishScripts)) {
    const existingScript = scripts[name];

    if (existingScript === undefined) {
      missingScripts[name] = command;
    } else if (existingScript !== command) {
      conflictingScripts.push(name);
    }
  }

  if (conflictingScripts.length > 0 && Object.keys(missingScripts).length === 0) {
    return {
      change: {
        path: relativePath,
        action: "skip",
        target: "package-json",
        reason: `existing script conflicts: ${conflictingScripts.join(", ")}`
      },
      warnings: [
        `Skipped package.json script patch because these scripts already exist with different values: ${conflictingScripts.join(", ")}.`
      ]
    };
  }

  if (Object.keys(missingScripts).length === 0) {
    return {
      change: {
        path: relativePath,
        action: "skip",
        target: "package-json",
        reason: "Humanish scripts already present"
      },
      warnings: []
    };
  }

  parsed.scripts = {
    ...scripts,
    ...missingScripts
  };

  const warnings = conflictingScripts.length === 0
    ? []
    : [
        `Preserved existing script values for conflicting scripts: ${conflictingScripts.join(", ")}.`
      ];

  return {
    write: {
      absolutePath,
      relativePath,
      contents: `${JSON.stringify(parsed, null, 2)}\n`,
      target: "package-json"
    },
    change: {
      path: relativePath,
      action: "update",
      target: "package-json",
      reason: `add scripts: ${Object.keys(missingScripts).join(", ")}`
    },
    warnings
  };
}

async function readTextIfExists(
  projectRoot: PreparedSelectedOutputDirectory,
  relativePath: string
): Promise<string | null> {
  const bytes = await readContainedRegularFile(projectRoot, relativePath);
  if (bytes !== null) {
    return bytes.toString("utf8");
  }
  const target = path.join(projectRoot.physicalPath, relativePath);
  try {
    await lstat(target);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  throw new Error(unsafeProjectPath(relativePath).message);
}

async function pathExists(
  projectRoot: PreparedSelectedOutputDirectory,
  relativePath: string
): Promise<boolean> {
  await assertPreparedSelectedOutputDirectory(projectRoot);
  const filePath = path.join(projectRoot.physicalPath, relativePath);
  try {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(unsafeProjectPath(relativePath).message);
    }
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function validateCwd(cwd: string): Promise<InitResult["error"] | null> {
  try {
    const stats = await stat(cwd);

    if (!stats.isDirectory()) {
      return {
        code: "HUMANISH_INVALID_CWD",
        message: `Target cwd is not a directory: ${cwd}`
      };
    }

    return null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        code: "HUMANISH_INVALID_CWD",
        message: `Target cwd does not exist: ${cwd}`
      };
    }

    throw error;
  }
}

function trimTrailingNewlines(text: string): string {
  return text.replace(/\n+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
