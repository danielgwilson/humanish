import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { setUserKey } from "../../keys/key-resolution.js";
import { saveCommsConnection } from "../../comms/connections.js";
import { readCommsSetup } from "../../comms/setup.js";
import {
  checkCommsConnection,
  configureCommsLab,
  type CommsCheckResult,
} from "../../comms/setup.js";
import { inspectCommsRecovery, recoverCommsReceiving } from "../../comms/receiving-recovery.js";
import { resolveReceivingConnection } from "../../comms/receiving-runtime.js";
import { promptSecret } from "../secret-prompt.js";
import { runInit } from "../../lab/init.js";
import { listLabManifests } from "../../lab/discover.js";
import { reclaimRunSandboxes } from "../../run/reclaim.js";
import { RunIndexCache, readRunIndex } from "../../run/run-index.js";
import { readLabSummary } from "../../lab/summary.js";
import { readProjectState } from "../../tui/project.js";
import { createTuiObserverSession, stopRun, TUI_ACTION_SCHEMA } from "../../tui/actions.js";
import { readRunDetail } from "../../run/detail.js";
import { launchRun, readLaunchLogTail } from "../../tui/launch.js";
import {
  TUI_MIN_NODE_MAJOR,
  nodeSupportsTui,
  TUI_BUNDLE_URL,
  type TuiModule,
} from "../../tui/contract.js";
import { detectAgentSession } from "../../actors/agent-session.js";
import {
  applyEnvFileOption,
  CLI_VERSION,
  type CliIo,
  JSON_OPTION_DESCRIPTION,
  markInvocationEnvelopeWritten,
  wantsJson,
} from "../io.js";

/**
 * The pieces of the outside world the `tui` command touches. Injectable for the same reason
 * `keyDiscovery` is: the refusals ARE the behavior worth testing, and a test cannot make a real
 * TTY, an old Node, or a missing bundle appear.
 */
export interface TuiRuntime {
  checkComms: typeof checkCommsConnection;
  promptSecret: typeof promptSecret;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  nodeVersion: string;
  /** Injected so a test can pose as an agent session without touching the real process env. */
  env: NodeJS.ProcessEnv;
  /** Resolves the bundle, or null when it is not present. */
  loadTui(bundle: URL): Promise<TuiModule | null>;
}

export const defaultTuiRuntime: TuiRuntime = {
  checkComms: checkCommsConnection,
  promptSecret,
  stdin: process.stdin,
  stdout: process.stdout,
  env: process.env,
  nodeVersion: process.version,
  loadTui: async (bundle) => {
    if (!existsSync(bundle)) return null;
    return (await import(bundle.href)) as TuiModule;
  },
};

const TUI_RESULT_SCHEMA = "humanish.tui-result.v1";

interface TuiRefusal {
  schema: typeof TUI_RESULT_SCHEMA;
  ok: false;
  error: {
    code:
      | "HUMANISH_TUI_REQUIRES_TTY"
      | "HUMANISH_TUI_AGENT_SESSION"
      | "HUMANISH_TUI_UNSUPPORTED_NODE"
      | "HUMANISH_TUI_BUNDLE_MISSING";
    message: string;
  };
}

function refuseTui(command: Command, io: CliIo, refusal: TuiRefusal): void {
  if (wantsJson(command)) {
    io.writeOut(`${JSON.stringify(refusal, null, 2)}\n`);
  } else {
    io.writeErr(`${refusal.error.message}\n`);
  }
  markInvocationEnvelopeWritten(command);
  io.setExitCode(2);
}

/**
 * The stakeholder surface (#455). Every other command is written so an agent can drive it; this one
 * is the opposite — it takes the screen and waits for a person.
 *
 * That inversion is why it refuses rather than degrades. An agent that runs `humanish tui` with a
 * piped stdout has asked for something that cannot exist, and the useful answer is a structured
 * error naming the command that WOULD have answered the question. A TUI that quietly rendered
 * frames into a pipe would poison a transcript with escape codes and look like a hang.
 */
export function registerTuiCommand(
  parent: Command,
  io: CliIo,
  runtime: TuiRuntime = defaultTuiRuntime,
): void {
  parent
    .command("tui")
    .description("Open the interactive terminal surface for browsing labs and runs (humans only).")
    .summary(
      "Human terminal for labs and runs; refuses detected agent sessions and non-TTY input/output. Agents: humanish lab list --json, humanish lab inspect <lab> --json, humanish runs --json.",
    )
    .option("--cwd <path>", "Target project directory.", ".")
    .option(
      "--env-file <path>",
      "Load a local env file for this terminal session and its runs without printing values.",
    )
    .option("--force", "Open it anyway in a session that looks like an agent's.")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action((options, command) => handleTui(io, runtime, options, command));
}

async function handleTui(
  io: CliIo,
  runtime: TuiRuntime,
  options: { cwd: string; envFile?: string; force?: boolean; json?: boolean },
  command: Command,
): Promise<void> {
  const { stdin, stdout } = runtime;
  // Production uses process.env, including SDKs used by existing cleanup actions. Tests inject
  // an isolated host context. Values stay behind the capability closures, never in view data.
  const sessionEnv = runtime.env;

  // An agent runner, even with a real terminal. `codex exec` allocates a PTY for the commands
  // it runs, so the TTY check below passes and the surface used to open: a study watched an
  // agent navigate the labs list and start a run it did not mean to start
  // (labs/handed-a-human-surface.yaml). A TTY says a terminal exists, not that anyone is
  // reading it. `--force` is the escape for the person who really is at this keyboard —
  // capturing frames from inside an agent session is exactly that case.
  const agent = options.force === true ? undefined : detectAgentSession(runtime.env);
  if (agent !== undefined) {
    refuseTui(command, io, {
      schema: TUI_RESULT_SCHEMA,
      ok: false,
      error: {
        code: "HUMANISH_TUI_AGENT_SESSION",
        message:
          `humanish tui is a surface for a person, and ${agent.marker} says this session belongs to ${agent.runner}. ` +
          "It renders frames of escape codes into a transcript, and its keys can start runs. " +
          "`humanish runs --json` lists runs, `humanish lab list --json` lists the studies in this project, " +
          "and `humanish lab run <lab> --json` starts one. If you are a person at this keyboard, add --force.",
      },
    });
    return;
  }

  if (stdin.isTTY !== true || stdout.isTTY !== true) {
    refuseTui(command, io, {
      schema: TUI_RESULT_SCHEMA,
      ok: false,
      error: {
        code: "HUMANISH_TUI_REQUIRES_TTY",
        message:
          "humanish tui needs an interactive terminal. For scripted or agent use, `humanish runs --json` lists the same runs and `humanish lab run --json` starts one.",
      },
    });
    return;
  }

  if (!nodeSupportsTui(runtime.nodeVersion)) {
    refuseTui(command, io, {
      schema: TUI_RESULT_SCHEMA,
      ok: false,
      error: {
        code: "HUMANISH_TUI_UNSUPPORTED_NODE",
        message: `humanish tui needs Node ${TUI_MIN_NODE_MAJOR} or newer (this is ${runtime.nodeVersion}). Every other humanish command still works on this runtime.`,
      },
    });
    return;
  }

  // The Ink app ships as a pre-built bundle beside the compiled CLI and is loaded ONLY here, so
  // no agent-facing command pays its parse cost.
  const bundle = TUI_BUNDLE_URL;
  const runIndexCache = new RunIndexCache();
  const loaded = await runtime.loadTui(bundle);
  if (loaded === null) {
    refuseTui(command, io, {
      schema: TUI_RESULT_SCHEMA,
      ok: false,
      error: {
        code: "HUMANISH_TUI_BUNDLE_MISSING",
        message: `The terminal surface bundle is missing at ${bundle.pathname}. In a checkout, run \`pnpm build\`; in an install, this package is incomplete — please report it.`,
      },
    });
    return;
  }

  const discoveredKeys = new Set<string>();
  if (
    !(await applyEnvFileOption({
      command,
      cwd: options.cwd,
      envFile: options.envFile,
      io,
      env: sessionEnv,
      onDiscovered: (names) => names.forEach((name) => discoveredKeys.add(name)),
    }))
  )
    return;
  // Probe stored credentials afresh. Discovery fills must not become permanent env overrides
  // when a person replaces a stored key during this terminal session.
  const connectionEnv = (): NodeJS.ProcessEnv => {
    const env = { ...sessionEnv };
    for (const name of discoveredKeys) delete env[name];
    return env;
  };
  const observerSession = createTuiObserverSession(resolve(options.cwd));
  let exitCode = 0;
  let connectionNotice: string | undefined;
  let connectionCheck: CommsCheckResult | undefined;
  try {
    for (;;) {
      const outcome = await loaded.startTui({
        ...(connectionNotice === undefined
          ? {}
          : { initialScreen: "connections" as const, connectionNotice }),
        cwd: resolve(options.cwd),
        version: { cli: CLI_VERSION },
        capabilities: {
          comms: {
            read: async () => ({
              ...(await readCommsSetup(resolve(options.cwd), connectionEnv())),
              ...(connectionCheck ? { authentication: connectionCheck } : {}),
            }),
            save: () => saveCommsConnection(resolve(options.cwd)),
            check: async () => {
              connectionCheck = await runtime.checkComms({
                cwd: resolve(options.cwd),
                env: connectionEnv(),
                online: true,
              });
              return connectionCheck;
            },
            labs: async () =>
              (await listLabManifests(resolve(options.cwd))).labs.map((lab) => ({
                title: lab.title ?? lab.id,
                path: lab.path,
              })),
            configure: (lab, apply, planToken) =>
              configureCommsLab({
                cwd: resolve(options.cwd),
                lab,
                connection: "agentmail",
                apply,
                ...(planToken ? { planToken } : {}),
              }),
            recovery: () => inspectCommsRecovery({ cwd: resolve(options.cwd) }),
            recover: async (runId, connectionName) => {
              try {
                const { connection, adapter } = await resolveReceivingConnection(
                  resolve(options.cwd),
                  connectionName,
                  connectionEnv(),
                );
                return await recoverCommsReceiving({
                  cwd: resolve(options.cwd),
                  runId,
                  connectionName,
                  apiKeyEnv: connection.apiKeyEnv,
                  adapter,
                });
              } catch {
                return {
                  ok: false,
                  message: "Could not recover email resources. Check the connection and retry.",
                };
              }
            },
          },
          // One cache for the life of the surface: it refreshes on a cadence, and re-walking every
          // run tree each tick is the cost this index exists to avoid.
          readRunIndex: (target, readOptions) =>
            readRunIndex(target, { ...readOptions, cache: runIndexCache }),
          listLabs: listLabManifests,
          startRun: (launchOptions) => launchRun({ ...launchOptions, env: sessionEnv }),
          readLaunchLog: readLaunchLogTail,
          readRunDetail,
          readLabSummary: (target, lab, readOptions) =>
            readLabSummary(target, lab, { ...readOptions, env: sessionEnv }),
          readProjectState,
          openObserver: (target, observerPath) => observerSession.open(target, observerPath),
          reclaimRun: (target, runId) => reclaimRunSandboxes(target, runId),
          stopRun,
          initProject: async (target: string) => {
            const result = await runInit({ cwd: target, yes: true });
            return result.ok
              ? {
                  schema: TUI_ACTION_SCHEMA,
                  ok: true as const,
                  message: `set up humanish here — ${result.changes.filter((change) => change.action !== "skip").length} files written`,
                }
              : {
                  schema: TUI_ACTION_SCHEMA,
                  ok: false as const,
                  message: result.error?.message ?? "humanish init could not set this directory up",
                };
          },
        },
        stdin,
        stdout,
      });
      if (typeof outcome === "number") {
        exitCode = outcome;
        break;
      }
      if (outcome.action !== "agentmail-key") {
        exitCode = 1;
        break;
      }
      // startTui has unmounted: only the host reads the credential, then remounts the view.
      const value = await runtime.promptSecret("AgentMail API key", stdin, stdout);
      if (value === null) {
        connectionNotice = "Key entry cancelled. Nothing was changed.";
        continue;
      }
      try {
        setUserKey("AGENTMAIL_API_KEY", value, sessionEnv);
        // Refresh only a value filled implicitly by discovery; explicit env/file wins.
        if (discoveredKeys.has("AGENTMAIL_API_KEY")) delete sessionEnv.AGENTMAIL_API_KEY;
        const saved = await saveCommsConnection(resolve(options.cwd));
        connectionNotice = saved.ok
          ? "Key stored. Project connection saved."
          : `Key stored for your user. ${saved.message}`;
        stdout.write("Checking AgentMail authentication…\n");
        connectionCheck = await runtime.checkComms({
          cwd: resolve(options.cwd),
          env: connectionEnv(),
          online: true,
        });
        connectionNotice = saved.ok
          ? connectionCheck.authenticated === true
            ? "Key stored. Authentication passed."
            : connectionCheck.authenticated === false
              ? "Key stored. Authentication rejected; test it for details."
              : "Key stored. Authentication unknown; test it to retry."
          : `${connectionNotice} ${connectionCheck.message}`;
      } catch {
        connectionNotice =
          "Could not store the key. Use a single non-empty line and check key-store permissions.";
      }
    }
  } finally {
    await observerSession.close();
  }
  // The surface owned the screen; it has already told the operator whatever there was to say.
  markInvocationEnvelopeWritten(command);
  io.setExitCode(exitCode);
}
