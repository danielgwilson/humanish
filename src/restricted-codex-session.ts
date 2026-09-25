import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import type { CuaProviderFailurePhase } from "./cua-provider-error.js";
import type { ReasoningEffort } from "./reasoning-effort.js";
import { CODEX_IMAGE, CODEX_MAX_OUTPUT_BYTES, CODEX_MAX_REQUEST_BYTES, RESTRICTED_CODEX_ANALYSIS_IDENTITY, RESTRICTED_CODEX_ANALYSIS_MODELS,
  admitsRestrictedCodexConfig, admitsRestrictedCodexThread, codexRecord, restrictedCodexConfig, restrictedCodexFailure,
  restrictedCodexRequestError, restrictedCodexUsage, type RestrictedCodexRequest, type RestrictedCodexResult,
  type RestrictedCodexUsage } from "./restricted-codex-policy.js";
import { RestrictedCodexDeadline, RestrictedCodexStop, RestrictedCodexTransport, closeOwnedCodexProcess,
  ownCodexProcess, type RestrictedCodexSpawn } from "./restricted-codex-transport.js";

/** Internal host dependencies. None of these options is accepted from a study artifact. */
export interface RestrictedCodexSessionOptions {
  executable?: string;
  authHome?: string;
  env?: NodeJS.ProcessEnv;
  tempRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
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

function childEnvironment(source: NodeJS.ProcessEnv, home: string, scratch: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { HOME: home, CODEX_HOME: home, TMPDIR: scratch };
  for (const key of ["PATH", "LANG", "USER", "LOGNAME"])
    if (typeof source[key] === "string") result[key] = source[key];
  return result;
}

function configArguments(overrides: Record<string, unknown>): string[] {
  return Object.entries(overrides).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]);
}

function validParticipant(options: RestrictedCodexSessionOptions["participant"]): boolean {
  if (!options) return true;
  const { tool } = options;
  if ((options.authMode !== undefined && options.authMode !== "operator")
    || typeof tool?.name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(tool.name)
    || typeof tool.description !== "string" || tool.description.length === 0 || tool.description.length > 4096
    || !tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)
    || typeof tool.call !== "function") return false;
  try { return Buffer.byteLength(JSON.stringify(tool.inputSchema)) <= 256 * 1024; } catch { return false; }
}

async function isNativeExecutable(file: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(4);
      const read = await handle.read(buffer, 0, 4, 0);
      return read.bytesRead === 4 && (platform === "darwin"
        ? ["cffaedfe", "feedfacf", "cafebabe", "bebafeca", "cafebabf"].includes(buffer.toString("hex"))
        : buffer.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])));
    } finally { await handle.close(); }
  } catch { return false; }
}

/** Official npm launcher target map for the Unix hosts supported by this transport. */
export function restrictedCodexNpmTarget(platform: NodeJS.Platform, arch: string): {
  triple: string; packageName: string;
} | undefined {
  if (platform === "linux" && arch === "x64") return { triple: "x86_64-unknown-linux-musl", packageName: "codex-linux-x64" };
  if (platform === "linux" && arch === "arm64") return { triple: "aarch64-unknown-linux-musl", packageName: "codex-linux-arm64" };
  if (platform === "darwin" && arch === "x64") return { triple: "x86_64-apple-darwin", packageName: "codex-darwin-x64" };
  if (platform === "darwin" && arch === "arm64") return { triple: "aarch64-apple-darwin", packageName: "codex-darwin-arm64" };
  return undefined;
}

/** Resolve PATH without running a shell. The npm launcher is resolved to its
 * native optional package so cleanup owns the real app-server child. */
async function resolveExecutable(options: RestrictedCodexSessionOptions, env: NodeJS.ProcessEnv): Promise<string> {
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  let selected = options.executable;
  if (selected === undefined) {
    for (const directory of (env.PATH ?? "").split(path.delimiter).filter(entry => path.isAbsolute(entry))) {
      const candidate = path.join(directory, "codex");
      try { await access(candidate, constants.X_OK); selected = candidate; break; } catch { /* Continue PATH. */ }
    }
  }
  if (selected === undefined || !path.isAbsolute(selected)) throw new RestrictedCodexStop("codex_unavailable");
  let resolved: string;
  try { resolved = await realpath(selected); } catch { throw new RestrictedCodexStop("codex_unavailable"); }
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
    } catch { /* Older packages may bundle the native executable directly. */ }
    candidates.push(path.join(packageRoot, "vendor", triple, "bin", "codex"));
    for (const candidate of candidates) {
      if (await isNativeExecutable(candidate, platform)) return realpath(candidate);
    }
  }
  throw new RestrictedCodexStop("codex_unavailable");
}

async function checkVersion(file: string, env: NodeJS.ProcessEnv, cwd: string, spawnFn: RestrictedCodexSpawn,
  deadline: RestrictedCodexDeadline): Promise<void> {
  deadline.check();
  const owned = ownCodexProcess(spawnFn(file, ["--version"], { cwd, env, detached: false, stdio: ["pipe", "pipe", "pipe"] }));
  let text = "", bytes = 0, exitCode: number | null = null;
  const timer = setTimeout(() => deadline.stop("timeout"), 15_000);
  owned.child.on("error", () => deadline.stop("codex_unavailable"));
  owned.child.stdin.on("error", () => deadline.stop("codex_unavailable"));
  owned.child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 4096) deadline.stop("response_too_large");
    else text += chunk.toString("utf8");
  });
  owned.child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4096) deadline.stop("response_too_large"); });
  owned.child.on("exit", code => { exitCode = code; });
  try {
    await deadline.wait(owned.closed);
    if (exitCode !== 0) throw new RestrictedCodexStop("codex_unavailable");
    if (text.trim() !== `codex-cli ${RESTRICTED_CODEX_ANALYSIS_IDENTITY.cliVersion}`)
      throw new RestrictedCodexStop("codex_unsupported_version");
  } finally {
    clearTimeout(timer);
    if (!await closeOwnedCodexProcess(owned)) {
      retainUnclosedChild(owned.closed);
      throw new RestrictedCodexStop("codex_cleanup_failed");
    }
  }
}

const rawCompactionTypes = ["compaction", "compaction_summary", "context_compaction"];
const analystRawItemTypes = ["message", "reasoning", ...rawCompactionTypes];
const participantRawItemTypes = [...analystRawItemTypes, "custom_tool_call", "custom_tool_call_output",
  "function_call", "function_call_output"];

type Event = { method: string; params: Record<string, unknown> };
const unclosedChildren = new Set<Promise<void>>();
function retainUnclosedChild(closed: Promise<void>): void {
  unclosedChildren.add(closed);
  void closed.then(() => { unclosedChildren.delete(closed); });
}

/** Analysts/readiness keep their one-shot lifetime; participants own a session. */
export async function runRestrictedCodexSession(request: RestrictedCodexRequest,
  options: RestrictedCodexSessionOptions = {}, readinessOnly = false): Promise<RestrictedCodexResult> {
  const session = createRestrictedCodexSession(options);
  const result = await session.run(request, readinessOnly);
  return await session.close() ? result
    : { ...restrictedCodexFailure("codex_cleanup_failed", result.dispatched, result.usage), failurePhase: "cleanup" };
}

async function writeRecoveryMarker(work: string, sourceEnv: NodeJS.ProcessEnv,
  reason: "unexpected_auth_replacement" | "process_cleanup_unconfirmed"): Promise<void> {
  const cache = sourceEnv.XDG_CACHE_HOME ?? path.join(sourceEnv.HOME ?? homedir(), ".cache");
  if (!path.isAbsolute(cache)) return;
  const markers = path.join(cache, "humanish", "codex-analysis-recovery");
  await mkdir(markers, { recursive: true, mode: 0o700 });
  await writeFile(path.join(markers, `${path.basename(work)}.json`), JSON.stringify({
    schema: "humanish.codex-auth-recovery.v1", taskDirectoryName: path.basename(work),
    homeDirectoryName: "home", authFileName: "auth.json", reason
  }) + "\n", { mode: 0o600, flag: "wx" });
}

async function preserveUnexpectedAuth(work: string, sourceEnv: NodeJS.ProcessEnv): Promise<void> {
  const home = path.join(work, "home");
  await chmod(work, 0o700); await chmod(home, 0o700);
  const authPath = path.join(home, "auth.json"), auth = await lstat(authPath);
  await chmod(authPath, auth.isDirectory() ? 0o700 : 0o600);
  // Preserve only login state. Evidence, logs, databases and config are disposable.
  for (const name of await readdir(home)) if (name !== "auth.json") await rm(path.join(home, name), { recursive: true, force: true });
  for (const name of await readdir(work)) if (name !== "home") await rm(path.join(work, name), { recursive: true, force: true });
  await writeRecoveryMarker(work, sourceEnv, "unexpected_auth_replacement");
}

function hasScopedIdentity(method: string, params: Record<string, unknown>, threadId: string | undefined,
  turnId: string | undefined): boolean {
  if (method === "turn/started" || method === "turn/completed") {
    const id = codexRecord(params.turn).id;
    return params.threadId === threadId && typeof id === "string" && id.length > 0 && id.length <= 200
      && (turnId === undefined || id === turnId);
  }
  if (method.startsWith("item/") || method.startsWith("rawResponse") || method === "thread/tokenUsage/updated")
    return params.threadId === threadId && typeof params.turnId === "string" && params.turnId.length > 0
      && (turnId === undefined || params.turnId === turnId);
  return (params.threadId === undefined || params.threadId === threadId) && (params.turnId === undefined || params.turnId === turnId);
}

/** One private process and conversation per owner. Only completed turns may continue. */
export interface RestrictedCodexSession {
  readonly pendingUsage?: RestrictedCodexUsage | undefined;
  readonly resolvedModel?: string | undefined;
  readonly authentication?: "chatgpt-account" | "api-key" | undefined;
  run(request: RestrictedCodexRequest, readinessOnly?: boolean): Promise<RestrictedCodexResult>;
  close(): Promise<boolean>;
}

export function createRestrictedCodexSession(options: RestrictedCodexSessionOptions = {}): RestrictedCodexSession {
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  const sourceEnv = options.env ?? process.env;
  const participant = options.participant, operatorAuth = participant?.authMode === "operator";
  const reasoningEffort = participant?.reasoningEffort ?? "low";
  const spawnFn: RestrictedCodexSpawn = options.spawnFn ?? ((file, args, settings) => spawn(file, args, settings));
  let work: string | undefined, authLink: string | undefined, transport: RestrictedCodexTransport | undefined;
  let threadId: string | undefined, cwd = "", scratch = "";
  let identity: { requestedModel: string | undefined; model: string; instructions: string } | undefined;
  let previousUsage: RestrictedCodexUsage | null = { input: 0, output: 0, cachedInput: 0, cacheWriteInput: 0 };
  let pendingUsage: RestrictedCodexUsage | undefined;
  let resolvedModel: string | undefined;
  let authentication: "chatgpt-account" | "api-key" | undefined;
  let activeDeadline: RestrictedCodexDeadline | undefined;
  let interrupt: { threadId: string; turnId: string } | undefined;
  let closed = false, cleanupTrusted = true;
  let pending: Promise<RestrictedCodexResult> | undefined, closing: Promise<boolean> | undefined, disposing: Promise<boolean> | undefined;
  const toolCallIds = new Set<string>();

  const dispose = (): Promise<boolean> => {
    closed = true;
    return disposing ??= (async () => {
      let cleaned = cleanupTrusted;
      if (transport) {
        cleaned = await transport.close(interrupt).catch(() => false) && cleaned;
        if (!cleaned) retainUnclosedChild(transport.owned.closed);
      }
      let authReplaced = false;
      if (authLink && cleaned) {
        try {
          authReplaced = !(await lstat(authLink)).isSymbolicLink();
          if (!authReplaced) await unlink(authLink);
        } catch (error) { if (codexRecord(error).code !== "ENOENT") cleaned = false; }
      }
      // Preserve unexpected login rotation for private recovery, never overwrite host auth.
      if (authReplaced) {
        cleaned = false;
        if (work) await preserveUnexpectedAuth(work, sourceEnv).catch(() => undefined);
      }
      if (work && cleaned) await rm(work, { recursive: true, force: true }).catch(() => { cleaned = false; });
      if (work && !cleaned && !authReplaced) await writeRecoveryMarker(work, sourceEnv, "process_cleanup_unconfirmed").catch(() => undefined);
      return cleaned;
    })();
  };

  async function execute(request: RestrictedCodexRequest, readinessOnly: boolean): Promise<RestrictedCodexResult> {
    const deadline = new RestrictedCodexDeadline(request.timeoutMs, request.signal);
    activeDeadline = deadline;
    let turnId: string | undefined, earlyTurnId: string | undefined;
    let dispatched = false, usage: RestrictedCodexUsage | null = null;
    let completed = false, compacted = false;
    let toolRequestPending = false;
    let latestUsage: RestrictedCodexUsage | null = null;
    const requestUsageBaseline = previousUsage;
    let generatedDeltaBytes = 0;
    let selectedModel = identity?.model;
    const allowedRawItemTypes = participant ? participantRawItemTypes : analystRawItemTypes;
    let outputItem: { id: string; text: string } | undefined;
    let result: RestrictedCodexResult = restrictedCodexFailure("codex_process_failed");
    let phase: CuaProviderFailurePhase = "startup";
    const early: Event[] = [];
    let resolveTurn!: (value: RestrictedCodexResult) => void;
    const finished = new Promise<RestrictedCodexResult>(resolve => { resolveTurn = resolve; });
    let resolveTurnReady!: (value: string) => void;
    const turnReady = new Promise<string>(resolve => { resolveTurnReady = resolve; });

    const handleTurnEvent = (method: string, params: Record<string, unknown>): void => {
      if (!hasScopedIdentity(method, params, threadId, turnId)) { deadline.stop("codex_protocol_error"); return; }
      const item = codexRecord(params.item);
      // CLI 0.154 thread totals omit compaction requests. Retain known usage,
      // but never label it complete when native compaction occurred in this turn.
      if (method === "thread/compacted" || item.type === "contextCompaction" || rawCompactionTypes.includes(String(item.type))) compacted = true;
      if (method === "rawResponseItem/completed") {
        if (!allowedRawItemTypes.includes(String(item.type))) { deadline.stop("codex_tool_call"); return; }
        if (item.type === "custom_tool_call" && item.name !== "exec") { deadline.stop("codex_tool_call"); return; }
        if (item.type === "function_call" && item.name !== "wait") { deadline.stop("codex_tool_call"); return; }
        if (item.type === "message" && Array.isArray(item.content)
          && item.content.some(content => codexRecord(content).type === "refusal")) deadline.stop("refusal");
      }
      if (method === "thread/tokenUsage/updated") {
        const total = restrictedCodexUsage(params.tokenUsage);
        // App-server reports cumulative thread usage. Receipts must charge only this turn.
        if (total && requestUsageBaseline) {
          const delta = { input: total.input - requestUsageBaseline.input, output: total.output - requestUsageBaseline.output,
            cachedInput: (total.cachedInput ?? 0) - (requestUsageBaseline.cachedInput ?? 0),
            cacheWriteInput: (total.cacheWriteInput ?? 0) - (requestUsageBaseline.cacheWriteInput ?? 0) };
          usage = Object.values(delta).every(value => Number.isSafeInteger(value) && value >= 0)
            && delta.cachedInput + delta.cacheWriteInput <= delta.input ? delta : null;
        } else usage = null;
        pendingUsage = usage ?? undefined;
        latestUsage = total;
      }
      if (method === "item/started" || method === "item/completed") {
        const allowedItems = participant
          ? ["userMessage", "agentMessage", "reasoning", "contextCompaction", "dynamicToolCall"]
          : ["userMessage", "agentMessage", "reasoning", "contextCompaction"];
        if (!allowedItems.includes(String(item.type))) { deadline.stop("codex_tool_call"); return; }
        if (item.type === "dynamicToolCall" && (item.tool !== participant?.tool.name || item.namespace !== null
          || (method === "item/started" && item.status !== "inProgress")
          || (method === "item/completed" && (item.status !== "completed" || item.success !== true)))) {
          deadline.stop("codex_tool_call"); return;
        }
        if (item.type === "agentMessage") {
          if (item.delivery === "async" || (Array.isArray(item.questions) && item.questions.length > 0)) {
            deadline.stop("codex_tool_call"); return;
          }
          if (method === "item/completed" && item.phase !== "commentary") {
            if (typeof item.id !== "string" || typeof item.text !== "string" || Buffer.byteLength(item.text) > CODEX_MAX_OUTPUT_BYTES
              || (item.phase !== null && item.phase !== "final_answer") || (item.delivery !== null && item.delivery !== undefined)
              || (outputItem && (outputItem.id !== item.id || outputItem.text !== item.text))) {
              deadline.stop("invalid_response"); return;
            }
            outputItem = { id: item.id, text: item.text };
          }
        }
      }
      if (method === "turn/completed") {
        const turn = codexRecord(params.turn);
        if (turn.id !== turnId || completed || toolRequestPending) { deadline.stop("codex_protocol_error"); return; }
        completed = true;
        if (turn.status === "interrupted") { deadline.stop("cancelled"); return; }
        if (turn.status !== "completed" || turn.error !== null || !outputItem) { deadline.stop("invalid_response"); return; }
        try {
          pendingUsage = undefined;
          resolveTurn({ status: "completed", output: JSON.parse(outputItem.text) as unknown, usage,
            usageComplete: usage !== null && !compacted, dispatched: true, errorCode: null });
        } catch { deadline.stop("invalid_response"); }
      }
    };

    const onNotification: RestrictedCodexTransport["onNotification"] = (method, params) => {
      if (!dispatched) return;
      if (!hasScopedIdentity(method, params, threadId, turnId ?? earlyTurnId)) { deadline.stop("codex_protocol_error"); return; }
      if (method === "item/agentMessage/delta") {
        if (typeof params.delta !== "string") { deadline.stop("codex_protocol_error"); return; }
        generatedDeltaBytes += Buffer.byteLength(params.delta);
        if (generatedDeltaBytes > CODEX_MAX_OUTPUT_BYTES) { deadline.stop("response_too_large"); return; }
      }
      const item = codexRecord(params.item);
      // Tool requests must fail even if the turn-start acknowledgment is lost.
      if ((method === "rawResponseItem/completed" && !allowedRawItemTypes.includes(String(item.type)))
        || (method === "rawResponseItem/completed" && item.type === "custom_tool_call" && item.name !== "exec")
        || (method === "rawResponseItem/completed" && item.type === "function_call" && item.name !== "wait")
        || (["item/started", "item/completed"].includes(method) && item.type === "agentMessage"
          && (item.delivery === "async" || (Array.isArray(item.questions) && item.questions.length > 0)))) {
        deadline.stop("codex_tool_call"); return;
      }
      if (method === "turn/started") {
        const value = codexRecord(params.turn).id;
        if (typeof value !== "string" || value.length === 0 || (earlyTurnId !== undefined && value !== earlyTurnId))
          deadline.stop("codex_protocol_error");
        else { earlyTurnId = value; interrupt = { threadId: threadId!, turnId: value }; }
      }
      if (turnId === undefined) early.push({ method, params });
      else handleTurnEvent(method, params);
    };

    const onRequest: RestrictedCodexTransport["onRequest"] = async (method, params) => {
      // App-server can write the turn/start reply and first server request in one
      // stdout chunk. Wait for the acknowledged identity before admitting work.
      const activeTurnId = turnId ?? earlyTurnId ?? await deadline.wait(turnReady);
      const callId = params.callId;
      if (!participant || method !== "item/tool/call" || params.threadId !== threadId || params.turnId !== activeTurnId
        || params.namespace !== null || params.tool !== participant.tool.name || typeof callId !== "string"
        || callId.length === 0 || callId.length > 200 || toolCallIds.has(callId) || toolRequestPending)
        throw new RestrictedCodexStop("codex_tool_call");
      toolCallIds.add(callId);
      toolRequestPending = true;
      deadline.pause();
      const text = await deadline.wait(participant.tool.call(params.arguments));
      if (typeof text !== "string" || Buffer.byteLength(text) > CODEX_MAX_REQUEST_BYTES) throw new RestrictedCodexStop("invalid_response");
      try { JSON.parse(text); } catch { throw new RestrictedCodexStop("invalid_response"); }
      return { success: true, contentItems: [{ type: "inputText", text }] };
    };

    try {
      pendingUsage = undefined;
      deadline.check();
      const frameLimit = Math.max(participant ? CODEX_MAX_REQUEST_BYTES : CODEX_MAX_OUTPUT_BYTES, Buffer.byteLength(JSON.stringify({ instructions: request.instructions,
        evidence: request.evidence, images: request.images, schema: request.schema })) + 1024 * 1024);
      if (!transport) {
        const file = await resolveExecutable(options, sourceEnv);
        deadline.check();
        work = await mkdtemp(path.join(options.tempRoot ?? tmpdir(), "humanish-codex-analysis-"));
        await chmod(work, 0o700);
        work = await realpath(work);
        const home = path.join(work, "home");
        cwd = path.join(work, "cwd"); scratch = path.join(work, "scratch");
        for (const directory of [home, cwd, scratch]) await mkdir(directory, { mode: 0o700 });
        const env = childEnvironment(sourceEnv, home, scratch);
        await checkVersion(file, env, cwd, spawnFn, deadline);
        const configMode = { participantCodeMode: participant !== undefined, reasoningEffort, operatorAuth };
        const config = restrictedCodexConfig(request.model, configMode), configPath = path.join(home, "config.toml");
        if (!operatorAuth) {
          await writeFile(configPath, config.toml, { mode: 0o600, flag: "wx" });
          const authHome = options.authHome ?? sourceEnv.CODEX_HOME ?? path.join(sourceEnv.HOME ?? homedir(), ".codex");
          if (!path.isAbsolute(authHome)) throw new RestrictedCodexStop("codex_unsupported_auth");
          let authFile: string;
          try {
            authFile = await realpath(path.join(authHome, "auth.json"));
            if (!(await stat(authFile)).isFile()) throw new Error();
          } catch { throw new RestrictedCodexStop("codex_login_required"); }
          deadline.check();
          authLink = path.join(home, "auth.json");
          await symlink(authFile, authLink);
        }
        deadline.check();
        const appServerArgs = ["app-server", "--strict-config", ...(operatorAuth ? configArguments(config.overrides) : [])];
        const owned = ownCodexProcess(spawnFn(file, appServerArgs, {
          cwd, env: operatorAuth ? { ...sourceEnv } : env, detached: false, stdio: ["pipe", "pipe", "pipe"]
        }));
        transport = new RestrictedCodexTransport(owned, deadline, frameLimit);
        transport.onNotification = onNotification;
        transport.onRequestComplete = () => { toolRequestPending = false; };
        phase = "initialize";
        const initialize = await transport.rpc("initialize", {
          clientInfo: { name: "humanish_analysis", version: "1.0.0" }, capabilities: { experimentalApi: true }
        });
        if (typeof initialize.userAgent !== "string" || !initialize.userAgent.includes(`/0.154.0 `)
          || (!operatorAuth && initialize.codexHome !== home)
          || initialize.platformOs !== (platform === "darwin" ? "macos" : "linux") || initialize.platformFamily !== "unix")
          throw new RestrictedCodexStop("codex_unsupported_version");
        transport.notify("initialized", {});
        phase = "config/read";
        const effective = await transport.rpc("config/read", { includeLayers: true, cwd });
        if (!admitsRestrictedCodexConfig(effective, configPath, request.model, configMode)) throw new RestrictedCodexStop("codex_unsafe_configuration");
        const configuredModel = codexRecord(effective.config).model;
        selectedModel = typeof configuredModel === "string" ? configuredModel : undefined;
        phase = "account/read";
        const account = await transport.rpc("account/read", { refreshToken: false });
        if (account.account === null) throw new RestrictedCodexStop("codex_login_required");
        const accountType = codexRecord(account.account).type;
        if ((!operatorAuth && accountType !== "chatgpt") || (operatorAuth && !["chatgpt", "apiKey"].includes(String(accountType)))
          || account.requiresOpenaiAuth !== true)
          throw new RestrictedCodexStop("codex_unsupported_auth");
        authentication = accountType === "apiKey" ? "api-key" : "chatgpt-account";
        const mcpServers = codexRecord(codexRecord(effective.config).mcp_servers);
        const mcpNames = Object.keys(mcpServers);
        // Request overrides are split literally on dots by Codex. Limit names to
        // TOML bare-key characters so each override targets the inherited entry.
        if (mcpNames.length > 100 || mcpNames.some(name => !/^[A-Za-z0-9_-]{1,200}$/.test(name)))
          throw new RestrictedCodexStop("codex_unsafe_configuration");
        const threadConfig = { ...config.overrides };
        for (const name of mcpNames) threadConfig[`mcp_servers.${name}.enabled`] = false;
        phase = "thread/start";
        const thread = await transport.rpc("thread/start", { cwd, ephemeral: true, experimentalRawEvents: true,
          approvalPolicy: "never", sandbox: "read-only", model: selectedModel, modelProvider: "openai", allowProviderModelFallback: false,
          environments: [], runtimeWorkspaceRoots: [], dynamicTools: participant ? [{ type: "function", name: participant.tool.name,
            description: participant.tool.description, inputSchema: participant.tool.inputSchema }] : [],
          baseInstructions: request.instructions, config: threadConfig });
        const returnedModel = codexRecord(thread.thread).model;
        if (typeof returnedModel !== "string" || returnedModel.length === 0 || returnedModel.length > 200
          || (selectedModel !== undefined && returnedModel !== selectedModel)
          || !admitsRestrictedCodexThread(thread, returnedModel, cwd, reasoningEffort))
          throw new RestrictedCodexStop("codex_unsafe_configuration");
        selectedModel = returnedModel;
        resolvedModel = returnedModel;
        threadId = String(codexRecord(thread.thread).id);
        if (!operatorAuth) {
          phase = "mcpServerStatus/list";
          const mcp = await transport.rpc("mcpServerStatus/list", { limit: 100 });
          if (!Array.isArray(mcp.data) || mcp.data.length !== 0 || mcp.nextCursor !== null)
            throw new RestrictedCodexStop("codex_unsafe_configuration");
        }
        identity = { requestedModel: request.model, model: selectedModel, instructions: request.instructions };
      } else {
        transport.beginRequest(deadline, frameLimit);
        transport.onNotification = onNotification;
        transport.onRequestComplete = () => { toolRequestPending = false; };
      }
      if (readinessOnly) {
        result = { status: "completed", output: null, usage: null, usageComplete: false, dispatched: false, errorCode: null };
      } else {
        phase = "turn/start";
        if (participant) transport.onRequest = onRequest;
        const input: Record<string, unknown>[] = [{ type: "text", text: request.evidence, text_elements: [] }];
        for (const [index, image] of request.images.entries()) {
          deadline.check();
          const match = CODEX_IMAGE.exec(image.dataUrl)!;
          const imagePath = path.join(scratch, `evidence-${index}.${match[1] === "jpeg" ? "jpg" : match[1]}`);
          await writeFile(imagePath, Buffer.from(match[2]!, "base64"), { mode: 0o600 });
          input.push({ type: "text", text: JSON.stringify({ captureEvidenceId: image.evidenceId }), text_elements: [] }, { type: "localImage", path: imagePath });
        }
        deadline.check();
        // Even a lost acknowledgment may have dispatched the request. Never claim zero cost.
        dispatched = true;
        const turn = await transport.rpc("turn/start", { threadId, cwd, approvalPolicy: "never", sandboxPolicy: { type: "readOnly" },
          environments: [], runtimeWorkspaceRoots: [], effort: reasoningEffort, model: selectedModel!, outputSchema: request.schema, input });
        const returnedTurnId = codexRecord(turn.turn).id;
        if (typeof returnedTurnId !== "string" || returnedTurnId.length === 0 || returnedTurnId.length > 200
          || (earlyTurnId !== undefined && earlyTurnId !== returnedTurnId)) throw new RestrictedCodexStop("codex_protocol_error");
        turnId = returnedTurnId;
        resolveTurnReady(turnId);
        interrupt = { threadId: threadId!, turnId };
        for (const event of early) handleTurnEvent(event.method, event.params);
        early.length = 0;
        phase = "response";
        result = await deadline.wait(finished);
        deadline.check();
        previousUsage = latestUsage;
        interrupt = undefined;
      }
    } catch (error) {
      const code = error instanceof RestrictedCodexStop ? error.code : "codex_process_failed";
      result = { ...restrictedCodexFailure(code === "codex_cleanup_failed" ? code : deadline.code ?? code, dispatched, usage), failurePhase: phase };
    } finally {
      pendingUsage = undefined;
      deadline.close();
      activeDeadline = undefined;
      if (transport) transport.onNotification = () => undefined;
      if (transport) transport.onRequest = undefined;
      if (transport) transport.onRequestComplete = undefined;
      if (result.errorCode !== null) {
        if (result.errorCode === "codex_cleanup_failed") cleanupTrusted = false;
        if (!await dispose()) result = { ...restrictedCodexFailure("codex_cleanup_failed", dispatched, usage), failurePhase: "cleanup" };
      }
    }
    return result.errorCode !== null && result.failurePhase === undefined ? { ...result, failurePhase: phase } : result;
  }

  return {
    get pendingUsage() { return pendingUsage; },
    get resolvedModel() { return resolvedModel; },
    get authentication() { return authentication; },
    run(request, readinessOnly = false) {
      const error = restrictedCodexRequestError(request, operatorAuth);
      if (error) return Promise.resolve(restrictedCodexFailure(error));
      if (!validParticipant(participant)) return Promise.resolve(restrictedCodexFailure("invalid_request"));
      if (closed || (identity && (identity.requestedModel !== request.model || identity.instructions !== request.instructions)))
        return Promise.resolve(restrictedCodexFailure("invalid_request"));
      if (pending || unclosedChildren.size) return Promise.resolve(restrictedCodexFailure("codex_busy"));
      const supportedPlatform = operatorAuth ? restrictedCodexNpmTarget(platform, arch) !== undefined
        : (platform === "linux" && arch === "x64") || (platform === "darwin" && arch === "arm64");
      if (!supportedPlatform)
        return Promise.resolve(restrictedCodexFailure("codex_unsupported_platform"));
      const task = execute(request, readinessOnly);
      pending = task;
      void task.finally(() => { if (pending === task) pending = undefined; }).catch(() => undefined);
      return task;
    },
    close() {
      closed = true;
      activeDeadline?.stop("cancelled");
      return closing ??= (async () => { await pending; return dispose(); })();
    }
  };
}

export async function checkRestrictedCodexSessionReadiness(input: { signal?: AbortSignal; timeoutMs?: number } = {},
  options: RestrictedCodexSessionOptions = {}): Promise<RestrictedCodexResult> {
  return runRestrictedCodexSession({ model: RESTRICTED_CODEX_ANALYSIS_MODELS[0], instructions: "Analyze only supplied study evidence.",
    evidence: "", images: [], schema: { type: "object", additionalProperties: false, properties: {} }, maxOutputTokens: null,
    timeoutMs: input.timeoutMs ?? 15_000, ...(input.signal === undefined ? {} : { signal: input.signal }) }, options, true);
}
