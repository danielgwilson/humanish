import type { ReasoningEffort } from "../reasoning-effort.js";

/** Versioned, deliberately narrow profile qualified with an account-backed vision turn.
 * The CLI still advertises code-mode tools: disabling their host is the enforcement
 * boundary. Feature names alone are not proof that a tool has been removed. Which CLI
 * releases launch is decided in codex-admission.ts. */
export const RESTRICTED_CODEX_ANALYSIS_IDENTITY = {
  provider: "codex",
  authMode: "chatgpt",
  modelProvider: "openai",
  toolPolicy: "restricted-codex-v1",
  reasoningEffort: "low",
} as const;
export const RESTRICTED_CODEX_ANALYSIS_MODELS = ["gpt-6-astra"] as const;

export type RestrictedCodexAnalysisErrorCode =
  | "invalid_request"
  | "cancelled"
  | "timeout"
  | "response_too_large"
  | "invalid_response"
  | "refusal"
  | "output_incomplete"
  | "codex_unavailable"
  | "codex_unsupported_version"
  | "codex_incompatible_release"
  | "codex_unsupported_platform"
  | "codex_login_required"
  | "codex_unsupported_auth"
  | "codex_unsafe_configuration"
  | "codex_model_unavailable"
  | "codex_protocol_error"
  | "codex_tool_call"
  | "codex_process_failed"
  | "codex_cleanup_failed"
  | "codex_busy";

export interface RestrictedCodexRequest {
  model?: string | undefined;
  instructions: string;
  evidence: string;
  images: { evidenceId: string; dataUrl: string }[];
  schema: Record<string, unknown>;
  maxOutputTokens: number | null;
  timeoutMs: number;
  signal?: AbortSignal;
}
export interface RestrictedCodexUsage {
  input: number;
  output: number;
  cachedInput?: number;
  cacheWriteInput?: number;
}
export interface RestrictedCodexResult {
  failurePhase?: import("../computer-use/provider-error.js").CuaProviderFailurePhase;
  status: "completed" | "incomplete" | "refused" | "failed" | "cancelled" | "timed_out";
  output: unknown;
  usage: RestrictedCodexUsage | null;
  inferenceUsage?: RestrictedCodexUsage[];
  usageComplete: boolean;
  dispatched: boolean;
  errorCode: RestrictedCodexAnalysisErrorCode | null;
  /** Notification methods this humanish does not know that carried no item, by count. */
  unknownNotifications?: Readonly<Record<string, number>>;
  /** How the release's app-server schema differs from the fields humanish reads (protocol-compat). */
  protocolIncompatibilities?: readonly string[];
  /** Schema values beyond the baseline humanish knows; recorded, and the launch continued. */
  protocolAdditions?: readonly string[];
  /** Bytes of a last frame cut off when humanish stopped the app-server. */
  truncatedFrameBytes?: number;
}

export const CODEX_MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const CODEX_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const CODEX_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
export const CODEX_MAX_EVENTS = 65_536;
export const CODEX_IMAGE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

export const codexRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const empty = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  (typeof value === "object" && Object.keys(value).length === 0);
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1e12;

const disabledFeatures = [
  "apps",
  "plugins",
  "hooks",
  "shell_tool",
  "shell_snapshot",
  "view_image",
  "image_generation",
  "skill_search",
  "skill_mcp_dependency_install",
  "multi_agent",
  "multi_agent_v2",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "memories",
  "external_agent_memory_import",
  "goals",
  "sleep_tool",
  "tool_suggest",
  "default_mode_request_user_input",
  "unbounded_connection_retries",
  "workspace_dependencies",
  "remote_plugin",
  "recommended_plugins",
  "in_app_local_automation",
] as const;
const codeModeFeatures = ["code_mode", "code_mode_host", "code_mode_only"] as const;

export interface RestrictedCodexConfigMode {
  participantCodeMode?: boolean;
  reasoningEffort?: ReasoningEffort;
  operatorAuth?: boolean;
}

export function restrictedCodexConfig(
  model: string | undefined,
  mode: RestrictedCodexConfigMode = {},
): {
  toml: string;
  overrides: Record<string, unknown>;
} {
  const reasoningEffort = mode.reasoningEffort ?? "low",
    codeMode = mode.participantCodeMode === true;
  const overrides: Record<string, unknown> = {
    model_provider: "openai",
    model_reasoning_effort: reasoningEffort,
    approval_policy: "never",
    sandbox_mode: "read-only",
    project_doc_max_bytes: 0,
    web_search: "disabled",
    "history.persistence": "none",
    "analytics.enabled": false,
    "features.skip_host_skill_discovery": true,
    "skills.bundled.enabled": false,
    "agents.enabled": false,
    "agents.max_threads": 1,
    "agents.max_depth": 1,
  };
  if (model !== undefined) overrides.model = model;
  if (!mode.operatorAuth) overrides.forced_login_method = "chatgpt";
  for (const name of disabledFeatures) overrides[`features.${name}`] = false;
  for (const name of codeModeFeatures) overrides[`features.${name}`] = codeMode;
  const toml = `${model === undefined ? "" : `model = ${JSON.stringify(model)}\n`}model_provider = "openai"
model_reasoning_effort = ${JSON.stringify(reasoningEffort)}
approval_policy = "never"
sandbox_mode = "read-only"
${mode.operatorAuth ? "" : 'forced_login_method = "chatgpt"\n'}project_doc_max_bytes = 0
web_search = "disabled"
[history]
persistence = "none"
[analytics]
enabled = false
[features]
skip_host_skill_discovery = true
${disabledFeatures.map((name) => `${name} = false`).join("\n")}
${codeModeFeatures.map((name) => `${name} = ${codeMode}`).join("\n")}
[skills.bundled]
enabled = false
[agents]
enabled = false
max_threads = 1
max_depth = 1
`;
  return { toml, overrides };
}

/**
 * Inspect before thread/start, which could otherwise start inherited integrations. Returns the
 * first setting that does not match, named by its config key and never by its value, or null.
 */
export function restrictedCodexConfigViolation(
  raw: unknown,
  configPath: string,
  model: string | undefined,
  mode: RestrictedCodexConfigMode = {},
): string | null {
  const root = codexRecord(raw),
    config = codexRecord(root.config),
    features = codexRecord(config.features);
  if (!Array.isArray(root.layers) || root.layers.length === 0)
    return "config/read reported no config layers";
  if (!mode.operatorAuth) {
    let ownLayer = false;
    for (const rawLayer of root.layers) {
      const layer = codexRecord(rawLayer),
        name = codexRecord(layer.name);
      if (
        name.type === "user" &&
        name.file === configPath &&
        name.profile === null &&
        (layer.disabledReason === null || layer.disabledReason === undefined)
      ) {
        if (ownLayer) return "humanish's config layer appears twice";
        ownLayer = true;
      } else if (name.type !== "system" || !empty(layer.config))
        return `a ${String(name.type)} config layer is active`;
    }
    if (!ownLayer) return "humanish's config layer is missing";
  }
  const reasoningEffort = mode.reasoningEffort ?? "low",
    codeMode = mode.participantCodeMode === true;
  const inheritedModel = config.model;
  const modelAdmitted =
    model === undefined && mode.operatorAuth
      ? inheritedModel === undefined ||
        inheritedModel === null ||
        (typeof inheritedModel === "string" &&
          inheritedModel.length > 0 &&
          inheritedModel.length <= 200)
      : inheritedModel === model;
  const agents = codexRecord(config.agents),
    skills = codexRecord(config.skills);
  const pinned: [string, boolean][] = [
    ["model", modelAdmitted],
    ["model_provider", config.model_provider === "openai"],
    ["model_reasoning_effort", config.model_reasoning_effort === reasoningEffort],
    ["forced_login_method", mode.operatorAuth === true || config.forced_login_method === "chatgpt"],
    ["sandbox_mode", config.sandbox_mode === "read-only"],
    ["approval_policy", config.approval_policy === "never"],
    ["project_doc_max_bytes", config.project_doc_max_bytes === 0],
    ["web_search", config.web_search === "disabled"],
    ["features.skip_host_skill_discovery", features.skip_host_skill_discovery === true],
    ["history.persistence", codexRecord(config.history).persistence === "none"],
    ["analytics.enabled", codexRecord(config.analytics).enabled === false],
    ...disabledFeatures.map((name): [string, boolean] => [
      `features.${name}`,
      features[name] === false,
    ]),
    ...codeModeFeatures.map((name): [string, boolean] => [
      `features.${name}`,
      features[name] === codeMode,
    ]),
    ["agents.enabled", agents.enabled === false],
    ["agents.max_threads", agents.max_concurrent_threads_per_session === 1],
    ["agents.max_depth", agents.max_depth === 1],
    ["skills.bundled.enabled", codexRecord(skills.bundled).enabled === false],
  ];
  const mismatch = pinned.find(([, ok]) => !ok)?.[0];
  if (mismatch !== undefined) return `${mismatch} is not the value humanish sets`;
  const extraSkills = Object.keys(skills).find((key) => key !== "bundled");
  if (extraSkills !== undefined) return `skills.${extraSkills} is set`;
  if (!mode.operatorAuth) {
    const inherited = isolatedUnsetKeys.find((key) => !empty(config[key]));
    if (inherited !== undefined) return `${inherited} is set`;
    if (Object.values(codexRecord(config.shell_environment_policy)).some((value) => !empty(value)))
      return "shell_environment_policy is set";
    if (config.cli_auth_credentials_store !== "file")
      return "cli_auth_credentials_store is not file";
    if (config.chatgpt_base_url !== "https://chatgpt.com/backend-api/")
      return "chatgpt_base_url is not the ChatGPT backend";
  }
  return null;
}

/** Settings an isolated launch requires to be unset: each could add tools, instructions or egress. */
const isolatedUnsetKeys = [
  "mcp_servers",
  "plugins",
  "hooks",
  "notify",
  "instructions",
  "developer_instructions",
  "permissions",
  "profiles",
  "projects",
  "model_providers",
  "experimental_compact_prompt_file",
  "experimental_model_instructions_file",
  "model_instructions_file",
  "model_catalog_json",
  "openai_base_url",
  "orchestrator",
  "experimental_thread_store",
  "experimental_thread_store_endpoint",
  "experimental_realtime_ws_base_url",
  "experimental_realtime_webrtc_call_base_url",
  "forced_chatgpt_workspace_id",
  "log_dir",
  "sqlite_home",
  "otel",
  "marketplaces",
  "js_repl_node_path",
  "js_repl_node_module_dirs",
  "responses_api_metadata",
  "compact_prompt",
  "profile",
  "default_permissions",
  "auto_review",
  "apps",
  "browser_use",
  "computer_use",
  "desktop",
  "memories",
  "realtime",
] as const;

export function admitsRestrictedCodexThread(
  raw: unknown,
  model: string,
  cwd: string,
  reasoningEffort: ReasoningEffort,
  cliVersion: string,
): boolean {
  const value = codexRecord(raw),
    thread = codexRecord(value.thread),
    sandbox = codexRecord(value.sandbox);
  return (
    typeof thread.id === "string" &&
    thread.id.length > 0 &&
    thread.id.length <= 200 &&
    thread.ephemeral === true &&
    thread.model === model &&
    thread.modelProvider === "openai" &&
    thread.reasoningEffort === reasoningEffort &&
    thread.cliVersion === cliVersion &&
    Array.isArray(thread.environments) &&
    thread.environments.length === 0 &&
    thread.path === null &&
    value.model === model &&
    value.modelProvider === "openai" &&
    value.reasoningEffort === reasoningEffort &&
    value.cwd === cwd &&
    thread.cwd === cwd &&
    value.approvalPolicy === "never" &&
    sandbox.type === "readOnly" &&
    sandbox.networkAccess === false &&
    Array.isArray(value.instructionSources) &&
    value.instructionSources.length === 0 &&
    Array.isArray(value.runtimeWorkspaceRoots) &&
    value.runtimeWorkspaceRoots.length === 0
  );
}

export function restrictedCodexRequestError(
  request: RestrictedCodexRequest,
  operatorParticipant = false,
): RestrictedCodexAnalysisErrorCode | null {
  if (request.signal?.aborted) return "cancelled";
  if (operatorParticipant) {
    if (
      request.model !== undefined &&
      (typeof request.model !== "string" ||
        request.model.length === 0 ||
        request.model.length > 200)
    )
      return "codex_model_unavailable";
  } else if (!RESTRICTED_CODEX_ANALYSIS_MODELS.some((model) => model === request.model))
    return "codex_model_unavailable";
  if (
    request.maxOutputTokens !== null ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    request.timeoutMs > 600_000 ||
    typeof request.instructions !== "string" ||
    typeof request.evidence !== "string" ||
    !Array.isArray(request.images) ||
    request.images.length > 128 ||
    !request.schema ||
    typeof request.schema !== "object" ||
    Array.isArray(request.schema)
  )
    return "invalid_request";
  try {
    if (
      new TextEncoder().encode(
        JSON.stringify({
          instructions: request.instructions,
          evidence: request.evidence,
          images: request.images,
          schema: request.schema,
        }),
      ).byteLength > CODEX_MAX_REQUEST_BYTES
    )
      return "invalid_request";
    let imageBytes = 0;
    for (const image of request.images) {
      if (
        typeof image.evidenceId !== "string" ||
        image.evidenceId.length === 0 ||
        image.evidenceId.length > 300 ||
        typeof image.dataUrl !== "string"
      )
        return "invalid_request";
      const match = CODEX_IMAGE.exec(image.dataUrl);
      if (!match) return "invalid_request";
      const decoded = atob(match[2]!);
      imageBytes += decoded.length;
      if (btoa(decoded) !== match[2] || imageBytes > 20 * 1024 * 1024) return "invalid_request";
    }
    return null;
  } catch {
    return "invalid_request";
  }
}

export function restrictedCodexUsage(raw: unknown): RestrictedCodexUsage | null {
  const total = codexRecord(codexRecord(raw).total);
  const input = total.inputTokens,
    output = total.outputTokens,
    cachedInput = total.cachedInputTokens,
    cacheWriteInput = total.cacheWriteInputTokens;
  if (
    !count(input) ||
    !count(output) ||
    !count(cachedInput) ||
    !count(cacheWriteInput) ||
    cachedInput + cacheWriteInput > input
  )
    return null;
  return { input, output, cachedInput, cacheWriteInput };
}

export function restrictedCodexFailure(
  errorCode: RestrictedCodexAnalysisErrorCode,
  dispatched = false,
  usage: RestrictedCodexUsage | null = null,
): RestrictedCodexResult {
  return {
    status:
      errorCode === "cancelled"
        ? "cancelled"
        : errorCode === "timeout"
          ? "timed_out"
          : errorCode === "refusal"
            ? "refused"
            : errorCode === "output_incomplete"
              ? "incomplete"
              : "failed",
    output: null,
    usage,
    usageComplete: false,
    dispatched,
    errorCode,
  };
}

/**
 * The tool policy each app-server event must pass: raw items of an allowed type only, `exec` as
 * the only custom tool, `wait` as the only function, and no agent message that delivers
 * asynchronously or asks the user a question. True means the request stops with codex_tool_call.
 */
export function toolPolicyViolation(
  method: string,
  item: Record<string, unknown>,
  allowedRawItemTypes: readonly string[],
): boolean {
  if (method === "rawResponseItem/completed")
    return (
      !allowedRawItemTypes.includes(String(item.type)) ||
      (item.type === "custom_tool_call" && item.name !== "exec") ||
      (item.type === "function_call" && item.name !== "wait")
    );
  if (method === "item/started" || method === "item/completed")
    return (
      item.type === "agentMessage" &&
      (item.delivery === "async" || (Array.isArray(item.questions) && item.questions.length > 0))
    );
  return false;
}
