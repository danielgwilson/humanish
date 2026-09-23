import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { CODEX_IMAGE, CODEX_MAX_OUTPUT_BYTES, RESTRICTED_CODEX_ANALYSIS_IDENTITY, RESTRICTED_CODEX_ANALYSIS_MODELS,
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
}

function childEnvironment(source: NodeJS.ProcessEnv, home: string, scratch: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { HOME: home, CODEX_HOME: home, TMPDIR: scratch };
  for (const key of ["PATH", "LANG", "USER", "LOGNAME"])
    if (typeof source[key] === "string") result[key] = source[key];
  return result;
}

async function isNativeExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(4);
      const read = await handle.read(buffer, 0, 4, 0);
      return read.bytesRead === 4 && buffer.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    } finally { await handle.close(); }
  } catch { return false; }
}

/** Resolve PATH without running a shell. The npm launcher is resolved to its
 * native optional package so cleanup owns the real app-server child. */
async function resolveExecutable(options: RestrictedCodexSessionOptions, env: NodeJS.ProcessEnv): Promise<string> {
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
  if (await isNativeExecutable(resolved)) return resolved;
  if (path.basename(resolved) === "codex.js" && path.basename(path.dirname(resolved)) === "bin") {
    const packageRoot = path.dirname(path.dirname(resolved));
    const triple = "x86_64-unknown-linux-musl";
    for (const candidate of [path.join(packageRoot, "node_modules", "@openai", "codex-linux-x64", "vendor", triple, "bin", "codex"),
      path.join(packageRoot, "vendor", triple, "bin", "codex")]) {
      if (await isNativeExecutable(candidate)) return realpath(candidate);
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

type Event = { method: string; params: Record<string, unknown> };
let activeSession = false;
let unclosedChild = false;
function retainUnclosedChild(closed: Promise<void>): void {
  unclosedChild = true;
  void closed.then(() => { unclosedChild = false; });
}

/** The gate covers all factories and readiness checks in this process. It does not
 * promise to serialize unrelated Codex applications using the same host login. */
export async function runRestrictedCodexSession(request: RestrictedCodexRequest,
  options: RestrictedCodexSessionOptions = {}, readinessOnly = false): Promise<RestrictedCodexResult> {
  const error = restrictedCodexRequestError(request);
  if (error) return restrictedCodexFailure(error);
  if (activeSession || unclosedChild) return restrictedCodexFailure("codex_busy");
  activeSession = true;
  try { return await executeRestrictedCodexSession(request, options, readinessOnly); }
  finally { activeSession = false; }
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

/** Exactly one fresh thread/turn; private host auth, no participant state reuse. */
async function executeRestrictedCodexSession(request: RestrictedCodexRequest,
  options: RestrictedCodexSessionOptions = {}, readinessOnly = false): Promise<RestrictedCodexResult> {
  const admissionError = restrictedCodexRequestError(request);
  if (admissionError) return restrictedCodexFailure(admissionError);
  if ((options.platform ?? process.platform) !== "linux" || (options.arch ?? process.arch) !== "x64")
    return restrictedCodexFailure("codex_unsupported_platform");
  const deadline = new RestrictedCodexDeadline(request.timeoutMs, request.signal);
  const sourceEnv = options.env ?? process.env;
  const spawnFn: RestrictedCodexSpawn = options.spawnFn ?? ((file, args, settings) => spawn(file, args, settings));
  let work: string | undefined, authLink: string | undefined, transport: RestrictedCodexTransport | undefined;
  let threadId: string | undefined, turnId: string | undefined, earlyTurnId: string | undefined;
  let dispatched = false, completed = false, usage: RestrictedCodexUsage | null = null;
  let outputItem: { id: string; text: string } | undefined;
  let result: RestrictedCodexResult = restrictedCodexFailure("codex_process_failed");
  const early: Event[] = [];
  let resolveTurn!: (value: RestrictedCodexResult) => void;
  const finished = new Promise<RestrictedCodexResult>(resolve => { resolveTurn = resolve; });

  const handleTurnEvent = (method: string, params: Record<string, unknown>): void => {
    if (!hasScopedIdentity(method, params, threadId, turnId)) { deadline.stop("codex_protocol_error"); return; }
    const item = codexRecord(params.item);
    if (method === "rawResponseItem/completed") {
      if (!["message", "reasoning"].includes(String(item.type))) { deadline.stop("codex_tool_call"); return; }
      if (item.type === "message" && Array.isArray(item.content)
        && item.content.some(content => codexRecord(content).type === "refusal")) deadline.stop("refusal");
    }
    if (method === "thread/tokenUsage/updated") usage = restrictedCodexUsage(params.tokenUsage);
    if (method === "item/started" || method === "item/completed") {
      if (!["userMessage", "agentMessage", "reasoning"].includes(String(item.type))) { deadline.stop("codex_tool_call"); return; }
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
      if (turn.id !== turnId || completed) { deadline.stop("codex_protocol_error"); return; }
      completed = true;
      if (turn.status === "interrupted") { deadline.stop("cancelled"); return; }
      if (turn.status !== "completed" || turn.error !== null || !outputItem) { deadline.stop("invalid_response"); return; }
      try {
        resolveTurn({ status: "completed", output: JSON.parse(outputItem.text) as unknown, usage,
          usageComplete: usage !== null, dispatched: true, errorCode: null });
      } catch { deadline.stop("invalid_response"); }
    }
  };

  try {
    deadline.check();
    const file = await resolveExecutable(options, sourceEnv);
    deadline.check();
    work = await mkdtemp(path.join(options.tempRoot ?? tmpdir(), "humanish-codex-analysis-"));
    await chmod(work, 0o700);
    work = await realpath(work);
    const home = path.join(work, "home"), cwd = path.join(work, "cwd"), scratch = path.join(work, "scratch");
    for (const directory of [home, cwd, scratch]) await mkdir(directory, { mode: 0o700 });
    const env = childEnvironment(sourceEnv, home, scratch);
    await checkVersion(file, env, cwd, spawnFn, deadline);
    const config = restrictedCodexConfig(request.model), configPath = path.join(home, "config.toml");
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
    deadline.check();
    const owned = ownCodexProcess(spawnFn(file, ["app-server", "--strict-config"], {
      cwd, env, detached: false, stdio: ["pipe", "pipe", "pipe"]
    }));
    // Raw input notifications echo supplied image data. Bound that wire separately
    // from the 2 MiB generated report, without dropping admitted evidence.
    const frameLimit = Math.max(CODEX_MAX_OUTPUT_BYTES, Buffer.byteLength(JSON.stringify({ instructions: request.instructions,
      evidence: request.evidence, images: request.images, schema: request.schema })) + 1024 * 1024);
    transport = new RestrictedCodexTransport(owned, deadline, frameLimit);
    transport.onNotification = (method, params) => {
      if (!dispatched) return;
      if (!hasScopedIdentity(method, params, threadId, turnId ?? earlyTurnId)) { deadline.stop("codex_protocol_error"); return; }
      const item = codexRecord(params.item);
      // Tool requests must fail even if the turn-start acknowledgment is lost.
      if ((method === "rawResponseItem/completed" && !["message", "reasoning"].includes(String(item.type)))
        || (["item/started", "item/completed"].includes(method) && item.type === "agentMessage"
          && (item.delivery === "async" || (Array.isArray(item.questions) && item.questions.length > 0)))) {
        deadline.stop("codex_tool_call"); return;
      }
      if (method === "turn/started") {
        const value = codexRecord(params.turn).id;
        if (typeof value !== "string" || value.length === 0 || (earlyTurnId !== undefined && value !== earlyTurnId))
          deadline.stop("codex_protocol_error");
        else earlyTurnId = value;
      }
      if (turnId === undefined) early.push({ method, params });
      else handleTurnEvent(method, params);
    };
    const initialize = await transport.rpc("initialize", {
      clientInfo: { name: "humanish_analysis", version: "1.0.0" }, capabilities: { experimentalApi: true }
    });
    if (typeof initialize.userAgent !== "string" || !initialize.userAgent.includes(`/0.154.0 `)
      || initialize.codexHome !== home || initialize.platformOs !== "linux" || initialize.platformFamily !== "unix")
      throw new RestrictedCodexStop("codex_unsupported_version");
    transport.notify("initialized", {});
    const effective = await transport.rpc("config/read", { includeLayers: true, cwd });
    if (!admitsRestrictedCodexConfig(effective, configPath, request.model)) throw new RestrictedCodexStop("codex_unsafe_configuration");
    const account = await transport.rpc("account/read", { refreshToken: false });
    if (account.account === null) throw new RestrictedCodexStop("codex_login_required");
    if (codexRecord(account.account).type !== "chatgpt" || account.requiresOpenaiAuth !== true)
      throw new RestrictedCodexStop("codex_unsupported_auth");
    const thread = await transport.rpc("thread/start", { cwd, ephemeral: true, experimentalRawEvents: true,
      approvalPolicy: "never", sandbox: "read-only", model: request.model, modelProvider: "openai", allowProviderModelFallback: false,
      environments: [], runtimeWorkspaceRoots: [], dynamicTools: [], baseInstructions: request.instructions, config: config.overrides });
    if (!admitsRestrictedCodexThread(thread, request.model, cwd)) throw new RestrictedCodexStop("codex_unsafe_configuration");
    threadId = String(codexRecord(thread.thread).id);
    const mcp = await transport.rpc("mcpServerStatus/list", { limit: 100 });
    if (!Array.isArray(mcp.data) || mcp.data.length !== 0 || mcp.nextCursor !== null) throw new RestrictedCodexStop("codex_unsafe_configuration");
    if (readinessOnly) {
      result = { status: "completed", output: null, usage: null, usageComplete: false, dispatched: false, errorCode: null };
    } else {
      const input: Record<string, unknown>[] = [{ type: "text", text: request.evidence, text_elements: [] }];
      for (const [index, image] of request.images.entries()) {
        deadline.check();
        const match = CODEX_IMAGE.exec(image.dataUrl)!;
        const imagePath = path.join(scratch, `evidence-${index}.${match[1] === "jpeg" ? "jpg" : match[1]}`);
        await writeFile(imagePath, Buffer.from(match[2]!, "base64"), { mode: 0o600, flag: "wx" });
        input.push({ type: "text", text: JSON.stringify({ captureEvidenceId: image.evidenceId }), text_elements: [] }, { type: "localImage", path: imagePath });
      }
      deadline.check();
      // Even a lost acknowledgment may have dispatched the request. Never claim zero cost.
      dispatched = true;
      const turn = await transport.rpc("turn/start", { threadId, cwd, approvalPolicy: "never", sandboxPolicy: { type: "readOnly" },
        environments: [], runtimeWorkspaceRoots: [], effort: "low", model: request.model, outputSchema: request.schema, input });
      const returnedTurnId = codexRecord(turn.turn).id;
      if (typeof returnedTurnId !== "string" || returnedTurnId.length === 0 || returnedTurnId.length > 200
        || (earlyTurnId !== undefined && earlyTurnId !== returnedTurnId)) throw new RestrictedCodexStop("codex_protocol_error");
      turnId = returnedTurnId;
      for (const event of early) handleTurnEvent(event.method, event.params);
      early.length = 0;
      result = await deadline.wait(finished);
      deadline.check();
    }
  } catch (error) {
    result = restrictedCodexFailure(deadline.code ?? (error instanceof RestrictedCodexStop ? error.code : "codex_process_failed"), dispatched, usage);
  } finally {
    // Deadline remains authoritative until acceptance; teardown has its own small grace.
    deadline.close();
    let cleaned = !unclosedChild;
    if (transport) {
      const cleanupTurn = turnId ?? earlyTurnId;
      cleaned = await transport.close(dispatched && !completed && threadId && cleanupTurn
        ? { threadId, turnId: cleanupTurn } : undefined).catch(() => false);
      if (!cleaned) retainUnclosedChild(transport.owned.closed);
    }
    let authReplaced = false;
    if (authLink && cleaned) {
      try {
        const info = await lstat(authLink);
        authReplaced = !info.isSymbolicLink();
        if (!authReplaced) await unlink(authLink);
      } catch (error) {
        if (codexRecord(error).code !== "ENOENT") cleaned = false;
      }
    }
    // An unexpected replacement may contain rotated login state. Do not discard it
    // or overwrite the host login. Leave this private control-plane directory for
    // recovery and fail closed; no path or credential is included in the result.
    if (authReplaced) {
      cleaned = false;
      if (work) await preserveUnexpectedAuth(work, sourceEnv).catch(() => undefined);
    }
    if (work && cleaned && !authReplaced) await rm(work, { recursive: true, force: true }).catch(() => { cleaned = false; });
    if (work && unclosedChild) await writeRecoveryMarker(work, sourceEnv, "process_cleanup_unconfirmed").catch(() => undefined);
    if (!cleaned) result = restrictedCodexFailure("codex_cleanup_failed", dispatched, usage);
  }
  return result;
}

export async function checkRestrictedCodexSessionReadiness(input: { signal?: AbortSignal; timeoutMs?: number } = {},
  options: RestrictedCodexSessionOptions = {}): Promise<RestrictedCodexResult> {
  return runRestrictedCodexSession({ model: RESTRICTED_CODEX_ANALYSIS_MODELS[0], instructions: "Analyze only supplied study evidence.",
    evidence: "", images: [], schema: { type: "object", additionalProperties: false, properties: {} }, maxOutputTokens: null,
    timeoutMs: input.timeoutMs ?? 15_000, ...(input.signal === undefined ? {} : { signal: input.signal }) }, options, true);
}
