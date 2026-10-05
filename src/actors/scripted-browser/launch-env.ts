// Chrome's process singleton listens on a Unix socket at `$TMPDIR/<product>.XXXXXX/SingletonSocket`,
// where the product is com.google.Chrome, or org.chromium.Chromium for Chromium and Chrome for
// Testing. A Unix socket path holds at most 107 bytes on Linux and 103 on macOS, so under a longer
// `TMPDIR`, such as a sandboxed agent's private temp directory, Chrome aborts at launch with
// "Socket path too long", and Playwright reports only that the browser closed. The scripted
// browser gives Chrome /tmp in that case; the browser profile stays where Playwright puts it.
import { constants } from "node:fs";
import { access } from "node:fs/promises";

/** `/org.chromium.Chromium.XXXXXX/SingletonSocket`: the longest path Chrome adds to `TMPDIR`. */
const SOCKET_SUFFIX_BYTES = 45;
/** The longest socket path, without its NUL: `sun_path` holds 104 bytes on macOS, 108 elsewhere. */
const SOCKET_PATH_MAX_BYTES = process.platform === "darwin" ? 103 : 107;
/** Where Chrome makes its socket directory when `TMPDIR` is unset. */
const DEFAULT_TMPDIR = "/tmp";

/** The byte length of `TMPDIR` when Chrome's singleton socket path under it would be too long. */
function overlongTmpdirBytes(env: NodeJS.ProcessEnv): number | undefined {
  const tmpdir = env.TMPDIR?.replace(/\/+$/, "");
  if (tmpdir === undefined || tmpdir === "") return undefined;
  const bytes = Buffer.byteLength(tmpdir);
  return bytes + SOCKET_SUFFIX_BYTES > SOCKET_PATH_MAX_BYTES ? bytes : undefined;
}

/**
 * The environment to launch Chrome with: `env` with `TMPDIR` set to /tmp when its own `TMPDIR` is
 * too long for the singleton socket and /tmp is a writable directory. Undefined when Chrome can
 * launch with `env` as it is, or when /tmp cannot be used; chromeLaunchError then names the cause.
 */
export async function chromeLaunchEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv | undefined> {
  if (process.platform === "win32" || overlongTmpdirBytes(env) === undefined) return undefined;
  try {
    await access(DEFAULT_TMPDIR, constants.W_OK | constants.X_OK);
  } catch {
    return undefined;
  }
  return { ...env, TMPDIR: DEFAULT_TMPDIR };
}

/**
 * The launch error to report: one that names the cause and the fix when Chrome aborted because its
 * singleton socket path was too long, and `error` itself otherwise. `env` is the environment
 * Chrome was launched with.
 */
export function chromeLaunchError(error: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("Socket path too long")) return error;
  const bytes = overlongTmpdirBytes(env);
  return new Error(
    `Chrome could not start: its singleton socket path under \`TMPDIR\`${bytes === undefined ? "" : ` (${bytes} bytes)`} is longer than the ${SOCKET_PATH_MAX_BYTES} bytes a Unix socket path allows. Set \`TMPDIR\` to a directory of at most ${SOCKET_PATH_MAX_BYTES - SOCKET_SUFFIX_BYTES} bytes, such as /tmp, and run again.`,
  );
}
