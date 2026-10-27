// `humanish run|watch <study> --remote`: run the study's own process in a runner sandbox on its
// participants' provider, follow it from here, and copy the finished run back. This machine only
// plans, launches and watches, so it may sleep or lose its network while the study goes on.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  readContainedRegularFile,
  removeContainedOutputFile,
  writeContainedOutputFile,
} from "../run/contained-output.js";
import { createRunArtifactPaths, type PreparedRunArtifactPaths } from "../run/paths.js";
import { reclaimRunSandboxes } from "../run/reclaim.js";
import { pointLatestRunAt } from "../run/run.js";
import {
  appendSandboxOwner,
  SANDBOX_RECEIPTS_ARTIFACT,
  type SandboxProviderId,
} from "../run/sandbox-receipts.js";
import { loadE2BBaseModule } from "../substrates/e2b/base-module.js";
import { e2bConnection } from "../substrates/e2b/connection.js";
import { E2B_SYSTEM_CA_BUNDLE, holdKeysInEgress } from "../substrates/e2b/egress-keys.js";
import { acquireE2BShellSandbox } from "../substrates/e2b/sandbox.js";
import type { E2BNetworkOptions } from "../substrates/e2b/sdk.js";
import { loadModalShellModule } from "../substrates/modal/sandbox.js";
import type { RemotePlan } from "./plan.js";
import { serveObserverProxy, type ObserverProxy } from "./observer-proxy.js";
import {
  listRemoteRun,
  listSettledEvidence,
  readProject,
  readRemoteBytes,
  readRemoteFiles,
  RUNNER_OBSERVER_PORT,
  runnerOf,
  setUpRunner,
  startRemoteRun,
  stopRemoteRun,
  waitForRemoteRun,
  type RemoteFile,
  type RemoteRunState,
  type Runner,
} from "./runner.js";

/** The longest one read of the runner's run waits there for a change. */
const WAIT_MS = 5_000;
/** How long the launcher waits after a read the runner did not answer before it reads again. */
const RETRY_MS = 5_000;
/** How long the runner may leave reads unanswered before the launcher gives it up. */
const UNANSWERED_LIMIT_MS = 120_000;
/** How long the run has to write its status record after it is started. */
const START_DEADLINE_MS = 3 * 60_000;
/** How often the launcher copies the run's settled evidence while it goes on. */
const SYNC_EVERY_MS = 30_000;
/** How long a screenshot or recording must be unchanged before it is copied mid-run. */
const SETTLED_SECONDS = 10;
/** The largest file read back to compare digests: a recording's own limit, with room. */
const LARGEST_FILE_BYTES = 256 * 1024 * 1024;
/** How long a stopped run has to end and write its result. */
const STOP_DEADLINE_MS = 2 * 60_000;

/** What following a remote run needs from its caller: the project, its env and a progress line. */
export interface RemoteContext {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Progress lines for a person, on stderr. */
  say: (line: string) => void;
}

export interface RemoteLaunch extends RemoteContext {
  /** The study file, relative to cwd. */
  study: string;
  remote: RemotePlan;
  /** Local Observer port; 0 picks a free one. */
  port: number;
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
  // The prefix the route gives a local run, so a remote run's id reads the same.
  const prefix = remote.route === "terminal" ? "terminal" : "cua";
  const runId = `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
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
  let proxy: ObserverProxy | undefined;
  let tarball: Promise<Uint8Array> | undefined;
  try {
    // Read and checked before any sandbox exists, so a refused file costs nothing.
    const project = await readProject(cwd, remote.uploads, remote.uploadDirectories);
    // Packed while the runner is created and Node installs in it.
    tarball = packThisHumanish();
    tarball.catch(() => undefined);
    if (signals.requested !== undefined)
      return { runId, exitCode: signals.exitCode, error: "stopped before the runner was created" };
    const where = remote.provider === "modal" ? "a Modal sandbox" : "an E2B sandbox";
    say(`Running this study on ${where} as run ${runId}; creating the runner.`);
    const keys = runnerKeys(remote, launch.env);
    const runner = runnerOf((await acquireRunner(launch, paths, keys.network)).sandbox);
    if (signals.requested !== undefined)
      return await endRun(launch, runId, {
        exitCode: signals.exitCode,
        error: "stopped before the run started",
      });
    // Setting up can take minutes; a signal stops waiting for it, and the reclaim below stops the
    // runner, and the setup with it. A setup left behind that way fails once its runner is gone.
    const setup = setUpRunner(runner, {
      tarball,
      dependencies: [...(await ownDependencies()), await peerSpec(remote.provider)],
      project,
    });
    setup.catch(() => undefined);
    await writeRemoteRecord(paths, {
      runId,
      provider: remote.provider,
      route: remote.route,
      deadline: new Date(Date.now() + remote.runnerMs).toISOString(),
    });
    // Bound before the run starts, so a taken --port fails before any participant exists. A
    // terminal run has no live Observer, here or locally: it renders one when it ends.
    if (remote.route === "computer-use")
      proxy = await serveObserverProxy(
        await runner.sandbox.portAccess!(RUNNER_OBSERVER_PORT),
        launch.port,
      );
    const version = await Promise.race([setup, signals.received.then(() => "")]);
    if (signals.requested !== undefined)
      return await endRun(launch, runId, {
        exitCode: signals.exitCode,
        error: "stopped before the run started",
      });
    say(`Installed humanish ${version} in the runner and uploaded the study; starting its run.`);
    await startRemoteRun(runner, {
      study: launch.study,
      runId,
      ownerKey,
      env: keys.env,
    });
    return await followRemoteRun({ launch, runner, paths, runId, signals, proxyUrl: proxy?.url });
  } catch (error) {
    const reclaimed = await reclaimRunSandboxes(cwd, runId, { env: launch.env }).then(
      (result) => result.ok,
      () => false,
    );
    if (reclaimed) throw error;
    throw new Error(
      `${message(error)}; its sandboxes were not confirmed stopped, so run humanish reclaim --run ${runId}`,
      { cause: error },
    );
  } finally {
    signals.dispose();
    await proxy?.close();
    // A pack still going removes its directory when it ends; this process waits for that.
    await tarball?.catch(() => undefined);
  }
}

async function acquireRunner(
  launch: RemoteLaunch,
  paths: PreparedRunArtifactPaths,
  network: E2BNetworkOptions,
) {
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
      network,
    },
    receipt: { root: paths, participantId: "runner" },
  });
}

/** Follows the run until it ends, is stopped, detaches or stops answering. */
export async function followRemoteRun(args: {
  launch: RemoteContext;
  runner: Runner;
  paths: PreparedRunArtifactPaths;
  runId: string;
  signals: Signals;
  /** The local Observer address, for a run that has a live Observer. */
  proxyUrl: string | undefined;
}): Promise<RemoteOutcome> {
  const { launch, runner, paths, runId, signals } = args;
  const { say } = launch;
  // Evidence already copied while the run went on, by path, with its size then.
  const copied = new Map<string, number>();
  const copy = async () => {
    const { files, alreadyHere } = await copyRunBack(runner, paths, runId, copied);
    if (alreadyHere > 0) say(`${alreadyHere} of its ${files} files were already here.`);
    return files;
  };
  let syncAt = Date.now() + SYNC_EVERY_MS;
  let state: string | undefined;
  let stopAt: number | undefined;
  let answeredAt = Date.now();
  // The run was started just before, so it is taken as alive until a read says otherwise.
  let alive = true;
  const startBy = Date.now() + START_DEADLINE_MS;
  for (;;) {
    const read = await readRun(runner, runId, { state, alive }, signals);
    // A signal ends the read, and is handled below without one.
    const run = read === "signal" ? undefined : read;
    if (read === undefined) {
      if (Date.now() - answeredAt < UNANSWERED_LIMIT_MS)
        await Promise.race([
          new Promise((resolve) => setTimeout(resolve, RETRY_MS)),
          signals.requested === undefined ? signals.received : new Promise(() => undefined),
        ]);
    } else if (run !== undefined) {
      answeredAt = Date.now();
      alive = run.alive;
    }
    if (run?.state !== undefined && state === undefined) {
      say(
        args.proxyUrl === undefined
          ? `Run ${runId} is running. Its Observer is ready once the run ends and is copied back: humanish observe --run ${runId}`
          : `Run ${runId} is running. Watch it live at ${args.proxyUrl}`,
      );
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
      // only whole copy of the evidence until a copy succeeds. It is kept only then: a run that
      // refused before its run directory existed has nothing to keep, and its own result says why.
      // Its result is not reported as the run's own, since the evidence is not here.
      if ("error" in copied && stopAt === undefined && run.state !== undefined)
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
          : run.state === undefined
            ? {}
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
      Date.now() - answeredAt >= UNANSWERED_LIMIT_MS
        ? `the runner sandbox stopped answering for ${UNANSWERED_LIMIT_MS / 1000} s`
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
    if (state === "running" && Date.now() >= syncAt) {
      syncAt = Date.now() + SYNC_EVERY_MS;
      // Best effort: what this misses, the copy at the end takes.
      await copySettledEvidence(runner, paths, runId, copied).catch(() => undefined);
    }
  }
}

/**
 * One read of the runner's run, waiting there for a change. The first signal ends the wait here,
 * and the read left in the runner ends on its own. Undefined when the runner did not answer.
 */
async function readRun(
  runner: Runner,
  runId: string,
  seen: { state: string | undefined; alive: boolean },
  signals: Signals,
): Promise<RemoteRunState | "signal" | undefined> {
  const read = waitForRemoteRun(runner, runId, seen, WAIT_MS).catch(() => undefined);
  if (signals.requested !== undefined) return await read;
  return await Promise.race([read, signals.received.then(() => "signal" as const)]);
}

/**
 * Copy every file of the runner's run directory into this machine's run directory, each checked
 * against the digest the runner listed. The sandbox journal keeps this machine's lines (the
 * runner's own receipt) and adds the runner's (its participants'). A file copied while the run went
 * on that the runner no longer has, a frame's PNG replaced by its WebP, is removed here too.
 */
async function copyRunBack(
  runner: Runner,
  paths: PreparedRunArtifactPaths,
  runId: string,
  copiedWhileRunning: ReadonlyMap<string, number>,
): Promise<{ files: number; alreadyHere: number }> {
  const files = await listRemoteRun(runner, runId);
  let alreadyHere = 0;
  const wanted: RemoteFile[] = [];
  for (const file of files) {
    if (file.path === "owner-key") continue;
    // Already here with the same bytes, copied while the run went on or by an earlier attempt.
    if (
      file.path !== SANDBOX_RECEIPTS_ARTIFACT &&
      (await localDigest(paths, file.path)) === file.sha256
    )
      alreadyHere += 1;
    else wanted.push(file);
  }
  await readRemoteFiles(runner, runId, wanted, async (file, bytes) => {
    if (file.path !== SANDBOX_RECEIPTS_ARTIFACT)
      return await writeContainedOutputFile(paths, file.path, bytes);
    const local = await readContainedRegularFile(paths, file.path, 16 * 1024 * 1024);
    const mine = local.status === "read" ? Buffer.from(local.bytes).toString("utf8") : "";
    await writeContainedOutputFile(
      paths,
      file.path,
      joinJournals(mine, Buffer.from(bytes).toString("utf8")),
      "utf8",
    );
  });
  const listed = new Set(files.map((file) => file.path));
  for (const file of copiedWhileRunning.keys())
    if (!listed.has(file)) await removeContainedOutputFile(paths, file);
  await pointLatestRunAt(paths, runId);
  return { files: files.length, alreadyHere };
}

/**
 * Copy the run's screenshots and recordings that have settled and are not here yet, while the run
 * goes on, so the copy at its end is only what is left.
 */
async function copySettledEvidence(
  runner: Runner,
  paths: PreparedRunArtifactPaths,
  runId: string,
  copied: Map<string, number>,
): Promise<void> {
  for (const file of await listSettledEvidence(runner, runId, SETTLED_SECONDS)) {
    if (copied.get(file.path) === file.size) continue;
    await writeContainedOutputFile(
      paths,
      file.path,
      await readRemoteBytes(runner, runId, file.path),
    );
    copied.set(file.path, file.size);
  }
}

async function localDigest(
  paths: PreparedRunArtifactPaths,
  file: string,
): Promise<string | undefined> {
  const read = await readContainedRegularFile(paths, file, LARGEST_FILE_BYTES);
  return read.status === "read" ? createHash("sha256").update(read.bytes).digest("hex") : undefined;
}

/**
 * Two sandbox journals as one: every line of each, in order, once. A copy that runs again adds
 * nothing it already added.
 */
export function joinJournals(...journals: string[]): string {
  const lines = [
    ...new Set(
      journals.flatMap((journal) => journal.split("\n")).filter((line) => line.trim() !== ""),
    ),
  ];
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * Reclaim every sandbox of the run, by receipt and by its tags, and report a reclaim that did not
 * come back clean as an error and a failing exit code.
 */
async function endRun(
  launch: RemoteContext,
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
  record: { runId: string; provider: string; route: string; deadline: string },
): Promise<void> {
  await writeContainedOutputFile(
    paths,
    "remote.json",
    `${JSON.stringify({ schema: "humanish.remote-run.v1", ...record }, null, 2)}\n`,
    "utf8",
  );
}

export interface Signals {
  readonly requested: "stop" | "detach" | undefined;
  /**
   * The exit code for the first signal received: 130 for SIGINT and 143 for SIGTERM, as a local
   * run gives, and 129 for a closed terminal.
   */
  readonly exitCode: number;
  /** Settles when the first signal arrives, so a long step can stop waiting for itself. */
  readonly received: Promise<void>;
  dispose(): void;
}

/**
 * Ctrl-C and SIGTERM stop the run, as they stop a local one. A closed terminal (SIGHUP) leaves it
 * running; the runner ends it at its deadline.
 */
export function watchSignals(): Signals {
  let requested: "stop" | "detach" | undefined;
  let exitCode = 130;
  let signalled!: () => void;
  const received = new Promise<void>((resolve) => {
    signalled = resolve;
  });
  const first = (kind: "stop" | "detach", code: number) => {
    if (requested !== undefined) return;
    requested = kind;
    exitCode = code;
    signalled();
  };
  const interrupt = () => first("stop", 130);
  const terminate = () => first("stop", 143);
  const detach = () => first("detach", 129);
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
    received,
    dispose() {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      process.off("SIGHUP", detach);
    },
  };
}

/** What the runner gets from this machine's env, and how each key reaches it. */
export interface RunnerKeys {
  /** The run command's env: each forwarded name, with a placeholder for each key E2B holds. */
  env: Record<string, string>;
  /**
   * The runner's network: its URLs answer only with its traffic token, and on E2B its header
   * transforms carry the held keys. It holds key values: never log or persist it.
   */
  network: E2BNetworkOptions;
  /** Names whose values stay in E2B's egress proxy; the runner sees a placeholder. */
  held: string[];
  /** Names whose values enter the runner as environment variables. */
  sent: string[];
}

/**
 * How each sandbox provider's runner receives the keys forwarded to it. E2B holds each key that
 * travels as a header to a fixed host in an E2B header transform: the run gets a placeholder, and
 * the system CA bundle that holds E2B's proxy CA, which Node does not read by default. Modal has no
 * such transform, so a Modal runner receives every key as an environment variable. The first key
 * set of the plan's `plainKeys` reaches the run as its value on E2B too. A new sandbox provider
 * adds its entry here.
 */
const KEY_PLACEMENT: Readonly<
  Record<
    SandboxProviderId,
    (
      forwarded: Record<string, string>,
      routing: E2BNetworkOptions,
      plainKeys: readonly string[],
    ) => RunnerKeys
  >
> = {
  e2b: (forwarded, routing, plainKeys) => {
    const plain = Object.fromEntries(
      Object.entries(forwarded).filter(([name]) => plainKeys.includes(name)),
    );
    const holdable = Object.fromEntries(
      Object.entries(forwarded).filter(([name]) => !plainKeys.includes(name)),
    );
    const held = holdKeysInEgress(holdable, { domain: forwarded.E2B_DOMAIN, existing: routing });
    const env = { ...held.env, ...plain };
    return {
      env: held.held.length === 0 ? env : { ...env, NODE_EXTRA_CA_CERTS: E2B_SYSTEM_CA_BUNDLE },
      network: held.network,
      held: held.held,
      sent: Object.keys(forwarded)
        .filter((name) => !held.held.includes(name))
        .sort(),
    };
  },
  modal: (forwarded, routing) => ({
    env: forwarded,
    network: routing,
    held: [],
    sent: Object.keys(forwarded).sort(),
  }),
};

/**
 * The keys the runner's run receives: each of the plan's names that is set here, and of names the
 * run reads only the first of, only the first one set, placed as the runner's provider places
 * them (KEY_PLACEMENT).
 */
export function runnerKeys(
  remote: Pick<RemotePlan, "provider" | "envNames" | "alternatives" | "plainKeys">,
  env: Readonly<Record<string, string | undefined>>,
): RunnerKeys {
  const set = (name: string) => (env[name]?.trim() ?? "") !== "";
  const unread = new Set(remote.alternatives.flatMap((names) => names.filter(set).slice(1)));
  const forwarded: Record<string, string> = Object.fromEntries(
    remote.envNames.flatMap((name) => (set(name) && !unread.has(name) ? [[name, env[name]!]] : [])),
  );
  const plain = remote.plainKeys.find(set);
  return KEY_PLACEMENT[remote.provider](
    forwarded,
    { allowPublicTraffic: false },
    plain === undefined ? [] : [plain],
  );
}

/** Whether this humanish runs from a built package, which a runner can install. */
export function runsFromPackage(): boolean {
  const here = fileURLToPath(import.meta.url);
  const root = path.resolve(path.dirname(here), "..", "..");
  return path.relative(root, here).split(path.sep)[0] === "dist";
}

/**
 * This machine's humanish as an npm tarball, so the runner runs exactly the same code. A run from
 * source has no built package to pack.
 */
function packThisHumanish(): Promise<Uint8Array> {
  const here = fileURLToPath(import.meta.url);
  const root = path.resolve(path.dirname(here), "..", "..");
  // Thrown here, not from the promise, so it refuses the run before any sandbox exists.
  if (!runsFromPackage())
    throw new Error(
      "A remote run installs this humanish in the runner, and a run from source has no built package. Run `pnpm build`, then `node dist/cli.js`, or use an installed humanish.",
    );
  return pack(root);
}

async function pack(root: string): Promise<Uint8Array> {
  const dir = await mkdtemp(path.join(tmpdir(), "humanish-pack-"));
  try {
    const { stdout } = await promisify(execFile)(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", dir, root],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    const [packed] = JSON.parse(stdout) as [{ filename: string }];
    return await readFile(path.join(dir, packed.filename));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The npm specs this humanish's package.json depends on, as name@range. */
async function ownDependencies(): Promise<string[]> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return Object.entries(manifest.dependencies ?? {}).map(([name, range]) => `${name}@${range}`);
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
