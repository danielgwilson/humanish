// Finding and admitting the Codex CLI a restricted launch runs: the native executable behind `PATH`
// or the npm launcher, the environment its children get, and the `--version` check against the
// host's admitted releases.
import { constants } from "node:fs";
import { access, open, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { parseCodexCliVersion } from "./codex-admission.js";
import {
  RestrictedCodexStop,
  closeOwnedCodexProcess,
  ownCodexProcess,
  retainUnclosedChild,
  type RestrictedCodexDeadline,
  type RestrictedCodexSpawn,
} from "./restricted-transport.js";

/** The environment of every Codex child: a private home and scratch, and `PATH` and locale. */
export function childEnvironment(
  source: NodeJS.ProcessEnv,
  home: string,
  scratch: string,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { HOME: home, CODEX_HOME: home, TMPDIR: scratch };
  for (const key of ["PATH", "LANG", "USER", "LOGNAME"])
    if (typeof source[key] === "string") result[key] = source[key];
  return result;
}

async function isNativeExecutable(file: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(4);
      const read = await handle.read(buffer, 0, 4, 0);
      return (
        read.bytesRead === 4 &&
        (platform === "darwin"
          ? ["cffaedfe", "feedfacf", "cafebabe", "bebafeca", "cafebabf"].includes(
              buffer.toString("hex"),
            )
          : buffer.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
      );
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

/** Official npm launcher target map for the Unix hosts supported by this transport. */
export function restrictedCodexNpmTarget(
  platform: NodeJS.Platform,
  arch: string,
):
  | {
      triple: string;
      packageName: string;
    }
  | undefined {
  if (platform === "linux" && arch === "x64")
    return { triple: "x86_64-unknown-linux-musl", packageName: "codex-linux-x64" };
  if (platform === "linux" && arch === "arm64")
    return { triple: "aarch64-unknown-linux-musl", packageName: "codex-linux-arm64" };
  if (platform === "darwin" && arch === "x64")
    return { triple: "x86_64-apple-darwin", packageName: "codex-darwin-x64" };
  if (platform === "darwin" && arch === "arm64")
    return { triple: "aarch64-apple-darwin", packageName: "codex-darwin-arm64" };
  return undefined;
}

/** The `codex` file humanish found and would not run, and why. No path: none was found. */
export interface RefusedCodexExecutable {
  readonly path?: string;
  readonly reason: string;
}

/** Resolve `PATH` without running a shell. The npm launcher is resolved to its
 * native optional package so cleanup owns the real app-server child. */
export async function resolveExecutable(
  options: { executable?: string; platform?: NodeJS.Platform; arch?: string },
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const located = await locateExecutable(options, env);
  // The stop carries only its code; doctor asks refusedCodexExecutable for the file and reason.
  if ("refused" in located) throw new RestrictedCodexStop("codex_unavailable");
  return located.file;
}

/** The `codex` resolveExecutable turns down and why, or undefined when it finds one to run. */
export async function refusedCodexExecutable(
  env: NodeJS.ProcessEnv,
  options: { platform?: NodeJS.Platform; arch?: string } = {},
): Promise<RefusedCodexExecutable | undefined> {
  const located = await locateExecutable(options, env);
  return "refused" in located ? located.refused : undefined;
}

/** The first executable `codex` on `PATH`, as resolveExecutable picks it. */
async function firstCodexOnPath(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  for (const directory of (env.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry))) {
    const candidate = path.join(directory, "codex");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Try the next `PATH` entry. */
    }
  }
  return undefined;
}

/**
 * The `codex` resolveExecutable picks from `PATH`, runnable or not, and the file it resolves to:
 * what decides the command that replaces it. Undefined when `PATH` has none that resolves.
 */
export async function foundCodexExecutable(
  env: NodeJS.ProcessEnv,
): Promise<{ path: string; resolved: string } | undefined> {
  const selected = await firstCodexOnPath(env);
  if (selected === undefined) return undefined;
  try {
    return { path: selected, resolved: await realpath(selected) };
  } catch {
    return undefined;
  }
}

async function locateExecutable(
  options: { executable?: string; platform?: NodeJS.Platform; arch?: string },
  env: NodeJS.ProcessEnv,
): Promise<{ file: string } | { refused: RefusedCodexExecutable }> {
  const platform = options.platform ?? process.platform,
    arch = options.arch ?? process.arch;
  const selected = options.executable ?? (await firstCodexOnPath(env));
  const refused = (reason: string, file?: string) => ({
    refused: { ...(file === undefined ? {} : { path: file }), reason },
  });
  if (selected === undefined) return refused("no executable `codex` is on PATH");
  if (!path.isAbsolute(selected)) return refused("it is not an absolute path", selected);
  let resolved: string;
  try {
    resolved = await realpath(selected);
  } catch {
    return refused("it does not resolve to a file", selected);
  }
  if (await isNativeExecutable(resolved, platform)) return { file: resolved };
  if (path.basename(resolved) === "codex.js" && path.basename(path.dirname(resolved)) === "bin") {
    const packageRoot = path.dirname(path.dirname(resolved));
    const target = restrictedCodexNpmTarget(platform, arch);
    if (!target)
      return refused(`the npm package has no native build for ${platform}-${arch}`, resolved);
    const { triple, packageName: nativePackage } = target;
    const candidates: string[] = [];
    try {
      // Match the npm launcher's resolution: optional packages may be hoisted or
      // linked by the package manager rather than nested inside @openai/codex.
      const manifest = createRequire(resolved).resolve(`@openai/${nativePackage}/package.json`);
      candidates.push(path.join(path.dirname(manifest), "vendor", triple, "bin", "codex"));
    } catch {
      /* Older packages may bundle the native executable directly. */
    }
    candidates.push(path.join(packageRoot, "vendor", triple, "bin", "codex"));
    for (const candidate of candidates) {
      if (await isNativeExecutable(candidate, platform)) return { file: await realpath(candidate) };
    }
    return refused(`the npm package's native ${nativePackage} build is missing`, resolved);
  }
  return refused(
    "it is neither a native Codex executable nor the @openai/codex npm launcher",
    resolved,
  );
}

/**
 * Writes this release's app-server schema (`app-server generate-json-schema --experimental`) into
 * `out`, for the protocol check. False when the release exits without one. Bounded like the
 * version check: 15 seconds, and a few kilobytes of output, which it does not otherwise read.
 */
export async function generateProtocolSchema(
  file: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  out: string,
  spawnFn: RestrictedCodexSpawn,
  deadline: RestrictedCodexDeadline,
): Promise<boolean> {
  deadline.check();
  const owned = ownCodexProcess(
    spawnFn(file, ["app-server", "generate-json-schema", "--experimental", "--out", out], {
      cwd,
      env,
      detached: false,
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
  let bytes = 0,
    exitCode: number | null = null;
  const timer = setTimeout(() => deadline.stop("timeout"), 15_000);
  const count = (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 65_536) deadline.stop("response_too_large");
  };
  owned.child.on("error", () => deadline.stop("codex_unavailable"));
  owned.child.stdin.on("error", () => deadline.stop("codex_unavailable"));
  owned.child.stdout.on("data", count);
  owned.child.stderr.on("data", count);
  owned.child.on("exit", (code) => {
    exitCode = code;
  });
  try {
    owned.child.stdin.end();
    await deadline.wait(owned.closed);
    return exitCode === 0;
  } finally {
    clearTimeout(timer);
    if (!(await closeOwnedCodexProcess(owned))) {
      retainUnclosedChild(owned.closed);
      // oxlint-disable-next-line no-unsafe-finally -- a Codex process that did not close invalidates the check
      throw new RestrictedCodexStop("codex_cleanup_failed");
    }
  }
}

/** Returns the detected release after checking it against launch admission (`admits`). */
export async function checkVersion(
  file: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  spawnFn: RestrictedCodexSpawn,
  deadline: RestrictedCodexDeadline,
  admits: (version: string) => boolean,
  expected: string | undefined,
): Promise<string> {
  deadline.check();
  const owned = ownCodexProcess(
    spawnFn(file, ["--version"], { cwd, env, detached: false, stdio: ["pipe", "pipe", "pipe"] }),
  );
  let text = "",
    bytes = 0,
    exitCode: number | null = null;
  const timer = setTimeout(() => deadline.stop("timeout"), 15_000);
  owned.child.on("error", () => deadline.stop("codex_unavailable"));
  owned.child.stdin.on("error", () => deadline.stop("codex_unavailable"));
  owned.child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 4096) deadline.stop("response_too_large");
    else text += chunk.toString("utf8");
  });
  owned.child.stderr.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 4096) deadline.stop("response_too_large");
  });
  owned.child.on("exit", (code) => {
    exitCode = code;
  });
  try {
    await deadline.wait(owned.closed);
    if (exitCode !== 0) throw new RestrictedCodexStop("codex_unavailable");
    const version = parseCodexCliVersion(text);
    if (
      version === undefined ||
      !admits(version) ||
      (expected !== undefined && version !== expected)
    )
      throw new RestrictedCodexStop("codex_unsupported_version", version);
    return version;
  } finally {
    clearTimeout(timer);
    if (!(await closeOwnedCodexProcess(owned))) {
      retainUnclosedChild(owned.closed);
      // oxlint-disable-next-line no-unsafe-finally -- a Codex process that did not close invalidates the version check
      throw new RestrictedCodexStop("codex_cleanup_failed");
    }
  }
}
