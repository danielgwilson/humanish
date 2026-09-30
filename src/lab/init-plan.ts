// The edits `humanish init` plans for files the project already owns: .gitignore gains the runtime
// and env lines it lacks, and package.json gains the humanish scripts it lacks. Nothing is written
// here; runInit applies the plan.

import path from "node:path";
import { humanishScripts } from "./init-templates.js";
import type { PreparedSelectedOutputDirectory } from "../run/selected-output-paths.js";
import { readTextIfExists } from "./init-paths.js";
import type { InitChange, InitResult } from "./init.js";

export interface PlannedWrite {
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

export async function planGitignore(
  projectRoot: PreparedSelectedOutputDirectory,
  cwd: string,
): Promise<{ write?: PlannedWrite; change: InitChange }> {
  const relativePath = ".gitignore";
  const absolutePath = path.join(cwd, relativePath);
  const existing = await readTextIfExists(projectRoot, relativePath);
  const currentLines = existing?.split(/\r?\n/) ?? [];
  const envIndex = currentLines.lastIndexOf(".env*");
  const envExampleIndex = currentLines.lastIndexOf("!.env.example");
  const needsEnv = envIndex === -1;
  const needsEnvExample =
    envExampleIndex === -1 || (envIndex !== -1 && envExampleIndex < envIndex) || needsEnv;
  const missingLines = [
    ...(currentLines.includes(".humanish/") ? [] : [".humanish/"]),
    ...(needsEnv ? [".env*"] : []),
    ...(needsEnvExample ? ["!.env.example"] : []),
  ];

  if (missingLines.length === 0) {
    return {
      change: {
        path: relativePath,
        action: "skip",
        target: "gitignore",
        reason: "already ignores humanish runtime and env files",
      },
    };
  }

  const prefix =
    existing && existing.trim().length > 0 ? trimTrailingNewlines(existing) + "\n\n" : "";
  const contents = `${prefix}# humanish runtime and local secrets\n${missingLines.join("\n")}\n`;

  return {
    write: {
      absolutePath,
      relativePath,
      contents,
      target: "gitignore",
    },
    change: {
      path: relativePath,
      action: existing === null ? "create" : "update",
      target: "gitignore",
      reason: `add ${missingLines.join(", ")}`,
    },
  };
}

export async function planPackageJson(
  projectRoot: PreparedSelectedOutputDirectory,
  cwd: string,
): Promise<PackagePlan> {
  const relativePath = "package.json";
  const absolutePath = path.join(cwd, relativePath);
  const existing = await readTextIfExists(projectRoot, relativePath);

  if (existing === null) {
    return {
      change: {
        path: relativePath,
        action: "skip",
        target: "package-json",
        reason: "package.json not found",
      },
      warnings: ["Skipped package.json scripts because package.json was not found."],
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
        reason: "package.json is not valid JSON",
      },
      warnings: ["package.json is not valid JSON; init did not apply partial changes."],
      error: {
        code: "HUMANISH_INVALID_PACKAGE_JSON",
        message: "package.json is not valid JSON. Fix it before running humanish init.",
      },
    };
  }

  if (!isRecord(parsed)) {
    return {
      change: {
        path: relativePath,
        action: "skip",
        target: "package-json",
        reason: "package.json root is not an object",
      },
      warnings: ["package.json root is not an object; init did not apply partial changes."],
      error: {
        code: "HUMANISH_INVALID_PACKAGE_JSON",
        message: "package.json root must be an object. Fix it before running humanish init.",
      },
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
        reason: `existing script conflicts: ${conflictingScripts.join(", ")}`,
      },
      warnings: [
        `Skipped package.json script patch because these scripts already exist with different values: ${conflictingScripts.join(", ")}.`,
      ],
    };
  }

  if (Object.keys(missingScripts).length === 0) {
    return {
      change: {
        path: relativePath,
        action: "skip",
        target: "package-json",
        reason: "humanish scripts already present",
      },
      warnings: [],
    };
  }

  parsed.scripts = {
    ...scripts,
    ...missingScripts,
  };

  const warnings =
    conflictingScripts.length === 0
      ? []
      : [
          `Preserved existing script values for conflicting scripts: ${conflictingScripts.join(", ")}.`,
        ];

  return {
    write: {
      absolutePath,
      relativePath,
      contents: `${JSON.stringify(parsed, null, 2)}\n`,
      target: "package-json",
    },
    change: {
      path: relativePath,
      action: "update",
      target: "package-json",
      reason: `add scripts: ${Object.keys(missingScripts).join(", ")}`,
    },
    warnings,
  };
}

function trimTrailingNewlines(text: string): string {
  return text.replace(/\n+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
