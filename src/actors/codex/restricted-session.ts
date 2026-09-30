import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import type { CuaProviderFailurePhase } from "../computer-use/provider-error.js";
import type { ReasoningEffort } from "../reasoning-effort.js";
import { admittedCodexCliVersions, parseCodexCliVersion } from "./qualified-versions.js";
import {
  CODEX_IMAGE,
  CODEX_MAX_OUTPUT_BYTES,
  CODEX_MAX_REQUEST_BYTES,
  RESTRICTED_CODEX_ANALYSIS_MODELS,
  admitsRestrictedCodexConfig,
  admitsRestrictedCodexThread,
  codexRecord,
  restrictedCodexConfig,
  restrictedCodexFailure,
  restrictedCodexRequestError,
  type RestrictedCodexAnalysisErrorCode,
  type RestrictedCodexRequest,
  type RestrictedCodexResult,
  type RestrictedCodexUsage,
} from "./restricted-policy.js";
import {
  RestrictedCodexDeadline,
  RestrictedCodexStop,
  RestrictedCodexTransport,
  closeOwnedCodexProcess,
  ownCodexProcess,
  type RestrictedCodexSpawn,
} from "./restricted-transport.js";
import { RestrictedCodexTurn } from "./restricted-turn.js";

/** Internal host dependencies. None of these options is accepted from a study artifact. */
export interface RestrictedCodexSessionOptions {
  executable?: string;
  authHome?: string;
  env?: NodeJS.ProcessEnv;
  tempRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** The release a caller already recorded (an analysis identity); any other release is refused. */
  cliVersion?: string;
  /**
   * Bypasses qualification: replaces this host's admitted releases with any list. It exists only
   * so scripts/codex-qualify.mjs can launch an unqualified candidate. No library export, lab
   * manifest, CLI flag, RunLabOptions field or cuaHooks entry reaches it
   * (tests/actors/codex/cli-versions-seam.test.ts).
   */
  cliVersions?: readonly string[];
  spawnFn?: RestrictedCodexSpawn;
  participant?: {
    authMode?: "operator";
    reasoningEffort?: ReasoningEffort;
    tool: {
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      call(args: unknown): Promise<string>;
    };
  };
}

function childEnvironment(
  source: NodeJS.ProcessEnv,
  home: string,
  scratch: string,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { HOME: home, CODEX_HOME: home, TMPDIR: scratch };
  for (const key of ["PATH", "LANG", "USER", "LOGNAME"])
    if (typeof source[key] === "string") result[key] = source[key];
  return result;
}

function configArguments(overrides: Record<string, unknown>): string[] {
  return Object.entries(overrides).flatMap(([key, value]) => [
    "-c",
    `${key}=${JSON.stringify(value)}`,
  ]);
}

function validParticipant(options: RestrictedCodexSessionOptions["participant"]): boolean {
  if (!options) return true;
  const { tool } = options;
  if (
    (options.authMode !== undefined && options.authMode !== "operator") ||
    typeof tool?.name !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(tool.name) ||
    typeof tool.description !== "string" ||
    tool.description.length === 0 ||
    tool.description.length > 4096 ||
    !tool.inputSchema ||
    typeof tool.inputSchema !== "object" ||
    Array.isArray(tool.inputSchema) ||
    typeof tool.call !== "function"
  )
    return false;
  try {
    return Buffer.byteLength(JSON.stringify(tool.inputSchema)) <= 256 * 1024;
  } catch {
    return false;
  }
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

/** Resolve PATH without running a shell. The npm launcher is resolved to its
 * native optional package so cleanup owns the real app-server child. */
async function resolveExecutable(
  options: RestrictedCodexSessionOptions,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const platform = options.platform ?? process.platform,
    arch = options.arch ?? process.arch;
  let selected = options.executable;
  if (selected === undefined) {
    for (const directory of (env.PATH ?? "")
      .split(path.delimiter)
      .filter((entry) => path.isAbsolute(entry))) {
      const candidate = path.join(directory, "codex");
      try {
        await access(candidate, constants.X_OK);
        selected = candidate;
        break;
      } catch {
        /* Continue PATH. */
      }
    }
  }
  if (selected === undefined || !path.isAbsolute(selected))
    throw new RestrictedCodexStop("codex_unavailable");
  let resolved: string;
  try {
    resolved = await realpath(selected);
  } catch {
    throw new RestrictedCodexStop("codex_unavailable");
  }
  if (await isNativeExecutable(resolved, platform)) return resolved;
  if (path.basename(resolved) === "codex.js" && path.basename(path.dirname(resolved)) === "bin") {
    const packageRoot = path.dirname(path.dirname(resolved));
    const target = restrictedCodexNpmTarget(platform, arch);
    if (!target) throw new RestrictedCodexStop("codex_unavailable");
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
      if (await isNativeExecutable(candidate, platform)) return realpath(candidate);
    }
  }
  throw new RestrictedCodexStop("codex_unavailable");
}

/** Returns the detected release after checking it against the admitted list. */
async function checkVersion(
  file: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  spawnFn: RestrictedCodexSpawn,
  deadline: RestrictedCodexDeadline,
  admitted: readonly string[],
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
      !admitted.includes(version) ||
      (expected !== undefined && version !== expected)
    )
      throw new RestrictedCodexStop("codex_unsupported_version");
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

const unclosedChildren = new Set<Promise<void>>();
function retainUnclosedChild(closed: Promise<void>): void {
  unclosedChildren.add(closed);
  void closed.then(() => {
    unclosedChildren.delete(closed);
  });
}

/** Analysts/readiness keep their one-shot lifetime; participants own a session. */
export async function runRestrictedCodexSession(
  request: RestrictedCodexRequest,
  options: RestrictedCodexSessionOptions = {},
  readinessOnly = false,
): Promise<RestrictedCodexResult> {
  const session = createRestrictedCodexSession(options);
  const result = await session.run(request, readinessOnly);
  return (await session.close())
    ? result
    : {
        ...restrictedCodexFailure("codex_cleanup_failed", result.dispatched, result.usage),
        failurePhase: "cleanup",
      };
}

async function writeRecoveryMarker(
  work: string,
  sourceEnv: NodeJS.ProcessEnv,
  reason: "unexpected_auth_replacement" | "process_cleanup_unconfirmed",
): Promise<void> {
  const cache = sourceEnv.XDG_CACHE_HOME ?? path.join(sourceEnv.HOME ?? homedir(), ".cache");
  if (!path.isAbsolute(cache)) return;
  const markers = path.join(cache, "humanish", "codex-analysis-recovery");
  await mkdir(markers, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(markers, `${path.basename(work)}.json`),
    JSON.stringify({
      schema: "humanish.codex-auth-recovery.v1",
      taskDirectoryName: path.basename(work),
      homeDirectoryName: "home",
      authFileName: "auth.json",
      reason,
    }) + "\n",
    { mode: 0o600, flag: "wx" },
  );
}

async function preserveUnexpectedAuth(work: string, sourceEnv: NodeJS.ProcessEnv): Promise<void> {
  const home = path.join(work, "home");
  await chmod(work, 0o700);
  await chmod(home, 0o700);
  const authPath = path.join(home, "auth.json"),
    auth = await lstat(authPath);
  await chmod(authPath, auth.isDirectory() ? 0o700 : 0o600);
  // Preserve only login state. Evidence, logs, databases and config are disposable.
  for (const name of await readdir(home))
    if (name !== "auth.json") await rm(path.join(home, name), { recursive: true, force: true });
  for (const name of await readdir(work))
    if (name !== "home") await rm(path.join(work, name), { recursive: true, force: true });
  await writeRecoveryMarker(work, sourceEnv, "unexpected_auth_replacement");
}

/**
 * Writes each evidence image into the private scratch directory (mode 0600) and returns the turn
 * input items that label and name it. Request validation has already matched CODEX_IMAGE.
 */
async function writeEvidenceImages(
  scratch: string,
  images: RestrictedCodexRequest["images"],
  deadline: RestrictedCodexDeadline,
): Promise<Record<string, unknown>[]> {
  const input: Record<string, unknown>[] = [];
  for (const [index, image] of images.entries()) {
    deadline.check();
    const match = CODEX_IMAGE.exec(image.dataUrl)!;
    const imagePath = path.join(
      scratch,
      `evidence-${index}.${match[1] === "jpeg" ? "jpg" : match[1]}`,
    );
    await writeFile(imagePath, Buffer.from(match[2]!, "base64"), { mode: 0o600 });
    input.push(
      {
        type: "text",
        text: JSON.stringify({ captureEvidenceId: image.evidenceId }),
        text_elements: [],
      },
      { type: "localImage", path: imagePath },
    );
  }
  return input;
}

/** The host's Codex auth.json, which a private home links to instead of copying. */
async function hostAuthFile(
  options: RestrictedCodexSessionOptions,
  sourceEnv: NodeJS.ProcessEnv,
): Promise<string> {
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

/** The transport's frame limit: the output or request cap, or this request's payload plus 1 MiB. */
function requestFrameLimit(request: RestrictedCodexRequest, participant: boolean): number {
  return Math.max(
    participant ? CODEX_MAX_REQUEST_BYTES : CODEX_MAX_OUTPUT_BYTES,
    Buffer.byteLength(
      JSON.stringify({
        instructions: request.instructions,
        evidence: request.evidence,
        images: request.images,
        schema: request.schema,
      }),
    ) +
      1024 * 1024,
  );
}
const readinessResult = (): RestrictedCodexResult => ({
  status: "completed",
  output: null,
  usage: null,
  usageComplete: false,
  dispatched: false,
  errorCode: null,
});
/**
 * Receipt of a failed request: a stop's code, else the deadline's, else codex_process_failed. A
 * cleanup failure keeps its own code. Dispatch and usage are what the turn recorded; a request
 * that failed before its turn existed dispatched nothing.
 */
function failedRequest(
  error: unknown,
  deadline: RestrictedCodexDeadline,
  turn: RestrictedCodexTurn | undefined,
  phase: CuaProviderFailurePhase,
): RestrictedCodexResult {
  const code = error instanceof RestrictedCodexStop ? error.code : "codex_process_failed";
  return {
    ...restrictedCodexFailure(
      code === "codex_cleanup_failed" ? code : (deadline.code ?? code),
      turn?.dispatched ?? false,
      turn?.usage ?? null,
    ),
    failurePhase: phase,
  };
}
/** Receipt: a failure names its phase, and a participant's known usage lists each inference. */
function withReceiptDetails(
  result: RestrictedCodexResult,
  phase: CuaProviderFailurePhase,
  turn: RestrictedCodexTurn | undefined,
  participant: boolean,
): RestrictedCodexResult {
  let receipt = result;
  if (receipt.errorCode !== null && receipt.failurePhase === undefined)
    receipt = { ...receipt, failurePhase: phase };
  if (
    participant &&
    turn !== undefined &&
    turn.usage !== null &&
    turn.inferenceUsage !== null &&
    turn.inferenceUsage.length > 0
  )
    receipt = { ...receipt, inferenceUsage: turn.inferenceUsage.map((item) => ({ ...item })) };
  return receipt;
}

/** One private process and conversation per owner. Only completed turns may continue. */
export interface RestrictedCodexSession {
  readonly pendingUsage?: RestrictedCodexUsage | undefined;
  readonly pendingInferenceUsage?: RestrictedCodexUsage[] | undefined;
  readonly resolvedModel?: string | undefined;
  readonly authentication?: "chatgpt-account" | "api-key" | undefined;
  /** The admitted release this session launched, once its version check has passed. */
  readonly cliVersion?: string | undefined;
  run(request: RestrictedCodexRequest, readinessOnly?: boolean): Promise<RestrictedCodexResult>;
  close(): Promise<boolean>;
}

export function createRestrictedCodexSession(
  options: RestrictedCodexSessionOptions = {},
): RestrictedCodexSession {
  const platform = options.platform ?? process.platform,
    arch = options.arch ?? process.arch;
  const sourceEnv = options.env ?? process.env;
  const participant = options.participant,
    operatorAuth = participant?.authMode === "operator";
  const reasoningEffort = participant?.reasoningEffort ?? "low";
  const spawnFn: RestrictedCodexSpawn =
    options.spawnFn ?? ((file, args, settings) => spawn(file, args, settings));
  let work: string | undefined,
    authLink: string | undefined,
    transport: RestrictedCodexTransport | undefined;
  let threadId: string | undefined,
    cwd = "",
    scratch = "";
  let identity:
    | { requestedModel: string | undefined; model: string; instructions: string }
    | undefined;
  let previousUsage: RestrictedCodexUsage | null = {
    input: 0,
    output: 0,
    cachedInput: 0,
    cacheWriteInput: 0,
  };
  let pendingUsage: RestrictedCodexUsage | undefined;
  let pendingInferenceUsage: RestrictedCodexUsage[] | undefined;
  let resolvedModel: string | undefined;
  let authentication: "chatgpt-account" | "api-key" | undefined;
  let cliVersion: string | undefined;
  const admittedVersions = options.cliVersions ?? admittedCodexCliVersions(platform, arch);
  let activeDeadline: RestrictedCodexDeadline | undefined;
  let interrupt: { threadId: string; turnId: string } | undefined;
  let closed = false,
    cleanupTrusted = true;
  let pending: Promise<RestrictedCodexResult> | undefined,
    closing: Promise<boolean> | undefined,
    disposing: Promise<boolean> | undefined;
  const toolCallIds = new Set<string>();

  const dispose = (): Promise<boolean> => {
    closed = true;
    return (disposing ??= (async () => {
      let cleaned = cleanupTrusted;
      if (transport) {
        cleaned = (await transport.close(interrupt).catch(() => false)) && cleaned;
        if (!cleaned) retainUnclosedChild(transport.owned.closed);
      }
      let authReplaced = false;
      if (authLink && cleaned) {
        try {
          authReplaced = !(await lstat(authLink)).isSymbolicLink();
          if (!authReplaced) await unlink(authLink);
        } catch (error) {
          if (codexRecord(error).code !== "ENOENT") cleaned = false;
        }
      }
      // Preserve unexpected login rotation for private recovery, never overwrite host auth.
      if (authReplaced) {
        cleaned = false;
        if (work) await preserveUnexpectedAuth(work, sourceEnv).catch(() => undefined);
      }
      if (work && cleaned)
        await rm(work, { recursive: true, force: true }).catch(() => {
          cleaned = false;
        });
      if (work && !cleaned && !authReplaced)
        await writeRecoveryMarker(work, sourceEnv, "process_cleanup_unconfirmed").catch(
          () => undefined,
        );
      return cleaned;
    })());
  };

  /**
   * The session's one-time launch: a private home, the auth link, the version check and the
   * spawn, then initialize, config, account, thread and MCP admission. Each piece of state lands
   * on the session as soon as it exists, so dispose cleans up a launch that fails partway.
   */
  async function launchAdmittedAppServer(
    request: RestrictedCodexRequest,
    deadline: RestrictedCodexDeadline,
    frameLimit: number,
    enter: (phase: CuaProviderFailurePhase) => void,
  ): Promise<RestrictedCodexTransport> {
    const file = await resolveExecutable(options, sourceEnv);
    deadline.check();
    work = await mkdtemp(path.join(options.tempRoot ?? tmpdir(), "humanish-codex-analysis-"));
    await chmod(work, 0o700);
    work = await realpath(work);
    const home = path.join(work, "home");
    cwd = path.join(work, "cwd");
    scratch = path.join(work, "scratch");
    for (const directory of [home, cwd, scratch]) await mkdir(directory, { mode: 0o700 });
    const env = childEnvironment(sourceEnv, home, scratch);
    cliVersion = await checkVersion(
      file,
      env,
      cwd,
      spawnFn,
      deadline,
      admittedVersions,
      options.cliVersion,
    );
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
      authLink = path.join(home, "auth.json");
      await symlink(authFile, authLink);
    }
    deadline.check();
    const appServerArgs = [
      "app-server",
      "--strict-config",
      ...(operatorAuth ? configArguments(config.overrides) : []),
    ];
    const owned = ownCodexProcess(
      spawnFn(file, appServerArgs, {
        cwd,
        env: operatorAuth ? { ...sourceEnv } : env,
        detached: false,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    const launched = new RestrictedCodexTransport(owned, deadline, frameLimit);
    transport = launched;
    enter("initialize");
    const initialize = await launched.rpc("initialize", {
      clientInfo: { name: "humanish_analysis", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    if (
      typeof initialize.userAgent !== "string" ||
      !initialize.userAgent.includes(`/${cliVersion} `) ||
      (!operatorAuth && initialize.codexHome !== home) ||
      initialize.platformOs !== (platform === "darwin" ? "macos" : "linux") ||
      initialize.platformFamily !== "unix"
    )
      throw new RestrictedCodexStop("codex_unsupported_version");
    launched.notify("initialized", {});
    enter("config/read");
    const effective = await launched.rpc("config/read", { includeLayers: true, cwd });
    if (!admitsRestrictedCodexConfig(effective, configPath, request.model, configMode))
      throw new RestrictedCodexStop("codex_unsafe_configuration");
    const configuredModel = codexRecord(effective.config).model;
    const selectedModel = typeof configuredModel === "string" ? configuredModel : undefined;
    enter("account/read");
    const account = await launched.rpc("account/read", { refreshToken: false });
    if (account.account === null) throw new RestrictedCodexStop("codex_login_required");
    const accountType = codexRecord(account.account).type;
    if (
      (!operatorAuth && accountType !== "chatgpt") ||
      (operatorAuth && !["chatgpt", "apiKey"].includes(String(accountType))) ||
      account.requiresOpenaiAuth !== true
    )
      throw new RestrictedCodexStop("codex_unsupported_auth");
    authentication = accountType === "apiKey" ? "api-key" : "chatgpt-account";
    const mcpServers = codexRecord(codexRecord(effective.config).mcp_servers);
    const mcpNames = Object.keys(mcpServers);
    // Request overrides are split literally on dots by Codex. Limit names to
    // TOML bare-key characters so each override targets the inherited entry.
    if (mcpNames.length > 100 || mcpNames.some((name) => !/^[A-Za-z0-9_-]{1,200}$/.test(name)))
      throw new RestrictedCodexStop("codex_unsafe_configuration");
    const threadConfig = { ...config.overrides };
    for (const name of mcpNames) threadConfig[`mcp_servers.${name}.enabled`] = false;
    enter("thread/start");
    const thread = await launched.rpc("thread/start", {
      cwd,
      ephemeral: true,
      experimentalRawEvents: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      model: selectedModel,
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
      baseInstructions: request.instructions,
      config: threadConfig,
    });
    const returnedModel = codexRecord(thread.thread).model;
    if (
      typeof returnedModel !== "string" ||
      returnedModel.length === 0 ||
      returnedModel.length > 200 ||
      (selectedModel !== undefined && returnedModel !== selectedModel) ||
      !admitsRestrictedCodexThread(thread, returnedModel, cwd, reasoningEffort, cliVersion)
    )
      throw new RestrictedCodexStop("codex_unsafe_configuration");
    resolvedModel = returnedModel;
    threadId = String(codexRecord(thread.thread).id);
    if (!operatorAuth) {
      enter("mcpServerStatus/list");
      const mcp = await launched.rpc("mcpServerStatus/list", { limit: 100 });
      if (!Array.isArray(mcp.data) || mcp.data.length !== 0 || mcp.nextCursor !== null)
        throw new RestrictedCodexStop("codex_unsafe_configuration");
    }
    identity = {
      requestedModel: request.model,
      model: returnedModel,
      instructions: request.instructions,
    };
    return launched;
  }

  /** Turn dispatch: sends turn/start with the evidence and images, then acknowledges its reply. */
  async function startTurn(
    active: RestrictedCodexTransport,
    request: RestrictedCodexRequest,
    turn: RestrictedCodexTurn,
    deadline: RestrictedCodexDeadline,
    model: string,
  ): Promise<void> {
    const input: Record<string, unknown>[] = [
      { type: "text", text: request.evidence, text_elements: [] },
      ...(await writeEvidenceImages(scratch, request.images, deadline)),
    ];
    deadline.check();
    // Even a lost acknowledgment may have dispatched the request. Never claim zero cost.
    turn.dispatched = true;
    const reply = await active.rpc("turn/start", {
      threadId,
      cwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly" },
      environments: [],
      runtimeWorkspaceRoots: [],
      effort: reasoningEffort,
      model,
      outputSchema: request.schema,
      input,
    });
    turn.acknowledge(codexRecord(reply.turn).id);
  }

  async function execute(
    request: RestrictedCodexRequest,
    readinessOnly: boolean,
  ): Promise<RestrictedCodexResult> {
    const deadline = new RestrictedCodexDeadline(request.timeoutMs, request.signal);
    activeDeadline = deadline;
    let turn: RestrictedCodexTurn | undefined;
    let result: RestrictedCodexResult = restrictedCodexFailure("codex_process_failed");
    let phase: CuaProviderFailurePhase = "startup";
    try {
      turn = new RestrictedCodexTurn({
        deadline,
        threadId: () => threadId,
        participant: participant !== undefined,
        tool: () => participant!.tool,
        usageBaseline: previousUsage,
        toolCallIds,
        reportUsage: (usage, inference) => {
          pendingUsage = usage;
          pendingInferenceUsage = inference;
        },
        turnStarted: (turnId) => {
          interrupt = { threadId: threadId!, turnId };
        },
      });
      pendingUsage = undefined;
      deadline.check();
      const frameLimit = requestFrameLimit(request, participant !== undefined);
      let selectedModel = identity?.model;
      if (!transport) {
        transport = await launchAdmittedAppServer(request, deadline, frameLimit, (next) => {
          phase = next;
        });
        selectedModel = identity!.model;
      } else transport.beginRequest(deadline, frameLimit);
      // onNotification ignores events before dispatch and onRequestComplete follows only a host
      // callback, so wiring both after the first launch's handshake loses nothing.
      transport.onNotification = turn.onNotification;
      transport.onRequestComplete = turn.onRequestComplete;
      if (readinessOnly) result = readinessResult();
      else {
        phase = "turn/start";
        if (participant) transport.onRequest = turn.onRequest;
        await startTurn(transport, request, turn, deadline, selectedModel!);
        phase = "response";
        result = await deadline.wait(turn.finished);
        deadline.check();
        previousUsage = turn.latestUsage;
        interrupt = undefined;
      }
    } catch (error) {
      result = failedRequest(error, deadline, turn, phase);
    } finally {
      pendingUsage = undefined;
      pendingInferenceUsage = undefined;
      deadline.close();
      activeDeadline = undefined;
      if (transport) transport.onNotification = () => undefined;
      if (transport) transport.onRequest = undefined;
      if (transport) transport.onRequestComplete = undefined;
      if (result.errorCode !== null) {
        if (result.errorCode === "codex_cleanup_failed") cleanupTrusted = false;
        if (!(await dispose()))
          result = {
            ...restrictedCodexFailure(
              "codex_cleanup_failed",
              turn?.dispatched ?? false,
              turn?.usage ?? null,
            ),
            failurePhase: "cleanup",
          };
      }
    }
    return withReceiptDetails(result, phase, turn, participant !== undefined);
  }

  return {
    get pendingUsage() {
      return pendingUsage;
    },
    get pendingInferenceUsage() {
      return pendingInferenceUsage?.map((item) => ({ ...item }));
    },
    get resolvedModel() {
      return resolvedModel;
    },
    get authentication() {
      return authentication;
    },
    get cliVersion() {
      return cliVersion;
    },
    run(request, readinessOnly = false) {
      const error = restrictedCodexRequestError(request, operatorAuth);
      if (error) return Promise.resolve(restrictedCodexFailure(error));
      if (!validParticipant(participant))
        return Promise.resolve(restrictedCodexFailure("invalid_request"));
      if (
        closed ||
        (identity &&
          (identity.requestedModel !== request.model ||
            identity.instructions !== request.instructions))
      )
        return Promise.resolve(restrictedCodexFailure("invalid_request"));
      if (pending || unclosedChildren.size)
        return Promise.resolve(restrictedCodexFailure("codex_busy"));
      const supportedPlatform = operatorAuth
        ? restrictedCodexNpmTarget(platform, arch) !== undefined
        : (platform === "linux" && arch === "x64") || (platform === "darwin" && arch === "arm64");
      if (!supportedPlatform)
        return Promise.resolve(restrictedCodexFailure("codex_unsupported_platform"));
      const task = execute(request, readinessOnly);
      pending = task;
      void task
        .finally(() => {
          if (pending === task) pending = undefined;
        })
        .catch(() => undefined);
      return task;
    },
    close() {
      closed = true;
      activeDeadline?.stop("cancelled");
      return (closing ??= (async () => {
        await pending;
        return dispose();
      })());
    },
  };
}

export async function checkRestrictedCodexSessionReadiness(
  input: { signal?: AbortSignal; timeoutMs?: number } = {},
  options: RestrictedCodexSessionOptions = {},
): Promise<RestrictedCodexResult> {
  return runRestrictedCodexSession(
    {
      model: RESTRICTED_CODEX_ANALYSIS_MODELS[0],
      instructions: "Analyze only supplied study evidence.",
      evidence: "",
      images: [],
      schema: { type: "object", additionalProperties: false, properties: {} },
      maxOutputTokens: null,
      timeoutMs: input.timeoutMs ?? 15_000,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
    options,
    true,
  );
}

/** Resolve and version-check the CLI an analyst launch would use, without app-server or a model.
 * `--version` runs with a private temporary home, removed afterwards. */
export async function detectRestrictedCodexCliVersion(
  input: { signal?: AbortSignal; timeoutMs?: number } = {},
  options: RestrictedCodexSessionOptions = {},
): Promise<
  | { cliVersion: string; errorCode: null }
  | { cliVersion: null; errorCode: RestrictedCodexAnalysisErrorCode }
> {
  const platform = options.platform ?? process.platform,
    arch = options.arch ?? process.arch;
  if (!((platform === "linux" && arch === "x64") || (platform === "darwin" && arch === "arm64")))
    return { cliVersion: null, errorCode: "codex_unsupported_platform" };
  const sourceEnv = options.env ?? process.env;
  const deadline = new RestrictedCodexDeadline(input.timeoutMs ?? 15_000, input.signal);
  let work: string | undefined;
  try {
    const file = await resolveExecutable(options, sourceEnv);
    work = await realpath(
      await mkdtemp(path.join(options.tempRoot ?? tmpdir(), "humanish-codex-version-")),
    );
    const home = path.join(work, "home");
    await mkdir(home, { mode: 0o700 });
    const cliVersion = await checkVersion(
      file,
      childEnvironment(sourceEnv, home, work),
      work,
      options.spawnFn ?? ((command, args, settings) => spawn(command, args, settings)),
      deadline,
      options.cliVersions ?? admittedCodexCliVersions(platform, arch),
      options.cliVersion,
    );
    return { cliVersion, errorCode: null };
  } catch (error) {
    return {
      cliVersion: null,
      errorCode:
        error instanceof RestrictedCodexStop
          ? error.code
          : (deadline.code ?? "codex_process_failed"),
    };
  } finally {
    deadline.close();
    if (work) await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
