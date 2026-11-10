// Coming back to a remote run whose launcher let it go (a closed terminal): find its runner from
// the run directory here, serve its live Observer again and follow it to the end, as the launcher
// would have.
import { readContainedRegularFile, type PreparedOutputRoot } from "../run/contained-output.js";
import { bindExistingRunArtifactPaths, type PreparedRunArtifactPaths } from "../run/paths.js";
import {
  isSandboxProviderId,
  parseSandboxReceipts,
  SANDBOX_RECEIPTS_ARTIFACT,
  type SandboxProviderId,
} from "../run/sandbox-receipts.js";
import { loadE2BBaseModule } from "../substrates/e2b/base-module.js";
import { e2bConnection } from "../substrates/e2b/connection.js";
import { isSandboxNotFoundError } from "../substrates/e2b/sdk.js";
import { loadModalShellModule } from "../substrates/modal/sandbox.js";
import { followRemoteRun, watchSignals, type RemoteContext, type RemoteOutcome } from "./launch.js";
import { giveUpCopy } from "./copy-back.js";
import { serveObserverProxy } from "./observer-proxy.js";
import { RUNNER_OBSERVER_PORT, runnerOf } from "./runner.js";

/** A run directory here whose run executes in a runner and has not been copied back. */
export interface RemoteRunHere {
  paths: PreparedRunArtifactPaths;
  runId: string;
  provider: SandboxProviderId;
  runnerId: string;
  /** Whether its run serves a live Observer; a record from before `route` was written does. */
  liveObserver: boolean;
}

/**
 * The remote run `runId` names, when its directory here has a remote.json and its copy has not
 * finished: run.json can be here already, since a run's small files arrive before its video. A
 * record written before copyPending existed has only run.json to go by. Undefined for any other
 * run, which the Observer serves from its files as before.
 */
export async function remoteRunHere(
  cwd: string,
  runId: string,
): Promise<RemoteRunHere | undefined> {
  let paths: PreparedRunArtifactPaths;
  try {
    paths = await bindExistingRunArtifactPaths(cwd, runId);
  } catch {
    return undefined;
  }
  const record = await readText(paths, "remote.json");
  if (record === undefined) return undefined;
  const { provider, route, copyPending } = JSON.parse(record) as {
    provider?: unknown;
    route?: unknown;
    copyPending?: unknown;
  };
  const pending = copyPending === true;
  if (!pending && (await readText(paths, "run.json")) !== undefined) return undefined;
  if (typeof provider !== "string" || !isSandboxProviderId(provider)) return undefined;
  const journal = (await readText(paths, SANDBOX_RECEIPTS_ARTIFACT)) ?? "";
  // The runner is the only sandbox this machine creates, so its receipt comes first. A copy that
  // stopped partway has added the participants' receipts after it.
  const [runner, ...others] = parseSandboxReceipts(journal);
  if (runner === undefined || (!pending && others.length > 0)) return undefined;
  return {
    paths,
    runId,
    provider,
    runnerId: runner.sandboxId,
    liveObserver: route !== "terminal",
  };
}

async function readText(root: PreparedOutputRoot, file: string): Promise<string | undefined> {
  const read = await readContainedRegularFile(root, file, 16 * 1024 * 1024);
  return read.status === "read" ? Buffer.from(read.bytes).toString("utf8") : undefined;
}

/**
 * Reconnect to `run`'s runner, serve its live Observer on 127.0.0.1:`port` when it has one, and
 * follow it to the end.
 */
export async function reattachRemoteRun(
  context: RemoteContext,
  run: RemoteRunHere,
  port: number,
): Promise<RemoteOutcome> {
  const module =
    run.provider === "modal" ? await loadModalShellModule(context.env) : await loadE2BBaseModule();
  let sandbox;
  try {
    // A Modal module takes its connection from context.env and ignores this one.
    sandbox = await module.Sandbox.connect!(run.runnerId, e2bConnection(context.env));
  } catch (error) {
    if (!isSandboxNotFoundError(error)) throw error;
    const lost = await giveUpCopy(run.paths);
    return {
      runId: run.runId,
      exitCode: 2,
      error: `its runner sandbox is gone, so what had not been copied back is lost${lost.length === 0 ? "" : ` (${lost.join(", ")})`}. Anything already copied is in its run directory, and humanish observe --run ${run.runId} opens a run whose findings arrived. Stop anything it left with humanish reclaim --run ${run.runId}`,
    };
  }
  const runner = runnerOf(sandbox);
  const signals = watchSignals();
  const proxy = run.liveObserver
    ? await serveObserverProxy(await runner.sandbox.portAccess!(RUNNER_OBSERVER_PORT), port)
    : undefined;
  try {
    context.say(`Reconnected to run ${run.runId} on its runner.`);
    return await followRemoteRun({
      launch: context,
      runner,
      paths: run.paths,
      runId: run.runId,
      signals,
      proxyUrl: proxy?.url,
    });
  } finally {
    signals.dispose();
    await proxy?.close();
  }
}
