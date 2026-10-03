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
  type TuiCapabilities,
  type TuiModule,
} from "../../tui/contract.js";
import { detectAgentSession } from "../../actors/agent-session.js";
import {
  applyEnvFileOption,
  CLI_VERSION,
  type CliIo,
  CWD_OPTION_DESCRIPTION,
  ENV_FILE_OPTION_DESCRIPTION,
  JSON_OPTION_DESCRIPTION,
  markInvocationEnvelopeWritten,
  wantsJson,
} from "../io.js";

/**
 * The pieces of the outside world the `tui` command touches. Injectable for the same reason
 * `keyDiscovery` is: the refusals are the behavior worth testing, and a test cannot make a real
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
 * The stakeholder surface. Every other command is written so an agent can drive it; this one
 * is the opposite: it takes the screen and waits for a person.
 *
 * That inversion is why it refuses rather than degrades. An agent that runs `humanish tui` with a
 * piped stdout has asked for something that cannot exist, and the useful answer is a structured
 * error naming the command that would have answered the question. A TUI that quietly rendered
 * frames into a pipe would poison a transcript with escape codes and look like a hang.
 */
export function registerTuiCommand(
  parent: Command,
  io: CliIo,
  runtime: TuiRuntime = defaultTuiRuntime,
): void {
  parent
    .command("tui")
    .description(
      "Browse studies and runs in an interactive terminal UI. It refuses detected agent sessions and non-TTY input or output; agents use humanish study list --json, humanish study show <study> --json and humanish runs --json.",
    )
    .summary("Browse studies and runs in a terminal UI for people.")
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .option("--env-file <path>", ENV_FILE_OPTION_DESCRIPTION)
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
  const refusal = checkTuiSession(runtime, options.force === true);
  if (refusal !== undefined) {
    refuseTui(command, io, refusal);
    return;
  }

  // The Ink app ships as a pre-built bundle beside the compiled CLI and is loaded only here, so
  // no agent-facing command pays its parse cost.
  const bundle = TUI_BUNDLE_URL;
  const loaded = await runtime.loadTui(bundle);
  if (loaded === null) {
    refuseTui(command, io, {
      schema: TUI_RESULT_SCHEMA,
      ok: false,
      error: {
        code: "HUMANISH_TUI_BUNDLE_MISSING",
        message: `The terminal surface bundle is missing at ${bundle.pathname}. In a checkout, run \`pnpm build\`; an installed package always ships it, so please report this as a bug.`,
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
      env: runtime.env,
      onDiscovered: (names) => names.forEach((name) => discoveredKeys.add(name)),
    }))
  )
    return;
  const exitCode = await runTuiSession(loaded, runtime, resolve(options.cwd), discoveredKeys);
  // The surface owned the screen; it has already told the operator whatever there was to say.
  markInvocationEnvelopeWritten(command);
  io.setExitCode(exitCode);
}

/** The refusal for a session the surface cannot serve, or undefined when it may open. */
function checkTuiSession(runtime: TuiRuntime, force: boolean): TuiRefusal | undefined {
  // An agent runner, even with a real terminal. `codex exec` allocates a PTY for the commands it
  // runs, so the TTY check below passes for an agent too, and an agent in the surface can start a
  // run it did not mean to start (humanish/studies/handed-a-human-surface.yaml records one). A TTY
  // says a terminal exists, not that anyone is reading it. `--force` is the escape for the person
  // who really is at this keyboard, and capturing frames from inside an agent session is exactly
  // that case.
  const agent = force ? undefined : detectAgentSession(runtime.env);
  if (agent !== undefined) {
    return {
      schema: TUI_RESULT_SCHEMA,
      ok: false,
      error: {
        code: "HUMANISH_TUI_AGENT_SESSION",
        message:
          `humanish tui is a surface for a person, and ${agent.marker} says this session belongs to ${agent.runner}. ` +
          "It renders frames of escape codes into a transcript, and its keys can start runs. " +
          "`humanish runs --json` lists runs, `humanish study list --json` lists the studies in this project, " +
          "and `humanish run <study> --json` starts one. If you are a person at this keyboard, add --force.",
      },
    };
  }

  if (runtime.stdin.isTTY !== true || runtime.stdout.isTTY !== true) {
    return {
      schema: TUI_RESULT_SCHEMA,
      ok: false,
      error: {
        code: "HUMANISH_TUI_REQUIRES_TTY",
        message:
          "humanish tui needs an interactive terminal. For scripted or agent use, `humanish runs --json` lists the same runs and `humanish run <lab> --json` starts one.",
      },
    };
  }

  if (!nodeSupportsTui(runtime.nodeVersion)) {
    return {
      schema: TUI_RESULT_SCHEMA,
      ok: false,
      error: {
        code: "HUMANISH_TUI_UNSUPPORTED_NODE",
        message: `humanish tui needs Node ${TUI_MIN_NODE_MAJOR} or newer (this is ${runtime.nodeVersion}). Every other humanish command still works on this runtime.`,
      },
    };
  }
  return undefined;
}

/** State the surface and the host share across remounts. */
interface TuiSession {
  cwd: string;
  runtime: TuiRuntime;
  /** Production uses process.env, including SDKs used by existing cleanup actions. */
  sessionEnv: NodeJS.ProcessEnv;
  /** Keys that env discovery filled in, which a stored key must be able to replace. */
  discoveredKeys: Set<string>;
  runIndexCache: RunIndexCache;
  observerSession: ReturnType<typeof createTuiObserverSession>;
  connectionCheck?: CommsCheckResult;
}

/**
 * Mounts the surface until it exits, remounting it after each credential handoff. Resolves to the
 * surface's exit code.
 */
async function runTuiSession(
  loaded: TuiModule,
  runtime: TuiRuntime,
  cwd: string,
  discoveredKeys: Set<string>,
): Promise<number> {
  // Tests inject an isolated host context. Values stay behind the capability closures, never in
  // view data.
  const session: TuiSession = {
    cwd,
    runtime,
    sessionEnv: runtime.env,
    discoveredKeys,
    runIndexCache: new RunIndexCache(),
    observerSession: createTuiObserverSession(cwd),
  };
  let connectionNotice: string | undefined;
  try {
    for (;;) {
      const outcome = await loaded.startTui({
        ...(connectionNotice === undefined
          ? {}
          : { initialScreen: "connections" as const, connectionNotice }),
        cwd,
        version: { cli: CLI_VERSION },
        capabilities: tuiCapabilities(session),
        stdin: runtime.stdin,
        stdout: runtime.stdout,
      });
      if (typeof outcome === "number") return outcome;
      if (outcome.action !== "agentmail-key") return 1;
      connectionNotice = await storeAgentmailKey(session);
    }
  } finally {
    await session.observerSession.close();
  }
}

/**
 * The env for connection checks. Stored credentials are probed afresh: discovery fills must not
 * become permanent env overrides when a person replaces a stored key during this terminal session.
 */
function connectionEnv(session: TuiSession): NodeJS.ProcessEnv {
  const env = { ...session.sessionEnv };
  for (const name of session.discoveredKeys) delete env[name];
  return env;
}

function tuiCapabilities(session: TuiSession): TuiCapabilities {
  const { cwd, runtime, sessionEnv, runIndexCache, observerSession } = session;
  return {
    comms: {
      read: async () => ({
        ...(await readCommsSetup(cwd, connectionEnv(session))),
        ...(session.connectionCheck ? { authentication: session.connectionCheck } : {}),
      }),
      save: () => saveCommsConnection(cwd),
      check: async () => {
        session.connectionCheck = await runtime.checkComms({
          cwd,
          env: connectionEnv(session),
          online: true,
        });
        return session.connectionCheck;
      },
      labs: async () =>
        (await listLabManifests(cwd)).studies.map((lab) => ({
          title: lab.title ?? lab.id,
          path: lab.path,
        })),
      configure: (lab, apply, planToken) =>
        configureCommsLab({
          cwd,
          lab,
          connection: "agentmail",
          apply,
          ...(planToken ? { planToken } : {}),
        }),
      recovery: () => inspectCommsRecovery({ cwd }),
      recover: async (runId, connectionName) => {
        try {
          const { connection, adapter } = await resolveReceivingConnection(
            cwd,
            connectionName,
            connectionEnv(session),
          );
          return await recoverCommsReceiving({
            cwd,
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
            message: `set up humanish here: ${result.changes.filter((change) => change.action !== "skip").length} files written`,
          }
        : {
            schema: TUI_ACTION_SCHEMA,
            ok: false as const,
            message: result.error?.message ?? "humanish init could not set this directory up",
          };
    },
  };
}

/**
 * Prompts for the AgentMail key after the surface has unmounted, stores it and checks it. Resolves
 * to the notice the remounted connections screen shows.
 */
async function storeAgentmailKey(session: TuiSession): Promise<string> {
  const { cwd, runtime, sessionEnv } = session;
  // startTui has unmounted: only the host reads the credential, then remounts the view.
  const value = await runtime.promptSecret("AgentMail API key", runtime.stdin, runtime.stdout);
  if (value === null) return "Key entry cancelled. Nothing was changed.";
  try {
    setUserKey("AGENTMAIL_API_KEY", value, sessionEnv);
    // Refresh only a value filled implicitly by discovery; explicit env/file wins.
    if (session.discoveredKeys.has("AGENTMAIL_API_KEY")) delete sessionEnv.AGENTMAIL_API_KEY;
    const saved = await saveCommsConnection(cwd);
    const storedNotice = saved.ok
      ? "Key stored. Project connection saved."
      : `Key stored for your user. ${saved.message}`;
    runtime.stdout.write("Checking AgentMail authentication…\n");
    const check = await runtime.checkComms({ cwd, env: connectionEnv(session), online: true });
    session.connectionCheck = check;
    return saved.ok
      ? check.authenticated === true
        ? "Key stored. Authentication passed."
        : check.authenticated === false
          ? "Key stored. Authentication rejected; test it for details."
          : "Key stored. Authentication unknown; test it to retry."
      : `${storedNotice} ${check.message}`;
  } catch {
    return "Could not store the key. Use a single non-empty line and check key-store permissions.";
  }
}
