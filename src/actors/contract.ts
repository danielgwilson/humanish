import type { AffordanceUse } from "./affordance.js";
import type { ActorEstimatedCost } from "../run/pricing.js";
import type { TaskFunnel } from "../lab/tasks.js";
import {
  isCuaProviderFailurePhase,
  type CuaProviderFailurePhase,
} from "./computer-use/provider-error.js";

// The provider-neutral evidence schema. Codex item/* events, computer-use cycles,
// scripted browser steps and terminal-agent exec output all map onto this one
// ActorTrace. See docs/architecture/actor-contract.md.
//
// The schema maps the providers and routes implemented by the closed first-party
// registry. The broader Actor.run(input) and ApprovalPolicy contract remains
// design-only and is intentionally absent from these runtime types. RedactionHooks
// (src/evidence/redaction.ts) and ResolvedPersona (src/lab/persona.ts) ship in
// their own modules.

export const ACTOR_TRACE_SCHEMA = "humanish.actor-trace.v1";

/**
 * How a session ended, from the point of view of the STUDY rather than the harness.
 *
 * The distinction matters because two of these are participant outcomes and the rest are not. A
 * participant who abandons a task is the single most valuable thing a usability study produces, and
 * recording that as `failed` — as this type used to force — reads as the instrument breaking. See
 * docs/principles/three-roles.md.
 *
 * - `passed`      the participant reached the goal
 * - `abandoned`   the participant stopped trying. A FINDING, not a malfunction
 * - `incomplete`  the session ended (time or budget) before the goal was reached
 * - `blocked`     the participant could not proceed: an approval the run could not give, or a
 *                 blocker they described in their own final words (#476)
 * - `timed_out`   the session hit its deadline with no productive activity at all
 * - `failed`      the HARNESS failed: a dead sandbox, a provider error, a broken artifact
 */
export const ACTOR_STATUSES = [
  "passed",
  "abandoned",
  "incomplete",
  "blocked",
  "timed_out",
  "failed",
] as const;
export type ActorStatus = (typeof ACTOR_STATUSES)[number];

/**
 * What the PARTICIPANT said happened, in a field rather than a paragraph (#570). Providers whose
 * reply is schema-constrained (the local-agent routes) fill it on their final turn; a free-text
 * provider leaves it absent and the route falls back to reading the closing message. `reached`:
 * the task is finished. `blocked`: something in the app stopped the participant. `not_reached`:
 * the participant stopped for another reason (gave up, ran out of ideas).
 */
export type ParticipantDeclaredOutcome = "reached" | "not_reached" | "blocked";

/** Statuses that describe what happened to a PARTICIPANT rather than a harness malfunction. Verify
 *  treats these as study results, so a run whose evidence is sound is not called untrustworthy just
 *  because a persona gave up. */
export const PARTICIPANT_OUTCOME_STATUSES: readonly ActorStatus[] = ["abandoned", "incomplete"];

/** Optional precise interruption cause; completionReason and status retain their original meaning.
 *  One list, so the analysis schema and the diagnostics projection cannot drift from the trace. */
export const ACTOR_STOP_CAUSES = [
  "provider_output_limit",
  "provider_token_limit",
  "time_limit",
  "spend_limit",
  "study_spend_limit",
  "adapter_limit",
  "provider_incomplete",
  "provider_status",
  // The model provider refused the prompt under its usage policy (OpenAI `invalid_prompt`). The
  // session ends without a retry; resending the same prompt is not a fix.
  "provider_refused_prompt",
  "harness_aborted",
  "usage_unreported",
] as const;
export type ActorStopCause = (typeof ACTOR_STOP_CAUSES)[number];

export type ActorCompletionReason =
  | "goal_satisfied"
  | "turn_completed"
  | "gave_up"
  | "blocked_approval"
  | "timed_out"
  // A study or provider limit ended the session before a natural endpoint. The computer-use
  // loop maps this to "incomplete", even after productive activity. Optional stopCause records
  // the specific limit; older traces may carry only a verbatim reason.
  | "budget_reached"
  | "actor_error"
  // A deterministic scripted step or expectation evaluated false: the scenario predicate
  // failed. Distinct from actor_error/harness_error — the harness executed faithfully; the
  // SUBJECT did not satisfy the script.
  | "step_failed"
  | "harness_error";

// "scripted-browser" is the deterministic, model-free browser-actuation lane — distinct from
// "computer-use" (raw pixels + a model). "terminal" is the autonomous-agent lane: a
// real coding agent (Codex) driving a CLI/product from inside an E2B shell — distinct from
// "code" (the local/app-server Codex lanes that run on the operator's machine).
type ActorRunKind = "code" | "computer-use" | "scripted-browser" | "terminal";

// "terminal-exec" is the captured non-interactive exec stream of an in-sandbox agent (stdin
// disabled): `codex exec --json` launched via `commands.run`, output captured. It is NOT an
// interactive duplex PTY — labeling captured exec output as an interactive transport would be a
// claim/mechanism mismatch (invariant 6 + the goal packet's PTY ruling), so it gets its own
// honest protocol label distinct from "cua-loop"/"scripted-steps".
type ActorProtocol = "json-rpc" | "json-stream" | "cua-loop" | "scripted-steps" | "terminal-exec";

export type ActorTraceItemKind =
  | "message"
  | "reasoning"
  | "tool_call"
  | "command"
  | "file_change"
  | "approval"
  | "screenshot"
  | "ui_action"
  | "plan"
  | "notice";

export interface ActorTraceItem {
  id: string;
  kind: ActorTraceItemKind;
  lifecycle: "started" | "completed";
  status?: string;
  title: string;
  tool?: { server?: string; name?: string };
  command?: { text?: string; cwd?: string; exitCode?: number; outputTail?: string };
  screenshotRef?: { path: string; redaction: "blurred" | "ocr_scrubbed" | "none" };
  text?: string;
  /** When the item was recorded (ISO-8601), from the loop's injected clock. Additive
   *  (#441): items from older bundles and non-stamping producers lack it, so every
   *  consumer must treat absence as "timing unknown", never as t=0. */
  at?: string;
  /** Structured pointer coordinates for click-like `ui_action` items (#441) — the
   *  recorded fact the Observer's pins previously re-parsed out of the title text. */
  coord?: { x: number; y: number };
}

export interface ActorCapabilities {
  headless: boolean;
  structuredTrace: boolean;
  lanes: ActorRunKind[];
  producesScreenshots: boolean;
  byoModel: boolean;
  preGrantableApprovals: boolean;
  inProcessTools: boolean;
  license: "open" | "source-available" | "proprietary";
  /**
   * WHERE this actor's runtime key lives, per the placement rule (invariants-and-defaults.md):
   * "keys live where the keyed process runs — and nowhere else." Registry metadata the engine
   * enforces, NOT a code convention.
   *   - "external" (the implicit default for every existing actor): the keyed process (e.g. a
   *     computer-use provider loop) runs OUTSIDE any sandbox, so its key never enters one.
   *   - "in-sandbox-command-scoped": the keyed process is an agent-harness-under-test that runs
   *     INSIDE the sandbox; its runtime key is injected ONLY into the per-command `envs` of that
   *     invocation (never `Sandbox.create({envs})`, which is sandbox-global), the key is presumed
   *     exfiltratable, and the blast radius is bounded by key scoping + a spend budget.
   * Absent === "external". On the shipped terminal-product live route, the engine enforces this
   * declaration before sandbox creation. Under `runtimeAuth: openai-env` it passes the key only to
   * the agent command; under `openai-egress` the key stays in a host-side E2B header transform
   * and the command gets a placeholder.
   */
  keyPlacement?: "external" | "in-sandbox-command-scoped";
}

export interface ActorPersonaRef {
  id: string;
  traitsApplied: string[];
  promptDigest: string;
  /** Authored persona section only. Redacted evidence is not a byte-exact prompt. */
  brief?: {
    compilerVersion: number;
    text: string;
    digest: string;
    redacted: boolean;
    sourceDigest?: string;
  };
}

export interface ActorTokenUsage {
  input?: number;
  output?: number;
  /** Of `input`, how many tokens were served from the provider's prompt cache. Optional and
   *  HONESTLY ABSENT: a provider that does not report it leaves this undefined rather than
   *  reporting 0, because 0 and "unknown" price very differently (#391). */
  cachedInput?: number;
  /** Of `input`, how many tokens were newly WRITTEN to the provider's prompt cache
   *  (OpenAI 5.6+ bills these at a surcharge and reports `cache_write_tokens`). Same
   *  honestly-absent discipline as `cachedInput` (#334). */
  cacheWriteInput?: number;
  /** Per model-inference request usage, in request order. One provider interaction can contain
   *  several inferences around native tool calls. A provider that re-prices whole requests past
   *  an input-size threshold can only be priced exactly from these sizes; totals cannot say which
   *  requests crossed. Additive and honestly absent on producers that do not record it (#334). */
  turns?: Array<{
    input?: number;
    cachedInput?: number;
    cacheWriteInput?: number;
    output?: number;
  }>;
  total?: number;
  costUsd?: number;
}

/**
 * Codex CLI releases a recorded account profile may name. Append-only: a release can leave the
 * launch lists in codex/qualified-versions.ts, but saved bundles naming it stay readable.
 */
export const RECORDED_CODEX_CLI_VERSIONS = [
  "0.154.0",
  "0.157.1",
  "0.159.2",
  "0.159.3",
  "0.160.0",
] as const;
export type RecordedCodexCliVersion = (typeof RECORDED_CODEX_CLI_VERSIONS)[number];
export function isRecordedCodexCliVersion(value: unknown): value is RecordedCodexCliVersion {
  return RECORDED_CODEX_CLI_VERSIONS.some((version) => version === value);
}

/** Requested execution profile; per-request verification is recorded separately. */
export interface ActorExecutionProfile {
  schema: "humanish.actor-execution-profile.v1";
  transport: "codex-app-server";
  authentication: "chatgpt-account";
  billing: "account-unknown";
  requestedModel: string;
  reasoningEffort: import("./reasoning-effort.js").ReasoningEffort;
  cliVersion: RecordedCodexCliVersion;
  toolPolicy: "restricted-codex-v1" | "codex-ui-tools-v1";
  participantSchema: "humanish.restricted-participant-turn.v1" | "humanish.codex-ui-tool.v1";
  memoryPolicy: "recent-eight-16k-v1" | "continuing-thread-v1";
}
export interface ProviderRequestReceipt {
  /**
   * Whether the request reached the provider. It is not a success claim: the Codex restricted
   * session (src/actors/codex/restricted-session.ts) sets it only after initialize, config,
   * account, thread and MCP admission, immediately before turn/start.
   */
  dispatched: boolean | "unknown";
  usageComplete: boolean;
  cleanup: "confirmed" | "unconfirmed";
}
export interface ActorProviderRequest extends ProviderRequestReceipt {
  ordinal: number;
  kind: "interaction" | "debrief";
  /** Launcher version, effective config, account, thread and tool-policy checks
   * passed before turn/start. Does not attest remote execution or completion. */
  profileVerified: boolean;
  errorCode?: import("./computer-use/provider-error.js").CuaProviderErrorCode;
  failurePhase?: CuaProviderFailurePhase;
  usage?: ActorTokenUsage;
}

/** Durable reader profile. Append new qualified profiles; never rewrite old evidence. */
export function validActorExecutionProfile(value: unknown): value is ActorExecutionProfile {
  const expected = {
    schema: "humanish.actor-execution-profile.v1",
    transport: "codex-app-server",
    authentication: "chatgpt-account",
    billing: "account-unknown",
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).length !== Object.keys(expected).length + 6 ||
    !Object.entries(expected).every(([key, expectedValue]) => object[key] === expectedValue)
  )
    return false;
  // Only 0.154.0 produced the legacy structured-action profile.
  const legacy =
    object.cliVersion === "0.154.0" &&
    object.requestedModel === "gpt-6-astra" &&
    object.reasoningEffort === "low" &&
    object.toolPolicy === "restricted-codex-v1" &&
    object.participantSchema === "humanish.restricted-participant-turn.v1" &&
    (object.memoryPolicy === "recent-eight-16k-v1" ||
      object.memoryPolicy === "continuing-thread-v1");
  const uiTools =
    isRecordedCodexCliVersion(object.cliVersion) &&
    typeof object.requestedModel === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(object.requestedModel) &&
    typeof object.reasoningEffort === "string" &&
    ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(object.reasoningEffort) &&
    object.toolPolicy === "codex-ui-tools-v1" &&
    object.participantSchema === "humanish.codex-ui-tool.v1" &&
    object.memoryPolicy === "continuing-thread-v1";
  return legacy || uiTools;
}

/** Closed per-attempt evidence; dollar amounts are never part of account usage. */
export function validActorProviderRequests(value: unknown): value is ActorProviderRequest[] {
  if (!Array.isArray(value)) return false;
  const codes = [
    "request_rejected",
    "unavailable",
    "busy",
    "refused",
    "invalid_response",
    "protocol_error",
    "timeout",
    "cancelled",
    "process_failed",
    "cleanup_unconfirmed",
  ];
  return value.every((raw: unknown, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
    const r = raw as Record<string, unknown>;
    if (
      Object.keys(r).some(
        (k) =>
          ![
            "ordinal",
            "kind",
            "dispatched",
            "usageComplete",
            "cleanup",
            "profileVerified",
            "errorCode",
            "failurePhase",
            "usage",
          ].includes(k),
      ) ||
      r.ordinal !== index + 1 ||
      typeof r.kind !== "string" ||
      !["interaction", "debrief"].includes(r.kind) ||
      !(typeof r.dispatched === "boolean" || r.dispatched === "unknown") ||
      typeof r.usageComplete !== "boolean" ||
      typeof r.cleanup !== "string" ||
      !["confirmed", "unconfirmed"].includes(r.cleanup) ||
      typeof r.profileVerified !== "boolean" ||
      (r.profileVerified && r.dispatched !== true) ||
      (r.errorCode !== undefined &&
        (typeof r.errorCode !== "string" || !codes.includes(r.errorCode))) ||
      (r.failurePhase !== undefined &&
        (r.errorCode === undefined || !isCuaProviderFailurePhase(r.failurePhase)))
    )
      return false;
    if (r.usage === undefined) return !r.usageComplete;
    if (r.usage === null || typeof r.usage !== "object" || Array.isArray(r.usage)) return false;
    const usage = r.usage as Record<string, unknown>;
    if (
      Object.entries(usage).some(
        ([k, v]) =>
          !["input", "output", "cachedInput", "cacheWriteInput", "total"].includes(k) ||
          typeof v !== "number" ||
          !Number.isSafeInteger(v) ||
          v < 0,
      )
    )
      return false;
    return (
      !r.usageComplete ||
      (typeof usage.input === "number" &&
        typeof usage.output === "number" &&
        ((usage.cachedInput as number | undefined) ?? 0) +
          ((usage.cacheWriteInput as number | undefined) ?? 0) <=
          usage.input)
    );
  });
}

/** The participant's account, not an independently confirmed product diagnosis. */
export interface ParticipantClosingReport {
  summary: string;
  frictionReports: string[];
}

/** Runtime declarations and executable-version observations; not provider request attestation. */
export interface ActorRuntimeProvenance {
  schema: "humanish.actor-runtime.v1";
  package: string;
  requestedVersion: string;
  observedVersion?: string;
  versionStatus: "unobserved" | "verified" | "failed";
  requestedModel?: string;
  modelStatus: "declared" | "runtime_default_unobserved";
  requestedReasoningEffort?: string;
  /** Codex turn.completed aggregates requests; it cannot establish per-request pricing tiers. */
  usageGranularity: "runtime_turn";
}

export interface ActorTrace {
  schema: typeof ACTOR_TRACE_SCHEMA;
  provider: string;
  providerVersion?: string;
  executionProfile?: ActorExecutionProfile;
  providerRequests?: ActorProviderRequest[];
  historyTurnsOmitted?: number;
  runtime?: ActorRuntimeProvenance;
  protocol: ActorProtocol;
  lane: ActorRunKind;
  persona: ActorPersonaRef;
  // status: "passed" means the trace conforms to its declared redaction policy and carries no
  // secret VALUES in text. screenshots: "raw" = full-fidelity frames retained (valid for LOCAL
  // use; redact before publishing); "blurred"/"ocr_scrubbed" = publish-safe; "n/a" = none captured.
  redaction: {
    status: "passed";
    screenshots: "n/a" | "raw" | "blurred" | "ocr_scrubbed";
    notes: string;
  };
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: ActorStatus;
  completionReason: ActorCompletionReason;
  /** Absent in older traces and on routes that do not record a precise interruption cause. */
  stopCause?: ActorStopCause;
  reason: string;
  ids: { sessionId?: string; threadId?: string; turnId?: string; model?: string };
  /**
   * ADDITIVE + OPTIONAL record of HOW the model was asked to run (humanish.model-settings.v1,
   * #497). `ids.model` says which model; this says the reasoning effort the request actually
   * carried. Present on traces whose provider declares settings; absent everywhere else and on
   * every pre-existing bundle, and its absence is tolerated by verify.
   *
   * It exists because effort was a silent constant: unreachable from a lab, so every run took the
   * provider default. Effort is part of WHO the participant was, not of how the instrument was
   * tuned (docs/principles/actor-fidelity.md), so a trace that does not carry it is a result with
   * half its sample description missing — and two such traces cannot honestly be compared.
   */
  modelSettings?: { reasoningEffort: string; maxOutputTokens?: number };
  counts: Record<string, number>;
  /**
   * ADDITIVE + OPTIONAL affordance record (humanish.affordance-use.v1, #369): which KIND of route
   * this actor took — pointer, keyboard, url-navigation, script-execution, devtools,
   * browser-internal, observation — as per-class counts over the run's dispatched actions.
   * Present on computer-use traces that dispatched at least one action; absent elsewhere and on
   * every pre-existing bundle (its absence is tolerated by verify). The harness records the class
   * and states NO verdict: whether a class is faithful depends on the population the study
   * declares, which is product semantics and belongs to the adopter's scorer. See
   * docs/principles/actor-fidelity.md.
   */
  affordanceUse?: AffordanceUse;
  /**
   * ADDITIVE + OPTIONAL task funnel (humanish.task-funnel.v1, #414): how far this participant got
   * through the lab's declared protocol, corroborated per task by observations rather than by the
   * actor's own narration. Present only when the lab declared `tasks` and the session ran; absent
   * on every pre-existing bundle and on dry-run contract bundles (honest absence — a funnel that
   * was never measured is not an empty funnel). Its absence is tolerated by verify.
   */
  taskFunnel?: TaskFunnel;
  /**
   * ADDITIVE + OPTIONAL (#570): the outcome the participant declared on its final turn, when its
   * provider's reply carries the field. Absent on free-text providers and on every older bundle.
   * The route reads this before it reads the closing paragraph; three regex patches in one month
   * (#453, #549, #565) each fixed a false refusal and each left the next shape unhandled.
   */
  declaredOutcome?: ParticipantDeclaredOutcome;
  /** Closing report after a harness-owned stop. Does not change task outcomes or permit actions. */
  debrief?: {
    trigger: "stop_when" | "dwell";
    status: "completed" | "skipped" | "failed";
    reason: string;
    /** Absent if no request was made; false means token accounting is incomplete. */
    usageReported?: boolean;
    report?: ParticipantClosingReport;
    /** Links the readable projection so it is not heuristically classified a second time. */
    messageId?: string;
  };
  items: ActorTraceItem[];
  tokenUsage?: ActorTokenUsage;
  /** A stalled or adapter-reported ambiguous interaction may have additional unreported usage.
   *  Known tokenUsage remains usable as a partial total. Absence is not proof of completeness. */
  interactionUsageIncomplete?: true;
  /**
   * ADDITIVE + OPTIONAL token-derived cost ESTIMATE for this trace (humanish.actor-estimated-cost.v1).
   * Distinct from `tokenUsage.costUsd`, which is RESERVED for a real provider-returned charge: a
   * bare `costUsd` always means "the provider billed this", while `estimatedCost.estimatedCostUsd`
   * is a rate-table multiply named honestly as an estimate (invariant 6). Absent on the Codex
   * app-server and scripted traces and on every pre-existing bundle; the terminal trace records a
   * null estimate. Its absence is tolerated by verify (fail-open on display). A `null`
   * estimatedCostUsd is DECLARED ABSENT (unknown rate / no usage), never 0.
   */
  estimatedCost?: ActorEstimatedCost;
  capabilities: ActorCapabilities;
}

/**
 * What an actor's session returns: its status, why it ended, a one-line reason, and the
 * provider-neutral trace (humanish.actor-trace.v1). The computer-use loop, the terminal agent and
 * the scripted browser return this shape; the scripted browser adds its native capture.
 */
export interface ActorSessionResult {
  status: ActorStatus;
  completionReason: ActorCompletionReason;
  reason: string;
  trace: ActorTrace;
}

export const CODEX_APP_SERVER_CAPABILITIES: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["code"],
  producesScreenshots: false,
  byoModel: false,
  preGrantableApprovals: true,
  inProcessTools: false,
  license: "open",
};

// Scripted browser driver (src/actors/scripted-browser/): deterministic Playwright step
// replay against a loopback app. byoModel is false because there is NO model — the committed
// scenario steps are the whole behavior; tokenUsage on its traces records zeros by mechanism.
export const SCRIPTED_BROWSER_CAPABILITIES: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["scripted-browser"],
  producesScreenshots: true,
  byoModel: false,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "open", // playwright-core (Apache-2.0), already a lazy-imported production dependency
};

// Terminal agent (src/routes/terminal/route.ts): a real autonomous coding agent (Codex) discovering
// and using a CLI/product from inside an E2B shell, capturing its non-interactive exec output as
// a redacted event stream + normalized transcript. The "terminal" lane is the autonomous-agent
// study lane (distinct from "code", the operator-machine Codex lanes). byoModel is false: the
// agent runs its own model via the command-scoped runtime auth, not a humanish-supplied provider.
// keyPlacement is "in-sandbox-command-scoped" — the load-bearing inversion of every existing
// E2B route's external-key default (the agent is the keyed process and it runs INSIDE). The
// terminal-product live route enforces the boundary before sandbox creation.
export const TERMINAL_AGENT_CAPABILITIES: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["terminal"],
  producesScreenshots: false,
  byoModel: false,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "open", // the Codex CLI is invoked as a subprocess inside the sandbox; no peer dep here
  keyPlacement: "in-sandbox-command-scoped",
};
