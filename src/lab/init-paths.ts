// Path checks for `humanish init`: every file and directory init may write (inside the project,
// the expected kind, no symbolic links or hardlinked files), and the contained reads init makes of
// existing files. The target cwd check is validateCwd in run/project.ts.

import { lstat } from "node:fs/promises";
import path from "node:path";
import { runtimeDirectories, starterFiles } from "./init-templates.js";
import {
  assertPreparedSelectedOutputDirectory,
  readContainedRegularFile,
  type PreparedSelectedOutputDirectory,
} from "../run/selected-output-paths.js";
import type { InitResult } from "./init.js";
import { isPathInside } from "../run/paths.js";
import { isNodeError } from "../run/primitives.js";

export async function validateInitProjectPaths(cwd: string): Promise<InitResult["error"] | null> {
  const targets = [
    ...starterFiles.map((file) => ({ path: file.path, kind: "file" as const })),
    ...runtimeDirectories.map((directory) => ({
      path: directory.path,
      kind: "directory" as const,
    })),
    { path: ".gitignore", kind: "file" as const },
    { path: "package.json", kind: "file" as const },
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
          stats.isSymbolicLink() ||
          (!isLeaf && !stats.isDirectory()) ||
          (isLeaf && targetSpec.kind === "file" && (!stats.isFile() || stats.nlink > 1)) ||
          (isLeaf && targetSpec.kind === "directory" && !stats.isDirectory())
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
    message: `Init target must stay inside the project, use the expected regular-file or directory kind, and not traverse symbolic links or hardlinked files: ${relativePath}`,
  };
}

export async function readTextIfExists(
  projectRoot: PreparedSelectedOutputDirectory,
  relativePath: string,
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

export async function pathExists(
  projectRoot: PreparedSelectedOutputDirectory,
  relativePath: string,
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
