import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  homunScripts,
  runtimeDirectories,
  starterFiles
} from "./init-templates.js";

export const INIT_RESPONSE_SCHEMA = "homun.init-result.v1";

export interface InitOptions {
  cwd: string;
  dryRun?: boolean;
  yes?: boolean;
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
  error?: {
    code:
      | "HOMUN_CONFIRMATION_REQUIRED"
      | "HOMUN_INVALID_CWD"
      | "HOMUN_INVALID_PACKAGE_JSON";
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
  const cwd = path.resolve(options.cwd);
  const mode = getMode(options);
  const warnings: string[] = [];
  const changes: InitChange[] = [];
  const writes: PlannedWrite[] = [];
  const dirs: Array<{ absolutePath: string; relativePath: string }> = [];
  const cwdCheck = await validateCwd(cwd);

  if (cwdCheck) {
    return {
      schema: INIT_RESPONSE_SCHEMA,
      ok: false,
      mode,
      cwd,
      changes,
      warnings,
      error: cwdCheck
    };
  }

  for (const file of starterFiles) {
    const absolutePath = path.join(cwd, file.path);
    const existing = await readTextIfExists(absolutePath);

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
      warnings.push(`Skipped existing ${file.path}; Homun never overwrites user files during init.`);
    }
  }

  for (const directory of runtimeDirectories) {
    const absolutePath = path.join(cwd, directory.path);
    const exists = await pathExists(absolutePath);

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

  const gitignorePlan = await planGitignore(cwd);
  changes.push(gitignorePlan.change);

  if (gitignorePlan.write) {
    writes.push(gitignorePlan.write);
  }

  const packagePlan = await planPackageJson(cwd);
  changes.push(packagePlan.change);
  warnings.push(...packagePlan.warnings);

  if (packagePlan.error) {
    return {
      schema: INIT_RESPONSE_SCHEMA,
      ok: false,
      mode,
      cwd,
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
      cwd,
      changes,
      warnings,
      error: {
        code: "HOMUN_CONFIRMATION_REQUIRED",
        message: "Re-run with --dry-run to inspect or --yes to apply safe generated changes."
      }
    };
  }

  if (mode === "applied") {
    for (const directory of dirs) {
      await mkdir(directory.absolutePath, { recursive: true });
    }

    for (const write of writes) {
      await mkdir(path.dirname(write.absolutePath), { recursive: true });
      await writeFile(write.absolutePath, write.contents, "utf8");
    }
  }

  return {
    schema: INIT_RESPONSE_SCHEMA,
    ok: true,
    mode,
    cwd,
    changes,
    warnings
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

async function planGitignore(cwd: string): Promise<{ write?: PlannedWrite; change: InitChange }> {
  const relativePath = ".gitignore";
  const absolutePath = path.join(cwd, relativePath);
  const existing = await readTextIfExists(absolutePath);
  const currentLines = existing?.split(/\r?\n/) ?? [];
  const envIndex = currentLines.lastIndexOf(".env*");
  const envExampleIndex = currentLines.lastIndexOf("!.env.example");
  const needsEnv = envIndex === -1;
  const needsEnvExample = envExampleIndex === -1
    || (envIndex !== -1 && envExampleIndex < envIndex)
    || needsEnv;
  const missingLines = [
    ...(currentLines.includes(".homun/") ? [] : [".homun/"]),
    ...(needsEnv ? [".env*"] : []),
    ...(needsEnvExample ? ["!.env.example"] : [])
  ];

  if (missingLines.length === 0) {
    return {
      change: {
        path: relativePath,
        action: "skip",
        target: "gitignore",
        reason: "already ignores Homun runtime and env files"
      }
    };
  }

  const prefix = existing && existing.trim().length > 0
    ? trimTrailingNewlines(existing) + "\n\n"
    : "";
  const contents = `${prefix}# Homun runtime and local secrets\n${missingLines.join("\n")}\n`;

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

async function planPackageJson(cwd: string): Promise<PackagePlan> {
  const relativePath = "package.json";
  const absolutePath = path.join(cwd, relativePath);
  const existing = await readTextIfExists(absolutePath);

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
        code: "HOMUN_INVALID_PACKAGE_JSON",
        message: "package.json is not valid JSON. Fix it before running homun init."
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
        code: "HOMUN_INVALID_PACKAGE_JSON",
        message: "package.json root must be an object. Fix it before running homun init."
      }
    };
  }

  const scripts = isRecord(parsed.scripts) ? { ...parsed.scripts } : {};
  const missingScripts: Record<string, string> = {};
  const conflictingScripts: string[] = [];

  for (const [name, command] of Object.entries(homunScripts)) {
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
        reason: "Homun scripts already present"
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

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
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
        code: "HOMUN_INVALID_CWD",
        message: `Target cwd is not a directory: ${cwd}`
      };
    }

    return null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        code: "HOMUN_INVALID_CWD",
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
