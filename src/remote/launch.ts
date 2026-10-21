// `humanish run|watch <study> --remote`: run the study's own process in a runner sandbox on its
// participants' provider, follow it from here, and copy the finished run back. This machine only
// plans, launches and watches, so it may sleep or lose its network while the study goes on.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { readContainedRegularFile, writeContainedOutputFile } from "../run/contained-output.js";
import { createRunArtifactPaths, type PreparedRunArtifactPaths } from "../run/paths.js";
import { reclaimRunSandboxes } from "../run/reclaim.js";
import { pointLatestRunAt } from "../run/run.js";
import { appendSandboxOwner, SANDBOX_RECEIPTS_ARTIFACT } from "../run/sandbox-receipts.js";
import { loadE2BBaseModule } from "../substrates/e2b/base-module.js";
import { e2bConnection } from "../substrates/e2b/connection.js";
import { acquireE2BShellSandbox } from "../substrates/e2b/sandbox.js";
import { loadModalShellModule } from "../substrates/modal/sandbox.js";
import type { RemotePlan } from "./plan.js";
import { serveObserverProxy, type ObserverProxy } from "./observer-proxy.js";
import {
  installHumanish,
  listRemoteRun,
  readRemoteFile,
  readRemoteRun,
  RUNNER_OBSERVER_PORT,
  runnerOf,
  startRemoteRun,
  stopRemoteRun,
  uploadProject,
  type Runner,
} from "./runner.js";

/** How often the launcher reads the runner's run while it follows it. */
const POLL_MS = 5_000;
/** Reads in a row the runner may leave unanswered before the launcher gives it up. */
const UNANSWERED_LIMIT = 24;
/** How long the run has to write its status record after it is started. */
const START_DEADLINE_MS = 3 * 60_000;
/** How long a stopped run has to end and write its result. */
const STOP_DEADLINE_MS = 2 * 60_000;

export interface RemoteLaunch {
  cwd: string;
  /** The study file, relative to cwd. */
  study: string;
  remote: RemotePlan;
  env: Readonly<Record<string, string | undefined>>;
  /** Local Observer port; 0 picks a free one. */
  port: number;
  /** Progress lines for a person, on stderr. */
  say: (line: string) => void;
}

/** What a remote run ended as, for the command's result and exit code. */
export interface RemoteOutcome {
  runId: string;
  exitCode: number;
  /** The run's own result, as the runner's command wrote it. */
  result?: unknown;
  /** Why the remote run did not finish, when it did not. */
  error?: string;
  /** Left running on purpose: the terminal closed while the study went on. */
  detached?: boolean;
  files?: number;
}

/** Launch, follow and copy back one remote run. */
export async function launchRemoteRun(launch: RemoteLaunch): Promise<RemoteOutcome> {
  const { cwd, remote, say } = launch;
  const runId = `cua-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
  const ownerKey = randomBytes(8).toString("hex");
  const created = await createRunArtifactPaths(cwd, runId);
  if (!created.ok) throw new Error(`Run ${runId} already exists here.`);
  const paths = created.paths;
  // The participants carry the key the runner's run pins; this directory records it as an owner
  // line, so reclaim here finds them. The runner itself carries this directory's own key, so the
  // remote run, which reclaims by its key when it stops, never matches the sandbox it runs in.
  const owned = await appendSandboxOwner(
    paths,
    { tool: "humanish", runId, runKey: ownerKey },
    remote.provider,
  );
  if (!owned)
    throw new Error(
      `Could not record run ${runId}'s owner tags in its run directory, so a later reclaim could not find its sandboxes. Nothing was created.`,
    );

  // Installed before the first sandbox exists, so a signal never ends this process while one is
  // being created without a cleanup.
  const signals = watchSignals();
  let tarballDir: string | undefined;
  let proxy: ObserverProxy | undefined;
  try {
    const tarball = await packThisHumanish();
    tarballDir = tarball.dir;
    const where = remote.provider === "modal" ? "a Modal sandbox" : "an E2B sandbox";
    say(`Running this study on ${where} as run ${runId}; creating the runner.`);
    const runner = runnerOf((await acquireRunner(launch, paths)).sandbox);
    if (signals.requested !== undefined)
      return await endRun(launch, runId, {
        exitCode: signals.exitCode,
        error: "stopped before the run started",
      });
    await writeRemoteRecord(paths, {
      runId,
      provider: remote.provider,
      deadline: new Date(Date.now() + remote.runnerMs).toISOString(),
    });
    // Bound before the run starts, so a taken --port fails before any participant exists.
    proxy = await serveObserverProxy(
      await runner.sandbox.portAccess!(RUNNER_OBSERVER_PORT),
      launch.port,
    );
    const version = await installHumanish(runner, tarball.bytes, [await peerSpec(remote.provider)]);
    say(`Installed humanish ${version} in the runner; uploading the study.`);
    await uploadProject(runner, cwd, remote.uploads, remote.uploadDirectories);
    if (signals.requested !== undefined)
      return await endRun(launch, runId, {
        exitCode: signals.exitCode,
        error: "stopped before the run started",
      });
    await startRemoteRun(runner, {
      study: launch.study,
      runId,
      ownerKey,
      env: Object.fromEntries(
        remote.envNames.flatMap((name) => {
          const value = launch.env[name];
          return value === undefined || value === "" ? [] : [[name, value]];
        }),
      ),
    });
    return await followRemoteRun({ launch, runner, paths, runId, signals, proxyUrl: proxy.url });
  } catch (error) {
    await reclaimRunSandboxes(cwd, runId, { env: launch.env }).catch(() => undefined);
    throw error;
  } finally {
    signals.dispose();
    await proxy?.close();
    if (tarballDir !== undefined) await rm(tarballDir, { recursive: true, force: true });
  }
}

async function acquireRunner(launch: RemoteLaunch, paths: PreparedRunArtifactPaths) {
  const { provider, runnerMs } = launch.remote;
  const module =
    provider === "modal" ? await loadModalShellModule(launch.env) : await loadE2BBaseModule();
  // A Modal module takes its connection from launch.env and ignores these two.
  const { apiKey = "", ...account } = e2bConnection(launch.env);
  return acquireE2BShellSandbox({
    module,
    provider,
    options: {
      apiKey,
      ...account,
      timeoutMs: runnerMs,
      metadata: { participantId: "runner" },
      network: { allowPublicTraffic: false },
    },
    receipt: { root: paths, participantId: "runner" },
  });
}

/** Follows the run until it ends, is stopped, detaches or stops answering. */
async function followRemoteRun(args: {
  launch: RemoteLaunch;
  runner: Runner;
  paths: PreparedRunArtifactPaths;
  runId: string;
  signals: Signals;
  proxyUrl: string;
}): Promise<RemoteOutcome> {
  const { launch, runner, paths, runId, signals } = args;
  const { say } = launch;
  const copy = () => copyRunBack(runner, paths, runId);
  let state: string | undefined;
  let stopAt: number | undefined;
  let unanswered = 0;
  const startBy = Date.now() + START_DEADLINE_MS;
  for (;;) {
    const run = await readRemoteRun(runner, runId).catch(() => undefined);
    unanswered = run === undefined ? unanswered + 1 : 0;
    if (run?.state !== undefined && state === undefined) {
      say(`Run ${runId} started. Watch it live at ${args.proxyUrl}`);
      say("Closing this terminal leaves the study running; Ctrl-C stops it.");
    }
    if (run?.state !== undefined && run.state !== state) {
      state = run.state;
      if (state !== "running") say(`Run ${runId} is ${state}.`);
    }
    if (run?.result !== undefined) {
      say("The run ended; copying its evidence back.");
      const copied = await copy().then(
        (files) => ({ files }),
        (error: unknown) => ({ error }),
      );
      // The run reclaimed its participants as it ended; only the runner is left, and it holds the
      // only whole copy of the evidence until a copy succeeds.
      if ("error" in copied && stopAt === undefined)
        return {
          runId,
          exitCode: 2,
          error: `copying the evidence back failed (${message(copied.error)}). The runner keeps it until the deadline in its remote.json; stop it sooner with humanish reclaim --run ${runId}`,
        };
      return await endRun(launch, runId, {
        // A run stopped from here exits as a local one does on that signal.
        exitCode: stopAt === undefined ? run.result.exitCode : signals.exitCode,
        result: run.result.result,
        ...("files" in copied
          ? { files: copied.files }
          : { error: `copying the evidence back failed: ${message(copied.error)}` }),
      });
    }
    if (signals.requested === "detach") return { runId, exitCode: 0, detached: true };
    if (signals.requested === "stop" && stopAt === undefined) {
      say("Stopping the remote run; its participants are reclaimed before it ends.");
      stopAt = Date.now() + STOP_DEADLINE_MS;
      if (state === undefined)
        return await endRun(launch, runId, {
          exitCode: signals.exitCode,
          error: "stopped before the run started",
        });
      await stopRemoteRun(runner).catch(() => undefined);
    }
    const ended =
      unanswered >= UNANSWERED_LIMIT
        ? `the runner sandbox stopped answering for ${(UNANSWERED_LIMIT * POLL_MS) / 1000} s`
        : run !== undefined && state !== undefined && !run.alive
          ? stopAt === undefined
            ? `the run ended without a result: ${run.errTail || "no output"}`
            : "stopped"
          : stopAt !== undefined && Date.now() > stopAt
            ? "stopped, and the run did not end in time"
            : state === undefined && Date.now() > startBy
              ? `the run did not start in the runner: ${run?.errTail || "no output"}`
              : undefined;
    if (ended !== undefined) {
      // Participants may still be running, so everything is reclaimed after whatever copies.
      const copied = await copy().then(
        (files) => ({ files }),
        (error: unknown) => ({ error }),
      );
      return await endRun(launch, runId, {
        exitCode: stopAt === undefined ? 2 : signals.exitCode,
        error:
          "files" in copied
            ? ended
            : `${ended}; copying its evidence back failed: ${message(copied.error)}`,
        ...("files" in copied ? { files: copied.files } : {}),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * Copy every file of the runner's run directory into this machine's run directory, each checked
 * against the digest the runner listed. The sandbox journal keeps this machine's lines (the
 * runner's own receipt) and adds the runner's (its participants').
 */
async function copyRunBack(
  runner: Runner,
  paths: PreparedRunArtifactPaths,
  runId: string,
): Promise<number> {
  const files = await listRemoteRun(runner, runId);
  for (const file of files) {
    if (file.path === "owner-key") continue;
    const bytes = await readRemoteFile(runner, runId, file);
    if (file.path === SANDBOX_RECEIPTS_ARTIFACT) {
      const local = await readContainedRegularFile(paths, file.path, 16 * 1024 * 1024);
      const mine = local.status === "read" ? Buffer.from(local.bytes).toString("utf8") : "";
      await writeContainedOutputFile(
        paths,
        file.path,
        joinJournals(mine, Buffer.from(bytes).toString("utf8")),
        "utf8",
      );
      continue;
    }
    await writeContainedOutputFile(paths, file.path, bytes);
  }
  await pointLatestRunAt(paths, runId);
  return files.length;
}

/** Two sandbox journals as one: every line of each, in order, one per line. */
export function joinJournals(...journals: string[]): string {
  const lines = journals
    .flatMap((journal) => journal.split("\n"))
    .filter((line) => line.trim() !== "");
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * Reclaim every sandbox of the run, by receipt and by its tags, and report a reclaim that did not
 * come back clean as an error and a failing exit code.
 */
async function endRun(
  launch: RemoteLaunch,
  runId: string,
  outcome: Omit<RemoteOutcome, "runId">,
): Promise<RemoteOutcome> {
  const reclaimed = await reclaimRunSandboxes(launch.cwd, runId, { env: launch.env }).then(
    (result) => result.ok,
    () => false,
  );
  if (reclaimed) return { runId, ...outcome };
  return {
    runId,
    ...outcome,
    exitCode: outcome.exitCode === 0 ? 2 : outcome.exitCode,
    error: [
      outcome.error,
      `its sandboxes were not confirmed stopped; run humanish reclaim --run ${runId}`,
    ]
      .filter(Boolean)
      .join("; "),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The run directory's record of where its run executes. It holds no credential and no raw sandbox
 * id: the runner's id is in the sandbox journal with every other, as its `runner` receipt.
 */
async function writeRemoteRecord(
  paths: PreparedRunArtifactPaths,
  record: { runId: string; provider: string; deadline: string },
): Promise<void> {
  await writeContainedOutputFile(
    paths,
    "remote.json",
    `${JSON.stringify({ schema: "humanish.remote-run.v1", ...record }, null, 2)}\n`,
    "utf8",
  );
}

interface Signals {
  readonly requested: "stop" | "detach" | undefined;
  /** The exit code a local run gives for the stop signal received: 130 for SIGINT, 143 for SIGTERM. */
  readonly exitCode: number;
  dispose(): void;
}

/**
 * Ctrl-C and SIGTERM stop the run, as they stop a local one. A closed terminal (SIGHUP) leaves it
 * running; the runner ends it at its deadline.
 */
function watchSignals(): Signals {
  let requested: "stop" | "detach" | undefined;
  let exitCode = 130;
  const interrupt = () => {
    requested ??= "stop";
  };
  const terminate = () => {
    if (requested === undefined) exitCode = 143;
    requested ??= "stop";
  };
  const detach = () => {
    requested ??= "detach";
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  process.on("SIGHUP", detach);
  return {
    get requested() {
      return requested;
    },
    get exitCode() {
      return exitCode;
    },
    dispose() {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      process.off("SIGHUP", detach);
    },
  };
}

/**
 * This machine's humanish as an npm tarball, so the runner runs exactly the same code. A run from
 * source has no built package to pack.
 */
async function packThisHumanish(): Promise<{ bytes: Uint8Array; dir: string }> {
  const here = fileURLToPath(import.meta.url);
  const root = path.resolve(path.dirname(here), "..", "..");
  if (path.relative(root, here).split(path.sep)[0] !== "dist")
    throw new Error(
      "A remote run installs this humanish in the runner, and a run from source has no built package. Run `pnpm build`, then `node dist/cli.js`, or use an installed humanish.",
    );
  const dir = await mkdtemp(path.join(tmpdir(), "humanish-pack-"));
  const { stdout } = await promisify(execFile)(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", dir, root],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const [packed] = JSON.parse(stdout) as [{ filename: string }];
  return { bytes: await readFile(path.join(dir, packed.filename)), dir };
}

/** The provider SDK the runner's participants need, at the version this machine has. */
async function peerSpec(provider: string): Promise<string> {
  const name = provider === "modal" ? "modal" : "@e2b/desktop";
  try {
    const entry = fileURLToPath(import.meta.resolve(name));
    for (let dir = path.dirname(entry); dir !== path.dirname(dir); dir = path.dirname(dir)) {
      const manifest = await readFile(path.join(dir, "package.json"), "utf8").catch(
        () => undefined,
      );
      if (manifest === undefined) continue;
      const parsed = JSON.parse(manifest) as { name?: string; version?: string };
      if (parsed.name === name && parsed.version !== undefined) return `${name}@${parsed.version}`;
    }
  } catch {
    // Not installed here, which planning already refused; the runner takes the latest.
  }
  return name;
}
