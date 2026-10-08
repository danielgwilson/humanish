// The target project directory: its existence check, and the implicit project files a run reads
// (package.json, humanish/ personas and scenarios) without following links out of it.

import { lstat, stat } from "node:fs/promises";
import path from "node:path";

import {
  assertPreparedSelectedOutputDirectory,
  assertSafeOutputPathSegment,
  readContainedRegularFile,
  refusalText,
  PROJECT_FILE_MAX_BYTES,
  type PreparedSelectedOutputDirectory,
} from "./contained-output.js";
import { isNodeError, isRecord } from "./type-guards.js";

async function inspectImplicitProjectPath(
  projectRoot: PreparedSelectedOutputDirectory,
  relativePath: string,
) {
  const segments = relativePath.replace(/\\/g, "/").split("/");
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    throw new Error("Implicit project path must be a non-empty relative path.");
  }
  await assertPreparedSelectedOutputDirectory(projectRoot);
  let current = projectRoot.physicalPath;
  for (const [index, segment] of segments.entries()) {
    assertSafeOutputPathSegment(segment, "Implicit project path segment");
    current = path.join(current, segment);
    let stats;
    try {
      stats = await lstat(current, { bigint: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`Implicit project path must not contain symbolic links: ${relativePath}`);
    }
    if (!stats.isDirectory() && !stats.isFile()) {
      throw new Error(
        `Implicit project path must contain only regular files and directories: ${relativePath}`,
      );
    }
    if (stats.isFile() && stats.nlink > 1n) {
      throw new Error(`Implicit project files must be single-link regular files: ${relativePath}`);
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new Error(`Implicit project path parent must be a directory: ${relativePath}`);
    }
    if (index === segments.length - 1) {
      await assertPreparedSelectedOutputDirectory(projectRoot);
      return stats;
    }
  }
  return null;
}

export async function implicitProjectDirectoryExists(
  projectRoot: PreparedSelectedOutputDirectory,
  relativePath: string,
): Promise<boolean> {
  const stats = await inspectImplicitProjectPath(projectRoot, relativePath);
  if (!stats) {
    return false;
  }
  if (!stats.isDirectory()) {
    throw new Error(`Implicit project directory has the wrong type: ${relativePath}`);
  }
  return true;
}

export async function readImplicitProjectFile(
  projectRoot: PreparedSelectedOutputDirectory,
  relativePath: string,
): Promise<string | null> {
  const stats = await inspectImplicitProjectPath(projectRoot, relativePath);
  if (!stats) {
    return null;
  }
  if (!stats.isFile() || stats.nlink !== 1n) {
    throw new Error(`Implicit project file must be a single-link regular file: ${relativePath}`);
  }
  const read = await readContainedRegularFile(
    projectRoot,
    relativePath.replace(/\\/g, "/"),
    PROJECT_FILE_MAX_BYTES,
  );
  if (read.status === "refused" && read.reason === "too-large")
    throw new Error(`Implicit project file ${refusalText(relativePath, read)}.`);
  // Gone or swapped since it was inspected above.
  if (read.status !== "read") {
    throw new Error(`Implicit project file changed while it was being read: ${relativePath}`);
  }
  return read.bytes.toString("utf8");
}

export async function readPackageName(
  projectRoot: PreparedSelectedOutputDirectory,
): Promise<string | null> {
  const text = await readImplicitProjectFile(projectRoot, "package.json");
  if (text === null) {
    return null;
  }
  try {
    const packageJson = JSON.parse(text) as unknown;
    return isRecord(packageJson) && typeof packageJson.name === "string" ? packageJson.name : null;
  } catch {
    return null;
  }
}

export async function validateCwd(
  cwd: string,
): Promise<{ code: "HUMANISH_INVALID_CWD"; message: string } | null> {
  try {
    const stats = await stat(cwd);

    if (!stats.isDirectory()) {
      return {
        code: "HUMANISH_INVALID_CWD",
        message: `Target cwd is not a directory: ${cwd}`,
      };
    }

    return null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        code: "HUMANISH_INVALID_CWD",
        message: `Target cwd does not exist: ${cwd}`,
      };
    }

    throw error;
  }
}
