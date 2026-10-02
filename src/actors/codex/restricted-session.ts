import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { CuaProviderFailurePhase } from "../computer-use/provider-error.js";
import type { ReasoningEffort } from "../reasoning-effort.js";
import { admittedCodexCliVersions } from "./qualified-versions.js";
import {
  launchAdmittedAppServer,
  type LaunchSettings,
  type LaunchState,
} from "./restricted-launch.js";
import {
  CODEX_IMAGE,
  CODEX_MAX_OUTPUT_BYTES,
  CODEX_MAX_REQUEST_BYTES,
  RESTRICTED_CODEX_ANALYSIS_MODELS,
  codexRecord,
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
  hasUnclosedChildren,
  retainUnclosedChild,
  type RestrictedCodexSpawn,
} from "./restricted-transport.js";
import {
  checkVersion,
  childEnvironment,
  resolveExecutable,
  restrictedCodexNpmTarget,
} from "./restricted-executable.js";
import { RestrictedCodexTurn } from "./restricted-turn.js";
import {
  closingNotifications,
  countUnknownNotification,
  detachTurn,
  idleNotifications,
  noteUnreported,
  notificationPolicyOf,
  refuseSession,
} from "./restricted-notifications.js";

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

/** Analysts/readiness keep their one-shot lifetime; participants own a session. */
export async function runRestrictedCodexSession(
  request: RestrictedCodexRequest,
  options: RestrictedCodexSessionOptions = {},
  readinessOnly = false,
): Promise<RestrictedCodexResult> {
  const session = createRestrictedCodexSession(options);
  const result = await session.run(request, readinessOnly);
  const closed = await session.close();
  const unknownNotifications = session.unknownNotifications ?? {};
  const noted = Object.keys(unknownNotifications).length === 0 ? {} : { unknownNotifications };
  if (!closed)
    return {
      ...restrictedCodexFailure("codex_cleanup_failed", result.dispatched, result.usage),
      failurePhase: "cleanup",
      ...noted,
    };
  // A disallowed item while the app-server shut down fails a request that had completed.
  const refusal = session.unreportedRefusal;
  return refusal !== undefined && result.errorCode === null
    ? { ...restrictedCodexFailure(refusal, result.dispatched, result.usage), ...noted }
    : { ...result, ...noted };
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
/**
 * Receipt: a participant's known usage lists each inference. Every failed result already names its
 * phase (failedRequest, or "cleanup" for an unconfirmed teardown).
 */
function withInferenceUsage(
  result: RestrictedCodexResult,
  turn: RestrictedCodexTurn | undefined,
  participant: boolean,
): RestrictedCodexResult {
  let receipt = result;
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
  /** Notification methods this humanish does not know that carried no item, by count. */
  readonly unknownNotifications?: Readonly<Record<string, number>>;
  /**
   * A policy refusal no request reported: between requests, while closing, or after the request
   * stopped for another reason. A participant's close fails the run with it.
   */
  readonly unreportedRefusal?: RestrictedCodexAnalysisErrorCode | undefined;
  run(request: RestrictedCodexRequest, readinessOnly?: boolean): Promise<RestrictedCodexResult>;
  close(): Promise<boolean>;
}

/** What a session reads and never changes once it is created. */
interface SessionSettings extends LaunchSettings {
  readonly options: RestrictedCodexSessionOptions;
  readonly arch: string;
  readonly participant: RestrictedCodexSessionOptions["participant"];
}

/**
 * What changes after a session is created and more than one of its functions reads: what the
 * launch records (LaunchState, restricted-launch.ts), and what each request carries forward.
 */
interface SessionState extends LaunchState {
  /** What the last completed turn reported, the next turn's usage baseline (request to request). */
  previousUsage: RestrictedCodexUsage | null;
  /** Tool-call ids already answered, carried across turns (each request's turn). */
  toolCallIds: Set<string>;
  /** The request in flight's usage so far (its turn; the session's getters). */
  pendingUsage: RestrictedCodexUsage | undefined;
  pendingInferenceUsage: RestrictedCodexUsage[] | undefined;
  /** The request in flight's deadline (each request; close stops it). */
  activeDeadline: RestrictedCodexDeadline | undefined;
  /** The started turn teardown interrupts (each request; teardown). */
  interrupt: { threadId: string; turnId: string } | undefined;
  /** Set by close and teardown; admission refuses every later request. */
  closed: boolean;
  /** False once a request reported codex_cleanup_failed (each request; teardown). */
  cleanupTrusted: boolean;
  /** A policy refusal no request reported (noteUnreported); a request that fails with it clears it. */
  unreportedRefusal: RestrictedCodexAnalysisErrorCode | undefined;
}

/** Teardown: close the app-server, unlink the auth link and remove the task directory. */
async function disposeSession(settings: SessionSettings, state: SessionState): Promise<boolean> {
  // Each field is read at its use, after the awaits before it, as the session always has.
  let cleaned = state.cleanupTrusted;
  if (state.transport) {
    state.transport.onClosingNotification = closingNotifications(settings.participant, state);
    cleaned = (await state.transport.close(state.interrupt).catch(() => false)) && cleaned;
    if (!cleaned) retainUnclosedChild(state.transport!.owned.closed);
  }
  let authReplaced = false;
  if (state.authLink && cleaned) {
    try {
      authReplaced = !(await lstat(state.authLink)).isSymbolicLink();
      if (!authReplaced) await unlink(state.authLink!);
    } catch (error) {
      if (codexRecord(error).code !== "ENOENT") cleaned = false;
    }
  }
  // Preserve unexpected login rotation for private recovery, never overwrite host auth.
  if (authReplaced) {
    cleaned = false;
    if (state.work)
      await preserveUnexpectedAuth(state.work, settings.sourceEnv).catch(() => undefined);
  }
  if (state.work && cleaned)
    await rm(state.work, { recursive: true, force: true }).catch(() => {
      cleaned = false;
    });
  if (state.work && !cleaned && !authReplaced)
    await writeRecoveryMarker(state.work, settings.sourceEnv, "process_cleanup_unconfirmed").catch(
      () => undefined,
    );
  return cleaned;
}

/** Turn dispatch: the turn/start request for the evidence and image input. */
function turnStartParams(
  settings: SessionSettings,
  state: SessionState,
  request: RestrictedCodexRequest,
  input: Record<string, unknown>[],
  model: string,
): Record<string, unknown> {
  return {
    threadId: state.threadId,
    cwd: state.cwd,
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly" },
    environments: [],
    runtimeWorkspaceRoots: [],
    effort: settings.reasoningEffort,
    model,
    outputSchema: request.schema,
    input,
  };
}

/** The request's turn: it reports usage to the session's getters and records the started turn. */
function newTurn(
  settings: SessionSettings,
  state: SessionState,
  deadline: RestrictedCodexDeadline,
): RestrictedCodexTurn {
  const participant = settings.participant;
  return new RestrictedCodexTurn({
    deadline,
    threadId: () => state.threadId,
    participant: participant !== undefined,
    tool: () => participant!.tool,
    usageBaseline: state.previousUsage,
    toolCallIds: state.toolCallIds,
    reportUsage: (usage, inference) => {
      state.pendingUsage = usage;
      state.pendingInferenceUsage = inference;
    },
    turnStarted: (turnId) => {
      state.interrupt = { threadId: state.threadId!, turnId };
    },
    policy: notificationPolicyOf(participant),
    idle: (method, params) => idleNotifications(participant, state)(method, params),
    recordUnknown: (method) => countUnknownNotification(state.unknownNotifications, method),
    refuse: (code) => refuseSession(state, code),
  });
}

/** Request dispatch: launch on the first request, then one turn; a failed request tears down. */
async function runTurn(
  settings: SessionSettings,
  state: SessionState,
  dispose: () => Promise<boolean>,
  request: RestrictedCodexRequest,
  readinessOnly: boolean,
): Promise<RestrictedCodexResult> {
  const participant = settings.participant;
  const deadline = new RestrictedCodexDeadline(request.timeoutMs, request.signal);
  state.activeDeadline = deadline;
  let turn: RestrictedCodexTurn | undefined;
  let result: RestrictedCodexResult = restrictedCodexFailure("codex_process_failed");
  let phase: CuaProviderFailurePhase = "startup";
  try {
    turn = newTurn(settings, state, deadline);
    state.pendingUsage = undefined;
    deadline.check();
    const frameLimit = requestFrameLimit(request, participant !== undefined);
    let selectedModel = state.identity?.model;
    if (!state.transport) {
      state.transport = await launchAdmittedAppServer(
        settings,
        state,
        request,
        deadline,
        frameLimit,
        (next) => {
          phase = next;
        },
        idleNotifications(participant, state),
      );
      state.transport.onUninspected = (code) => noteUnreported(state, code);
      selectedModel = state.identity!.model;
    } else state.transport.beginRequest(deadline, frameLimit);
    // Before dispatch the turn passes notifications to the idle handler the launch installed,
    // and onRequestComplete follows only a host callback, so wiring both here loses nothing.
    state.transport!.onNotification = turn.onNotification;
    state.transport!.onRequestComplete = turn.onRequestComplete;
    if (readinessOnly) result = readinessResult();
    else {
      phase = "turn/start";
      if (participant) state.transport!.onRequest = turn.onRequest;
      const input: Record<string, unknown>[] = [
        { type: "text", text: request.evidence, text_elements: [] },
        ...(await writeEvidenceImages(state.scratch, request.images, deadline)),
      ];
      deadline.check();
      // Even a lost acknowledgment may have dispatched the request. Never claim zero cost.
      turn.dispatched = true;
      const reply = await state.transport!.rpc(
        "turn/start",
        turnStartParams(settings, state, request, input, selectedModel!),
      );
      // acknowledge() and deadline.wait() run in one microtask, so a completion delivered with
      // the acknowledgment wins over a stop queued close behind it.
      turn.acknowledge(codexRecord(reply.turn).id);
      phase = "response";
      result = await deadline.wait(turn.finished);
      deadline.check();
      state.previousUsage = turn.latestUsage;
      state.interrupt = undefined;
    }
  } catch (error) {
    result = failedRequest(error, deadline, turn, phase);
  } finally {
    state.pendingUsage = undefined;
    state.pendingInferenceUsage = undefined;
    deadline.close();
    state.activeDeadline = undefined;
    detachTurn(participant, state);
    if (result.errorCode !== null) {
      if (result.errorCode === "codex_cleanup_failed") state.cleanupTrusted = false;
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
    // This request reported the refusal it failed with; a cleanup failure replaced it, so not then.
    if (result.errorCode !== null && result.errorCode === state.unreportedRefusal)
      state.unreportedRefusal = undefined;
  }
  return withInferenceUsage(result, turn, participant !== undefined);
}

/** Admission: the refusal a request gets before anything runs, in this order, or none. */
function refusedRun(
  settings: SessionSettings,
  state: SessionState,
  request: RestrictedCodexRequest,
  busy: () => boolean,
): RestrictedCodexResult | undefined {
  const { operatorAuth, platform, arch } = settings;
  const error = restrictedCodexRequestError(request, operatorAuth);
  if (error) return restrictedCodexFailure(error);
  if (!validParticipant(settings.participant)) return restrictedCodexFailure("invalid_request");
  const identity = state.identity;
  if (
    state.closed ||
    (identity &&
      (identity.requestedModel !== request.model || identity.instructions !== request.instructions))
  )
    return restrictedCodexFailure("invalid_request");
  if (busy() || hasUnclosedChildren()) return restrictedCodexFailure("codex_busy");
  const supportedPlatform = operatorAuth
    ? restrictedCodexNpmTarget(platform, arch) !== undefined
    : (platform === "linux" && arch === "x64") || (platform === "darwin" && arch === "arm64");
  if (!supportedPlatform) return restrictedCodexFailure("codex_unsupported_platform");
  return undefined;
}

export function createRestrictedCodexSession(
  options: RestrictedCodexSessionOptions = {},
): RestrictedCodexSession {
  // Option reads keep their old order: platform, arch, env, participant, spawnFn, cliVersions.
  const platform = options.platform ?? process.platform,
    arch = options.arch ?? process.arch;
  const sourceEnv = options.env ?? process.env;
  const participant = options.participant;
  const settings: SessionSettings = {
    options,
    platform,
    arch,
    sourceEnv,
    participant,
    operatorAuth: participant?.authMode === "operator",
    reasoningEffort: participant?.reasoningEffort ?? "low",
    spawnFn: options.spawnFn ?? ((file, args, spawnOptions) => spawn(file, args, spawnOptions)),
    admittedVersions: options.cliVersions ?? admittedCodexCliVersions(platform, arch),
  };
  const state: SessionState = {
    work: undefined,
    authLink: undefined,
    transport: undefined,
    threadId: undefined,
    cwd: "",
    scratch: "",
    identity: undefined,
    previousUsage: { input: 0, output: 0, cachedInput: 0, cacheWriteInput: 0 },
    toolCallIds: new Set<string>(),
    pendingUsage: undefined,
    pendingInferenceUsage: undefined,
    resolvedModel: undefined,
    authentication: undefined,
    cliVersion: undefined,
    unknownNotifications: new Map<string, number>(),
    activeDeadline: undefined,
    interrupt: undefined,
    closed: false,
    cleanupTrusted: true,
    unreportedRefusal: undefined,
  };
  let pending: Promise<RestrictedCodexResult> | undefined,
    closing: Promise<boolean> | undefined,
    disposing: Promise<boolean> | undefined;
  const dispose = (): Promise<boolean> => {
    state.closed = true;
    return (disposing ??= disposeSession(settings, state));
  };

  return {
    get pendingUsage() {
      return state.pendingUsage;
    },
    get pendingInferenceUsage() {
      return state.pendingInferenceUsage?.map((item) => ({ ...item }));
    },
    get resolvedModel() {
      return state.resolvedModel;
    },
    get authentication() {
      return state.authentication;
    },
    get cliVersion() {
      return state.cliVersion;
    },
    get unknownNotifications() {
      return Object.fromEntries(state.unknownNotifications);
    },
    get unreportedRefusal() {
      return state.unreportedRefusal;
    },
    run(request, readinessOnly = false) {
      const refusal = refusedRun(settings, state, request, () => pending !== undefined);
      if (refusal) return Promise.resolve(refusal);
      const task = runTurn(settings, state, dispose, request, readinessOnly);
      pending = task;
      void task
        .finally(() => {
          if (pending === task) pending = undefined;
        })
        .catch(() => undefined);
      return task;
    },
    close() {
      state.closed = true;
      state.activeDeadline?.stop("cancelled");
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
  | { cliVersion: string; errorCode: null; detectedVersion?: never }
  | {
      cliVersion: null;
      errorCode: RestrictedCodexAnalysisErrorCode;
      /** The release an unadmitted CLI reported, when it reported one. */
      detectedVersion?: string;
    }
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
    const detectedVersion =
      error instanceof RestrictedCodexStop ? error.detectedVersion : undefined;
    return {
      cliVersion: null,
      errorCode:
        error instanceof RestrictedCodexStop
          ? error.code
          : (deadline.code ?? "codex_process_failed"),
      ...(detectedVersion === undefined ? {} : { detectedVersion }),
    };
  } finally {
    deadline.close();
    if (work) await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
