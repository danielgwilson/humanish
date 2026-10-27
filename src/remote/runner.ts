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
/**
 * Set in the runner's run, so any humanish there runs locally even when its study could run
 * remotely: a runner that launched a runner would repeat without end.
 */
export const INSIDE_RUNNER_ENV = "HUMANISH_INSIDE_RUNNER";
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

/** A study file read here, for the same place in the runner's project. */
export interface ProjectFile {
  /** Relative to the project, with `/` separators. */
  path: string;
  bytes: Uint8Array;
}

/**
 * Read each project-relative file in `files`, and every file under each directory in `directories`
 * that exists here, for upload to the runner. Read before any sandbox exists, so a refusal costs
 * nothing.
 */
export async function readProject(
  cwd: string,
  files: readonly string[],
  directories: readonly string[],
): Promise<ProjectFile[]> {
  const all = new Set(files);
  for (const directory of directories)
    for (const file of await filesUnder(cwd, directory)) all.add(file);
  const root = await realpath(cwd);
  const read: ProjectFile[] = [];
  for (const file of all) {
    // A link could hand the runner a file from anywhere on this machine, such as a key file, so
    // only a regular file whose real path is where the study names it is uploaded.
    const real = await realpath(path.join(cwd, file)).catch(() => undefined);
    if (real !== path.join(root, file) || !(await lstat(real)).isFile())
      throw new Error(
        `${file} is a link or not a regular file, so it is not uploaded to the runner.`,
      );
    read.push({ path: file, bytes: await readFile(real) });
  }
  return read;
}

/** What a runner is set up with. */
export interface RunnerSetup {
  /** This machine's humanish as an npm tarball; it may still be packing when setup starts. */
  tarball: Promise<Uint8Array>;
  /**
   * The npm specs its package depends on, from its own package.json, and the provider SDK its
   * participants need, as name@version.
   */
  dependencies: readonly string[];
  project: readonly ProjectFile[];
}

/** Study files written to the runner at once. */
const UPLOAD_CONCURRENCY = 8;
/** The npm project in the runner that holds this humanish and its dependencies. */
const RUNNER_APP = `${RUNNER_STATE}/app`;

/**
 * Install Node, this humanish's dependencies and this humanish in the runner, and upload the
 * study's files. Node's download starts at once and the dependencies install as soon as it is
 * there, while the tarball packs and uploads beside them; the tarball is then unpacked in place,
 * so no install waits for the pack. Returns the installed version.
 */
export async function setUpRunner(runner: Runner, setup: RunnerSetup): Promise<string> {
  const npm = `export PATH="$HOME/${RUNNER_STATE}/node/bin:$PATH"`;
  const dependencies = [
    "set -eu",
    `mkdir -p "$HOME/${RUNNER_APP}"`,
    `cd "$HOME/${RUNNER_APP}"`,
    npm,
    `printf '{"private":true}\\n' > package.json`,
    `npm install --no-save --no-package-lock --no-fund --no-audit --update-notifier=false --loglevel=error ${setup.dependencies.map(shellQuote).join(" ")}`,
  ].join("\n");
  const steps = [
    runOrFail(runner, "Installing Node", nodeInstallScript(), 600_000).then(() =>
      runOrFail(
        runner,
        "Installing humanish's dependencies",
        `bash -c ${shellQuote(dependencies)}`,
        600_000,
      ),
    ),
    setup.tarball.then((bytes) =>
      runner.shell.writeFile(`${RUNNER_STATE}/humanish.tgz`, toArrayBuffer(bytes)),
    ),
    uploadProject(runner, setup.project),
  ];
  await Promise.all(steps);
  // npm's own install would resolve every dependency again. Unpacked beside them, the package
  // finds them as an installed one does, and its bin goes where npm puts a global one.
  const unpack = [
    "set -eu",
    `cd "$HOME/${RUNNER_STATE}"`,
    npm,
    `package="$HOME/${RUNNER_APP}/node_modules/humanish"`,
    'mkdir -p "$package" && tar -xzf humanish.tgz --strip-components=1 -C "$package"',
    `bin="$package/$(node -p 'require(process.argv[1]).bin.humanish' "$package/package.json")"`,
    'chmod +x "$bin" && ln -sf "$bin" node/bin/humanish',
    `node -p 'require(process.argv[1]).version' "$package/package.json"`,
  ].join("\n");
  const result = await runOrFail(
    runner,
    "Installing humanish",
    `bash -c ${shellQuote(unpack)}`,
    600_000,
  );
  return result.stdout.trim().split("\n").at(-1) ?? "";
}

/** Download Node into the runner, check it against its published sha256 and extract it. */
function nodeInstallScript(): string {
  const { version, sha256 } = NODE;
  const script = [
    "set -eu",
    `mkdir -p "$HOME/${RUNNER_STATE}"`,
    `cd "$HOME/${RUNNER_STATE}"`,
    'case "$(uname -m)" in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; *) echo "unsupported CPU $(uname -m)" >&2; exit 1;; esac',
    `if [ "$arch" = x64 ]; then sum=${sha256.x64}; else sum=${sha256.arm64}; fi`,
    `curl -fsSL -o node.tgz "https://nodejs.org/dist/v${version}/node-v${version}-linux-$arch.tar.gz"`,
    'echo "$sum  node.tgz" | sha256sum -c - >/dev/null',
    "mkdir -p node && tar -xzf node.tgz --strip-components=1 -C node && rm node.tgz",
  ].join("\n");
  return `bash -c ${shellQuote(script)}`;
}

async function uploadProject(runner: Runner, files: readonly ProjectFile[]): Promise<void> {
  for (let at = 0; at < files.length; at += UPLOAD_CONCURRENCY)
    await Promise.all(
      files
        .slice(at, at + UPLOAD_CONCURRENCY)
        .map((file) =>
          runner.shell.writeFile(`${RUNNER_PROJECT}/${file.path}`, toArrayBuffer(file.bytes)),
        ),
    );
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
    // The runner's run is the remote run: it must not launch a runner of its own.
    "--local",
  ];
  const line = [
    `cd "$HOME/${RUNNER_PROJECT}"`,
    `export PATH="$HOME/${RUNNER_STATE}/node/bin:$PATH"`,
    `exec ${args.map((arg) => (arg.startsWith("$HOME") ? `"${arg}"` : shellQuote(arg))).join(" ")} > "$HOME/${RUNNER_STATE}/watch.out" 2> "$HOME/${RUNNER_STATE}/watch.err"`,
  ].join("; ");
  const env = {
    ...start.env,
    DO_NOT_TRACK: "1",
    HUMANISH_TELEMETRY_DISABLED: "1",
    [INSIDE_RUNNER_ENV]: "1",
  };
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

/** How often the runner checks its run while the launcher waits on it. */
const WAIT_CHECK_SECONDS = 0.2;
const SECTION = "--- humanish ";

/**
 * How the runner's run is going. The runner checks its run every 0.2 s for up to `waitMs` and
 * answers as soon as it differs from `seen`: a new state, a result, or its process ending. One
 * command answers each wait, so the launcher learns of a change within a check of it.
 */
export async function waitForRemoteRun(
  runner: Runner,
  runId: string,
  seen: { state: string | undefined; alive: boolean },
  waitMs: number,
): Promise<RemoteRunState> {
  const status = `$HOME/${RUNNER_PROJECT}/.humanish/runs/${runId}/status.json`;
  const result = `$HOME/${RUNNER_STATE}/result.json`;
  const checks = Math.max(1, Math.ceil(waitMs / 1000 / WAIT_CHECK_SECONDS));
  // The first "state" in status.json is the run's own; its outcome and analysis come after it.
  const script = [
    `status="${status}" result="${result}"`,
    `state() { grep -m1 -o '"state": *"[^"]*"' "$status" 2>/dev/null | sed 's/.*"\\([^"]*\\)"$/\\1/'; }`,
    `alive() { if pgrep -f ${shellQuote(watchPattern(runId))} >/dev/null; then echo 1; else echo 0; fi; }`,
    `i=0; while [ "$i" -lt ${checks} ]; do`,
    '  [ -s "$result" ] && break',
    `  [ "$(state)" != ${shellQuote(seen.state ?? "")} ] && break`,
    `  [ "$(alive)" != ${seen.alive ? 1 : 0} ] && break`,
    `  sleep ${WAIT_CHECK_SECONDS}; i=$((i + 1))`,
    "done",
    `echo "${SECTION}alive $(alive)"`,
    `echo "${SECTION}status"; cat "$status" 2>/dev/null`,
    `echo; echo "${SECTION}result"; cat "$result" 2>/dev/null`,
    `echo; echo "${SECTION}err"; tail -c 2000 "$HOME/${RUNNER_STATE}/watch.err" 2>/dev/null`,
    "exit 0",
  ].join("\n");
  const answer = await runner.shell.run(`bash -c ${shellQuote(script)}`, {
    timeoutMs: waitMs + 30_000,
  });
  if (answer.exitCode !== 0) throw new RunnerCommandError("Reading the run", answer);
  const sections = new Map<string, string>();
  let name: string | undefined;
  for (const line of answer.stdout.split("\n")) {
    if (line.startsWith(SECTION)) {
      const [key = "", ...rest] = line.slice(SECTION.length).split(" ");
      name = key;
      sections.set(key, rest.join(" "));
    } else if (name !== undefined) sections.set(name, `${sections.get(name)}${line}\n`);
  }
  const state = parseJson(sections.get("status"));
  const ended = parseJson(sections.get("result"));
  return {
    ...(typeof state?.state === "string" ? { state: state.state } : {}),
    ...(typeof ended?.exitCode === "number"
      ? { result: { exitCode: ended.exitCode, result: ended.result } }
      : {}),
    alive: sections.get("alive")?.trim() === "1",
    errTail: tailOf(sections.get("err")),
  };
}

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined || text.trim() === "") return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** One file of the runner's run directory: its path in the directory, its size and its sha256. */
export interface RemoteFile {
  path: string;
  size: number;
  sha256: string;
}

/**
 * The regular files of the runner's run directory, with their sizes and digests. Refuses a
 * directory that holds a link, which a run never writes.
 */
export async function listRemoteRun(runner: Runner, runId: string): Promise<RemoteFile[]> {
  const dir = `${RUNNER_PROJECT}/.humanish/runs/${runId}`;
  const listed = await runOrFail(
    runner,
    "Listing the run",
    `cd ${shellQuote(dir)} && find . ! -type f ! -type d -print -quit && echo "${SECTION}sizes" && find . -type f -printf '%s %p\\n' && echo "${SECTION}digests" && find . -type f -print0 | xargs -0 -r sha256sum`,
    300_000,
  );
  const [links = "", rest = ""] = listed.stdout.split(`${SECTION}sizes\n`);
  if (links.trim() !== "")
    throw new Error(
      `The runner's run directory holds something other than files and folders (${tailOf(links)}), so it is not copied.`,
    );
  const [sizes = "", digests = ""] = rest.split(`${SECTION}digests\n`);
  const size = new Map<string, number>();
  for (const line of sizes.split("\n")) {
    const match = /^(\d+) \.\/(.+)$/.exec(line);
    if (match !== null) size.set(match[2]!, Number(match[1]));
  }
  return parseDigests(digests).flatMap((file) => {
    const bytes = size.get(file.path);
    return bytes === undefined ? [] : [{ ...file, size: bytes }];
  });
}

/** sha256sum lines, `<hex>  ./<path>`, with paths relative to the directory. */
export function parseDigests(output: string): Omit<RemoteFile, "size">[] {
  const files: Omit<RemoteFile, "size">[] = [];
  for (const line of output.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *]\.\/(.+)$/.exec(line);
    if (match === null) continue;
    files.push({ sha256: match[1]!, path: match[2]! });
  }
  return files;
}

/**
 * The screenshots and recordings of the runner's run that have not changed for `settledSeconds`,
 * with their sizes. A run writes each of them once, so one that has settled can be copied while
 * the run goes on; files whose name starts with a dot are still being written.
 */
export async function listSettledEvidence(
  runner: Runner,
  runId: string,
  settledSeconds: number,
): Promise<{ path: string; size: number }[]> {
  const dir = `${RUNNER_PROJECT}/.humanish/runs/${runId}`;
  const listed = await runner.shell.run(
    `cd ${shellQuote(dir)} 2>/dev/null && find screenshots recordings -type f ! -name '.*' ! -newermt '${settledSeconds} seconds ago' -printf '%p\\t%s\\n' 2>/dev/null`,
    { timeoutMs: 120_000 },
  );
  return parseSizes(listed.stdout);
}

/** `find -printf '%p\t%s\n'` lines as paths and sizes; a path that leaves the directory is dropped. */
export function parseSizes(output: string): { path: string; size: number }[] {
  const files: { path: string; size: number }[] = [];
  for (const line of output.split("\n")) {
    const match = /^((?:screenshots|recordings)\/[^\t]+)\t(\d+)$/.exec(line);
    if (match === null || match[1]!.split("/").includes("..")) continue;
    files.push({ path: match[1]!, size: Number(match[2]) });
  }
  return files;
}

/** The bytes of one file of the runner's run directory, as they are now. */
export async function readRemoteBytes(
  runner: Runner,
  runId: string,
  file: string,
): Promise<Uint8Array> {
  return readRunnerBytes(runner, `${RUNNER_PROJECT}/.humanish/runs/${runId}/${file}`);
}

/** The bytes of a runner file, by its path under the sandbox user's home. */
async function readRunnerBytes(runner: Runner, file: string): Promise<Uint8Array> {
  const read = runner.sandbox.files.read;
  if (read === undefined) throw new Error("This sandbox cannot read files back.");
  const stream = await read.call(runner.sandbox.files, file, {
    format: "stream",
    requestTimeoutMs: 300_000,
  });
  const parts: Uint8Array[] = [];
  for await (const chunk of stream) parts.push(chunk);
  return Buffer.concat(parts);
}

/** The most bytes one batch of a copy joins into one runner file. */
const COPY_BATCH_BYTES = 64 * 1024 * 1024;
/** The most files one batch of a copy names on its command line. */
const COPY_BATCH_FILES = 200;
/** The runner file a batch is joined into, under the sandbox user's home. */
const COPY_FILE = `${RUNNER_STATE}/copy.bin`;

/**
 * Read `files` of the runner's run directory and hand each to `take`, checked against its listed
 * digest. The files go in batches, each joined into one runner file and read back in one request,
 * so a batch costs two round trips whatever its number of files.
 */
export async function readRemoteFiles(
  runner: Runner,
  runId: string,
  files: readonly RemoteFile[],
  take: (file: RemoteFile, bytes: Uint8Array) => Promise<void>,
): Promise<void> {
  const dir = `${RUNNER_PROJECT}/.humanish/runs/${runId}`;
  for (const batch of batches(files)) {
    // Each file's end offset in the joined file, so a file that changed size since the listing
    // still splits where it ends; its digest then refuses it.
    const joined = await runOrFail(
      runner,
      "Copying the run",
      `cd ${shellQuote(dir)} && : > "$HOME/${COPY_FILE}" && for f in ${batch.map((file) => shellQuote(file.path)).join(" ")}; do cat -- "$f" >> "$HOME/${COPY_FILE}" && wc -c < "$HOME/${COPY_FILE}" || exit 1; done`,
      300_000,
    );
    const ends = joined.stdout.trim().split("\n").map(Number);
    const bytes = await readRunnerBytes(runner, COPY_FILE);
    if (ends.length !== batch.length || ends.at(-1) !== bytes.byteLength)
      throw new Error("A batch of the run's files arrived incomplete from the runner.");
    let start = 0;
    for (const [index, file] of batch.entries()) {
      const part = bytes.subarray(start, ends[index]);
      start = ends[index]!;
      if (createHash("sha256").update(part).digest("hex") !== file.sha256)
        throw new Error(
          `${file.path} changed or arrived damaged while it was copied from the runner.`,
        );
      await take(file, part);
    }
  }
  if (files.length > 0)
    await runner.shell
      .run(`rm -f "$HOME/${COPY_FILE}"`, { timeoutMs: 30_000 })
      .catch(() => undefined);
}

function batches(files: readonly RemoteFile[]): RemoteFile[][] {
  const all: RemoteFile[][] = [];
  let batch: RemoteFile[] = [];
  let bytes = 0;
  for (const file of files) {
    if (
      batch.length > 0 &&
      (bytes + file.size > COPY_BATCH_BYTES || batch.length >= COPY_BATCH_FILES)
    ) {
      all.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(file);
    bytes += file.size;
  }
  if (batch.length > 0) all.push(batch);
  return all;
}

/** Ask the runner's run to stop as a signal would, so it reclaims its participants and ends. */
export async function stopRemoteRun(runner: Runner, runId: string): Promise<void> {
  await runner.shell.run(`pkill -TERM -f ${shellQuote(watchPattern(runId))} || true`, {
    timeoutMs: 30_000,
  });
}

/**
 * The process pattern of the runner's `humanish watch` for `runId`, so a check run anywhere else
 * never matches another run's process. The `[h]` keeps it from matching the shell that runs it.
 */
function watchPattern(runId: string): string {
  // The launcher mints ids from letters, digits and dashes, none of which a pattern or shell reads.
  if (!/^[A-Za-z0-9-]+$/.test(runId))
    throw new Error(`Run id ${runId} is not one a launcher mints.`);
  return `[h]umanish watch .*--run-id ${runId}( |$)`;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
