// The restricted app-server launch: the one-time private home, version check and spawn, then the
// handshake (initialize, config, account, thread, MCP status). Each admit* check reads one
// handshake reply and the settings it depends on, and returns the admitted value or the refusal;
// none of them touches the session. launchAdmittedAppServer sends the requests in order, stops on
// the first refusal, and records each piece of state as soon as it exists so the session's
// teardown (restricted-session.ts) cleans up a launch that fails partway.

import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { CuaProviderFailurePhase } from "../computer-use/provider-error.js";
import type { ReasoningEffort } from "../reasoning-effort.js";
import {
  checkVersion,
  childEnvironment,
  generateProtocolSchema,
  resolveExecutable,
} from "./restricted-executable.js";
import { checkProtocol, loadProtocolSchema } from "./protocol-compat.js";
import { protocolContract, type ProtocolContractHost } from "./protocol-contract.js";
import {
  admitsRestrictedCodexConfig,
  admitsRestrictedCodexThread,
  codexRecord,
  restrictedCodexConfig,
  type RestrictedCodexAnalysisErrorCode,
  type RestrictedCodexConfigMode,
  type RestrictedCodexRequest,
} from "./restricted-policy.js";
import {
  RestrictedCodexDeadline,
  RestrictedCodexStop,
  RestrictedCodexTransport,
  ownCodexProcess,
  type RestrictedCodexSpawn,
} from "./restricted-transport.js";

/** The host options a launch reads; RestrictedCodexSessionOptions carries them. */
interface LaunchOptions {
  executable?: string;
  authHome?: string;
  tempRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  cliVersion?: string;
}

/** What a launch reads and the session never changes. */
export interface LaunchSettings {
  readonly options: LaunchOptions;
  readonly platform: NodeJS.Platform;
  readonly sourceEnv: NodeJS.ProcessEnv;
  readonly participant: { readonly tool: ThreadTool } | undefined;
  readonly operatorAuth: boolean;
  readonly reasoningEffort: ReasoningEffort;
  readonly spawnFn: RestrictedCodexSpawn;
  /** Launch admission: codex-admission.ts, or the qualifier's exact list (restricted-session.ts). */
  readonly admits: (version: string) => boolean;
}

/** What a launch records on the session, each piece as soon as it exists. */
export interface LaunchState {
  /** The private task directory (teardown removes it). */
  work: string | undefined;
  /** The private home's link to the host auth.json (teardown unlinks it). */
  authLink: string | undefined;
  /** The app-server (each request and teardown use it). */
  transport: RestrictedCodexTransport | undefined;
  /** The thread, its cwd and scratch directory (each request uses them). */
  threadId: string | undefined;
  cwd: string;
  scratch: string;
  /** The model and instructions the thread started with (each request and its admission). */
  identity: { requestedModel: string | undefined; model: string; instructions: string } | undefined;
  /** What the launch admitted (the session's getters). */
  resolvedModel: string | undefined;
  authentication: "chatgpt-account" | "api-key" | undefined;
  cliVersion: string | undefined;
  /** Notification methods this humanish does not know that carried no item, by count. */
  unknownNotifications: Map<string, number>;
  /** How the release's schema differs from the fields humanish reads; set when that refuses. */
  protocolIncompatibilities: string[] | undefined;
  /** Schema values beyond the baseline, recorded at launch. */
  protocolAdditions: string[] | undefined;
}

/** An admitted value, or the refusal a launch stops with. */
export type Admission<T> =
  | { readonly value: T }
  | { readonly refusal: RestrictedCodexAnalysisErrorCode };

/** The admitted value; a refusal stops the launch. */
export function admitted<T>(admission: Admission<T>): T {
  if ("refusal" in admission) throw new RestrictedCodexStop(admission.refusal);
  return admission.value;
}

/** `-c key=value` arguments for an operator-auth launch, which keeps the operator's config file. */
export function configArguments(overrides: Record<string, unknown>): string[] {
  return Object.entries(overrides).flatMap(([key, value]) => [
    "-c",
    `${key}=${JSON.stringify(value)}`,
  ]);
}

/** initialize: the admitted release, this platform, and (isolated auth) the private home. */
export function admitInitialize(
  reply: Record<string, unknown>,
  expected: {
    cliVersion: string;
    home: string;
    operatorAuth: boolean;
    platform: NodeJS.Platform;
  },
): Admission<void> {
  if (
    typeof reply.userAgent !== "string" ||
    !reply.userAgent.includes(`/${expected.cliVersion} `) ||
    (!expected.operatorAuth && reply.codexHome !== expected.home) ||
    reply.platformOs !== (expected.platform === "darwin" ? "macos" : "linux") ||
    reply.platformFamily !== "unix"
  )
    return { refusal: "codex_unsupported_version" };
  return { value: undefined };
}

/** config/read: the restricted configuration, and the model it selects, if any. */
export function admitEffectiveConfig(
  reply: Record<string, unknown>,
  configPath: string,
  requestedModel: string | undefined,
  mode: RestrictedCodexConfigMode,
): Admission<string | undefined> {
  if (!admitsRestrictedCodexConfig(reply, configPath, requestedModel, mode))
    return { refusal: "codex_unsafe_configuration" };
  const configuredModel = codexRecord(reply.config).model;
  return { value: typeof configuredModel === "string" ? configuredModel : undefined };
}

/** account/read: a ChatGPT account (or, with operator auth, an API key) that requires auth. */
export function admitAccount(
  reply: Record<string, unknown>,
  operatorAuth: boolean,
): Admission<"chatgpt-account" | "api-key"> {
  if (reply.account === null) return { refusal: "codex_login_required" };
  const accountType = codexRecord(reply.account).type;
  if (
    (!operatorAuth && accountType !== "chatgpt") ||
    (operatorAuth && !["chatgpt", "apiKey"].includes(String(accountType))) ||
    reply.requiresOpenaiAuth !== true
  )
    return { refusal: "codex_unsupported_auth" };
  return { value: accountType === "apiKey" ? "api-key" : "chatgpt-account" };
}

/**
 * The thread's config: the restricted overrides, with every inherited MCP server disabled. Codex
 * splits request overrides literally on dots, so a server name outside TOML bare-key characters
 * could not be targeted, and more than 100 servers is refused.
 */
export function threadConfigFor(
  effectiveConfig: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Admission<Record<string, unknown>> {
  const mcpNames = Object.keys(codexRecord(codexRecord(effectiveConfig.config).mcp_servers));
  if (mcpNames.length > 100 || mcpNames.some((name) => !/^[A-Za-z0-9_-]{1,200}$/.test(name)))
    return { refusal: "codex_unsafe_configuration" };
  const threadConfig = { ...overrides };
  for (const name of mcpNames) threadConfig[`mcp_servers.${name}.enabled`] = false;
  return { value: threadConfig };
}

/** The participant's one dynamic tool, as thread/start declares it. */
export interface ThreadTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * thread/start: an ephemeral, read-only thread with no environments and at most one tool. The
 * participant's tool is read field by field, then the request's instructions, in the order the
 * session always read them.
 */
export function threadStartParams(args: {
  cwd: string;
  model: string | undefined;
  participant: { readonly tool: ThreadTool } | undefined;
  request: { readonly instructions: string };
  config: Record<string, unknown>;
}): Record<string, unknown> {
  const participant = args.participant;
  return {
    cwd: args.cwd,
    ephemeral: true,
    experimentalRawEvents: true,
    approvalPolicy: "never",
    sandbox: "read-only",
    model: args.model,
    modelProvider: "openai",
    allowProviderModelFallback: false,
    environments: [],
    runtimeWorkspaceRoots: [],
    dynamicTools: participant
      ? [
          {
            type: "function",
            name: participant.tool.name,
            description: participant.tool.description,
            inputSchema: participant.tool.inputSchema,
          },
        ]
      : [],
    baseInstructions: args.request.instructions,
    config: args.config,
  };
}

/** thread/start's reply: the model it runs (the selected one, when one was) and the thread id. */
export function admitThread(
  reply: Record<string, unknown>,
  expected: {
    selectedModel: string | undefined;
    cwd: string;
    reasoningEffort: ReasoningEffort;
    cliVersion: string;
  },
): Admission<{ model: string; threadId: string }> {
  const returnedModel = codexRecord(reply.thread).model;
  if (
    typeof returnedModel !== "string" ||
    returnedModel.length === 0 ||
    returnedModel.length > 200 ||
    (expected.selectedModel !== undefined && returnedModel !== expected.selectedModel) ||
    !admitsRestrictedCodexThread(
      reply,
      returnedModel,
      expected.cwd,
      expected.reasoningEffort,
      expected.cliVersion,
    )
  )
    return { refusal: "codex_unsafe_configuration" };
  return { value: { model: returnedModel, threadId: String(codexRecord(reply.thread).id) } };
}

/** mcpServerStatus/list (isolated auth): no MCP server is running for the thread. */
export function admitMcpStatus(reply: Record<string, unknown>): Admission<void> {
  if (!Array.isArray(reply.data) || reply.data.length !== 0 || reply.nextCursor !== null)
    return { refusal: "codex_unsafe_configuration" };
  return { value: undefined };
}

/**
 * The release's own app-server schema against the fields humanish reads and sends
 * (protocol-contract.ts), generated into the private work directory on every launch. A change
 * there refuses as codex_incompatible_release; a value beyond the baseline is recorded when the
 * launch is admitted. Reading the schema waits on the deadline; a stop leaves the directory to
 * the session's teardown, which removes the whole work directory.
 */
async function admitProtocol(
  file: string,
  env: NodeJS.ProcessEnv,
  state: LaunchState,
  spawnFn: RestrictedCodexSpawn,
  deadline: RestrictedCodexDeadline,
  host: ProtocolContractHost,
): Promise<void> {
  const directory = path.join(state.work!, "schema");
  const generated = await generateProtocolSchema(
    file,
    env,
    state.cwd,
    directory,
    spawnFn,
    deadline,
  );
  const schema = generated
    ? await deadline.wait(loadProtocolSchema(directory).catch(() => undefined))
    : undefined;
  const result =
    schema === undefined
      ? {
          incompatibilities: [
            generated
              ? "its generated app-server schema could not be read"
              : "it did not generate an app-server schema",
          ],
          additions: [],
        }
      : checkProtocol(schema, protocolContract(host));
  await rm(directory, { recursive: true, force: true });
  deadline.check();
  if (result.incompatibilities.length > 0) {
    state.protocolIncompatibilities = result.incompatibilities;
    throw new RestrictedCodexStop("codex_incompatible_release");
  }
  state.protocolAdditions = result.additions;
}

/** The host's Codex auth.json, which a private home links to instead of copying. */
async function hostAuthFile(options: LaunchOptions, sourceEnv: NodeJS.ProcessEnv): Promise<string> {
  const authHome =
    options.authHome ?? sourceEnv.CODEX_HOME ?? path.join(sourceEnv.HOME ?? homedir(), ".codex");
  if (!path.isAbsolute(authHome)) throw new RestrictedCodexStop("codex_unsupported_auth");
  try {
    const authFile = await realpath(path.join(authHome, "auth.json"));
    if (!(await stat(authFile)).isFile()) throw new Error();
    return authFile;
  } catch {
    throw new RestrictedCodexStop("codex_login_required");
  }
}

/**
 * The session's one-time launch: a private home, the auth link, the version check and the spawn,
 * then initialize, config, account, thread and MCP admission.
 */
export async function launchAdmittedAppServer(
  settings: LaunchSettings,
  state: LaunchState,
  request: RestrictedCodexRequest,
  deadline: RestrictedCodexDeadline,
  frameLimit: number,
  enter: (phase: CuaProviderFailurePhase) => void,
  install: (transport: RestrictedCodexTransport) => void,
): Promise<RestrictedCodexTransport> {
  const { options, sourceEnv, participant, operatorAuth, reasoningEffort, spawnFn } = settings;
  const file = await resolveExecutable(options, sourceEnv);
  deadline.check();
  state.work = await mkdtemp(path.join(options.tempRoot ?? tmpdir(), "humanish-codex-analysis-"));
  await chmod(state.work, 0o700);
  state.work = await realpath(state.work);
  const home = path.join(state.work, "home");
  state.cwd = path.join(state.work, "cwd");
  state.scratch = path.join(state.work, "scratch");
  for (const directory of [home, state.cwd, state.scratch]) await mkdir(directory, { mode: 0o700 });
  const env = childEnvironment(sourceEnv, home, state.scratch);
  state.cliVersion = await checkVersion(
    file,
    env,
    state.cwd,
    spawnFn,
    deadline,
    settings.admits,
    options.cliVersion,
  );
  await admitProtocol(file, env, state, spawnFn, deadline, {
    reasoningEffort,
    platform: settings.platform,
  });
  const configMode = {
    participantCodeMode: participant !== undefined,
    reasoningEffort,
    operatorAuth,
  };
  const config = restrictedCodexConfig(request.model, configMode),
    configPath = path.join(home, "config.toml");
  if (!operatorAuth) {
    await writeFile(configPath, config.toml, { mode: 0o600, flag: "wx" });
    const authFile = await hostAuthFile(options, sourceEnv);
    deadline.check();
    state.authLink = path.join(home, "auth.json");
    await symlink(authFile, state.authLink);
  }
  deadline.check();
  const appServerArgs = [
    "app-server",
    "--strict-config",
    ...(operatorAuth ? configArguments(config.overrides) : []),
  ];
  const owned = ownCodexProcess(
    spawnFn(file, appServerArgs, {
      cwd: state.cwd,
      env: operatorAuth ? { ...sourceEnv } : env,
      detached: false,
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
  const launched = new RestrictedCodexTransport(owned, deadline, frameLimit);
  // The session's handlers check output from the first byte, before initialize returns.
  install(launched);
  state.transport = launched;
  enter("initialize");
  const initialize = await launched.rpc("initialize", {
    clientInfo: { name: "humanish_analysis", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  });
  admitted(
    admitInitialize(initialize, {
      cliVersion: state.cliVersion!,
      home,
      operatorAuth,
      platform: settings.platform,
    }),
  );
  launched.notify("initialized", {});
  enter("config/read");
  const effective = await launched.rpc("config/read", { includeLayers: true, cwd: state.cwd });
  const selectedModel = admitted(
    admitEffectiveConfig(effective, configPath, request.model, configMode),
  );
  enter("account/read");
  const account = await launched.rpc("account/read", { refreshToken: false });
  state.authentication = admitted(admitAccount(account, operatorAuth));
  const threadConfig = admitted(threadConfigFor(effective, config.overrides));
  enter("thread/start");
  const thread = await launched.rpc(
    "thread/start",
    threadStartParams({
      cwd: state.cwd,
      model: selectedModel,
      participant,
      request,
      config: threadConfig,
    }),
  );
  const started = admitted(
    admitThread(thread, {
      selectedModel,
      cwd: state.cwd,
      reasoningEffort,
      cliVersion: state.cliVersion!,
    }),
  );
  state.resolvedModel = started.model;
  state.threadId = started.threadId;
  if (!operatorAuth) {
    enter("mcpServerStatus/list");
    admitted(admitMcpStatus(await launched.rpc("mcpServerStatus/list", { limit: 100 })));
  }
  state.identity = {
    requestedModel: request.model,
    model: started.model,
    instructions: request.instructions,
  };
  return launched;
}
