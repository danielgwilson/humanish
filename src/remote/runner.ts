// What the launcher does inside a runner sandbox, over the sandbox port's commands and files: install
// Node and this humanish, upload the study's files, start its run, read how it is going, and copy
// the finished run back.
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import type { E2BDesktopSandbox } from "../substrates/e2b/sdk.js";
import { e2bShell } from "../substrates/e2b/shell.js";
import { shellQuote, type Shell, type ShellResult } from "../substrates/shell.js";
import { tailOf } from "../substrates/shell.js";

/** The project directory in the runner, under the sandbox user's home on both providers. */
const RUNNER_PROJECT = "project";
/** Where the runner keeps the launcher's own files: the result file and the run's output. */
const RUNNER_STATE = ".humanish-remote";
/** The port the runner's Observer listens on. */
export const RUNNER_OBSERVER_PORT = 7000;

/**
 * The Node release the runner runs humanish on, with the sha256 nodejs.org publishes for each
 * build (SHASUMS256.txt). The runner checks the download against it before extracting.
 */
const NODE = {
  version: "22.23.4",
  sha256: {
    x64: "b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406",
    arm64: "f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9",
  },
} as const;

/** A runner sandbox and the shell into it. */
export interface Runner {
  readonly sandbox: E2BDesktopSandbox;
  readonly shell: Shell;
}

export function runnerOf(sandbox: E2BDesktopSandbox): Runner {
  return { sandbox, shell: e2bShell(sandbox) };
}

/** A command failed in the runner; the message carries its exit code and output tail. */
class RunnerCommandError extends Error {
  constructor(step: string, result: ShellResult) {
    super(
      `${step} failed in the runner sandbox (exit ${result.exitCode}): ${tailOf(result.stderr || result.stdout)}`,
    );
    this.name = "RunnerCommandError";
  }
}

async function runOrFail(runner: Runner, step: string, command: string, timeoutMs: number) {
  const result = await runner.shell.run(command, { timeoutMs });
  if (result.exitCode !== 0) throw new RunnerCommandError(step, result);
  return result;
}

/**
 * Install Node and the humanish package `tarball` (this machine's own humanish, packed), with the
 * provider SDKs its participants need at `peers` (name@version). Returns the installed version.
 */
export async function installHumanish(
  runner: Runner,
  tarball: Uint8Array,
  peers: readonly string[],
): Promise<string> {
  await runner.shell.writeFile(`${RUNNER_STATE}/humanish.tgz`, toArrayBuffer(tarball));
  const { version, sha256 } = NODE;
  const script = [
    "set -eu",
    `cd "$HOME/${RUNNER_STATE}"`,
    'case "$(uname -m)" in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; *) echo "unsupported CPU $(uname -m)" >&2; exit 1;; esac',
    `if [ "$arch" = x64 ]; then sum=${sha256.x64}; else sum=${sha256.arm64}; fi`,
    `curl -fsSL -o node.tgz "https://nodejs.org/dist/v${version}/node-v${version}-linux-$arch.tar.gz"`,
    'echo "$sum  node.tgz" | sha256sum -c - >/dev/null',
    "mkdir -p node && tar -xzf node.tgz --strip-components=1 -C node && rm node.tgz",
    `export PATH="$HOME/${RUNNER_STATE}/node/bin:$PATH" npm_config_prefix="$HOME/${RUNNER_STATE}/node"`,
    `npm install -g --no-fund --no-audit --loglevel=error ./humanish.tgz ${peers.map(shellQuote).join(" ")}`,
    "humanish --version",
  ].join("\n");
  const result = await runOrFail(
    runner,
    "Installing humanish",
    `bash -c ${shellQuote(script)}`,
    600_000,
  );
  return result.stdout.trim().split("\n").at(-1) ?? "";
}

/**
 * Upload each project-relative file in `files`, and every file under each directory in
 * `directories` that exists here, to the same place in the runner's project.
 */
export async function uploadProject(
  runner: Runner,
  cwd: string,
  files: readonly string[],
  directories: readonly string[],
): Promise<number> {
  const all = new Set(files);
  for (const directory of directories)
    for (const file of await filesUnder(cwd, directory)) all.add(file);
  const root = await realpath(cwd);
  for (const file of all) {
    // A link could hand the runner a file from anywhere on this machine, such as a key file, so
    // only a regular file whose real path is where the study names it is uploaded.
    const real = await realpath(path.join(cwd, file)).catch(() => undefined);
    if (real !== path.join(root, file) || !(await lstat(real)).isFile())
      throw new Error(
        `${file} is a link or not a regular file, so it is not uploaded to the runner.`,
      );
    const bytes = await readFile(real);
    await runner.shell.writeFile(`${RUNNER_PROJECT}/${file}`, toArrayBuffer(bytes));
  }
  return all.size;
}

async function filesUnder(cwd: string, directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path.join(cwd, directory), { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(cwd, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
    );
}

/** What the runner's run is started with. */
export interface RemoteRunStart {
  /** The study file, relative to the project. */
  study: string;
  runId: string;
  ownerKey: string;
  /** Only these names reach the run, each with its value from this machine. */
  env: Readonly<Record<string, string>>;
}

/**
 * Start the study's run in the runner as `humanish watch --serve`, so the run process itself serves
 * the Observer with its live desktop streams, and writes its result to a file the launcher reads.
 */
export async function startRemoteRun(runner: Runner, start: RemoteRunStart): Promise<void> {
  const args = [
    "humanish",
    "watch",
    start.study,
    "--serve",
    "--no-open",
    "--port",
    String(RUNNER_OBSERVER_PORT),
    "--all-interfaces",
    "--result-file",
    `$HOME/${RUNNER_STATE}/result.json`,
    "--run-id",
    start.runId,
    "--owner-key",
    start.ownerKey,
  ];
  const line = [
    `cd "$HOME/${RUNNER_PROJECT}"`,
    `export PATH="$HOME/${RUNNER_STATE}/node/bin:$PATH"`,
    `exec ${args.map((arg) => (arg.startsWith("$HOME") ? `"${arg}"` : shellQuote(arg))).join(" ")} > "$HOME/${RUNNER_STATE}/watch.out" 2> "$HOME/${RUNNER_STATE}/watch.err"`,
  ].join("; ");
  const env = { ...start.env, DO_NOT_TRACK: "1", HUMANISH_TELEMETRY_DISABLED: "1" };
  const result = await runner.shell.start(`bash -c ${shellQuote(line)}`, {
    env,
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) throw new RunnerCommandError("Starting the run", result);
}

/** How the runner's run is going, read from its own files. */
export interface RemoteRunState {
  /** status.json's `state`, once the run has written one. */
  state?: string;
  /** The result the run wrote when it ended, with the exit code the command would return. */
  result?: { exitCode: number; result: unknown };
  /** Whether the run's process is still alive in the runner. */
  alive: boolean;
  /** The last lines the run wrote to stderr. */
  errTail: string;
}

export async function readRemoteRun(runner: Runner, runId: string): Promise<RemoteRunState> {
  const read = async (file: string): Promise<string | undefined> => {
    const result = await runner.shell.run(`cat -- ${shellQuote(file)} 2>/dev/null`, {
      timeoutMs: 30_000,
    });
    return result.exitCode === 0 ? result.stdout : undefined;
  };
  const status = parseJson(await read(`${RUNNER_PROJECT}/.humanish/runs/${runId}/status.json`));
  const result = parseJson(await read(`${RUNNER_STATE}/result.json`));
  const err = await runner.shell.run(`tail -c 2000 ${RUNNER_STATE}/watch.err 2>/dev/null`, {
    timeoutMs: 30_000,
  });
  const alive = await runner.shell.run("pgrep -f '[h]umanish watch' >/dev/null", {
    timeoutMs: 30_000,
  });
  return {
    ...(typeof status?.state === "string" ? { state: status.state } : {}),
    ...(typeof result?.exitCode === "number"
      ? { result: { exitCode: result.exitCode, result: result.result } }
      : {}),
    alive: alive.exitCode === 0,
    errTail: tailOf(err.stdout),
  };
}

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** One file of the runner's run directory: its path in the directory and its sha256. */
export interface RemoteFile {
  path: string;
  sha256: string;
}

/**
 * The regular files of the runner's run directory and their digests. Refuses a directory that holds
 * a link, which a run never writes.
 */
export async function listRemoteRun(runner: Runner, runId: string): Promise<RemoteFile[]> {
  const dir = `${RUNNER_PROJECT}/.humanish/runs/${runId}`;
  const links = await runOrFail(
    runner,
    "Listing the run",
    `cd ${shellQuote(dir)} && find . ! -type f ! -type d -print -quit`,
    60_000,
  );
  if (links.stdout.trim() !== "")
    throw new Error(
      `The runner's run directory holds something other than files and folders (${tailOf(links.stdout)}), so it is not copied.`,
    );
  const listed = await runOrFail(
    runner,
    "Listing the run",
    `cd ${shellQuote(dir)} && find . -type f -print0 | xargs -0 -r sha256sum`,
    300_000,
  );
  return parseDigests(listed.stdout);
}

/** sha256sum lines, `<hex>  ./<path>`, as RemoteFiles with paths relative to the directory. */
export function parseDigests(output: string): RemoteFile[] {
  const files: RemoteFile[] = [];
  for (const line of output.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *]\.\/(.+)$/.exec(line);
    if (match === null) continue;
    files.push({ sha256: match[1]!, path: match[2]! });
  }
  return files;
}

/** The bytes of one file of the runner's run directory, checked against its listed digest. */
export async function readRemoteFile(
  runner: Runner,
  runId: string,
  file: RemoteFile,
): Promise<Uint8Array> {
  const read = runner.sandbox.files.read;
  if (read === undefined) throw new Error("This sandbox cannot read files back.");
  const stream = await read.call(
    runner.sandbox.files,
    `${RUNNER_PROJECT}/.humanish/runs/${runId}/${file.path}`,
    { format: "stream", requestTimeoutMs: 300_000 },
  );
  const parts: Uint8Array[] = [];
  for await (const chunk of stream) parts.push(chunk);
  const bytes = Buffer.concat(parts);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== file.sha256)
    throw new Error(`${file.path} changed or arrived damaged while it was copied from the runner.`);
  return bytes;
}

/**
 * Ask the runner's run to stop as a signal would, so it reclaims its participants and ends. The
 * `[h]` keeps the pattern from matching the shell that runs it.
 */
export async function stopRemoteRun(runner: Runner): Promise<void> {
  await runner.shell.run("pkill -TERM -f '[h]umanish watch' || true", { timeoutMs: 30_000 });
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
