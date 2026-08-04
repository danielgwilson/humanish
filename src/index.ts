export {
  ACTOR_TRACE_SCHEMA,
  CODEX_APP_SERVER_CAPABILITIES,
  SCRIPTED_BROWSER_CAPABILITIES,
  TERMINAL_AGENT_CAPABILITIES,
  codexResultToActorTrace,
  codexStatusToCompletionReason
} from "./actor-contract.js";
export type {
  ActorCapabilities,
  ActorCompletionReason,
  ActorLane,
  ActorPersonaRef,
  ActorProtocol,
  ActorStatus,
  ActorTokenUsage,
  ActorTrace,
  ActorTraceItem,
  ActorTraceItemKind
} from "./actor-contract.js";
export { actorRegistry, getActor, isCuaActorDescriptor, isScriptedBrowserActorDescriptor, isTerminalActorDescriptor } from "./actor-registry.js";
export type { ActorDescriptor, ActorId, CuaActorDescriptor, ScriptedBrowserActorDescriptor, TerminalActorDescriptor } from "./actor-registry.js";
export {
  TERMINAL_AGENT_NOT_IMPLEMENTED_CODE,
  runTerminalAgentSession
} from "./terminal-agent-actor.js";
export type { TerminalAgentSessionOptions, TerminalAgentSessionResult } from "./terminal-agent-actor.js";
export {
  describeCuaAction,
  runComputerUseLoop
} from "./computer-use.js";
export type {
  CuaAction,
  CuaExecutor,
  CuaLoopOptions,
  CuaLoopResult,
  CuaObservation,
  CuaProvider,
  CuaSafetyCheck,
  CuaTurn,
  CuaTurnRequest
} from "./computer-use.js";
export { runCuaActorSession } from "./computer-use-actor.js";
export type { CuaActorSessionOptions } from "./computer-use-actor.js";
export { createE2BDesktopExecutor } from "./e2b-desktop-executor.js";
export type { E2BDesktopExecutorOptions, E2BDesktopLike } from "./e2b-desktop-executor.js";
export { loadE2BDesktopModule } from "./e2b-desktop-launch.js";
export type { E2BDesktopModule, E2BDesktopSandbox } from "./e2b-desktop-launch.js";
export {
  DEFAULT_OPENAI_CU_MODEL,
  OPENAI_RESPONSES_CU_CAPABILITIES,
  createOpenAiResponsesProvider
} from "./openai-responses-cu.js";
export type { FetchLike, OpenAiResponsesProviderOptions } from "./openai-responses-cu.js";
export {
  adapterScoreFailureMessage,
  applyAdapterScoreFailureToReview,
  applyBrowserAdapterHooks
} from "./adapter-extension.js";
export type {
  BrowserAdapterBackend,
  BrowserLabAdapterHooks,
  BrowserLabScoringContext
} from "./adapter-extension.js";
export type { RedactionHooks } from "./redaction.js";
// Addressed comms bus (#297): fake email/SMS inboxes + a VENDOR-NEUTRAL email-API catch that
// redirects an API-first app into the fake bus with one env var (Resend-/SendGrid-compatible via
// pluggable profiles, no named vendor dependency). Real (provider-backed) adapters implement the
// same CommsChannel port.
export { FakeInbox, extractLinks, extractOtpCodes } from "./comms-fake-inbox.js";
export type { FakeInboxOptions } from "./comms-fake-inbox.js";
export { DEFAULT_EMAIL_PROFILES, genericEmailProfile, sendgridEmailProfile, startEmailCatchServer } from "./comms-email-catch.js";
export type { EmailCatchOptions, EmailCatchServer, EmailSendProfile, NormalizedSend } from "./comms-email-catch.js";
// In-sandbox deployment of the catch + the host-side delivery bridge (the config-block core: the
// listener must live inside the subject sandbox, since 127.0.0.1 from the app is the sandbox loopback).
export { DEFAULT_SANDBOX_CATCH_PORT, SANDBOX_CATCH_SCRIPT, collectCommsThread, deployCommsCatch, drainCommsCatch, routeCapturedSends, writeInboxSurface } from "./comms-sandbox-catch.js";
export type { CommsThreadCollection, DeployCommsCatchOptions, DeployedCommsCatch, RawCapturedSend } from "./comms-sandbox-catch.js";
export { INBOX_SURFACE_CSP, buildInboxSurface, inboxMessageJson, pickVerifyUrl, renderInboxList, renderInboxMessage, renderInboxMessageSynth, rewriteOrigin } from "./comms-inbox.js";
export type { InboxRenderOptions, InboxSurfaceFile, OriginMap } from "./comms-inbox.js";
export { COMMS_THREAD_SCHEMA, buildCommsThreadArtifact } from "./comms-evidence.js";
export type { CommsThreadArtifact, CommsThreadEntry } from "./comms-evidence.js";
export type {
  CommsAddress,
  CommsChannel,
  CommsChannelKind,
  CommsMessage,
  InboundRaw,
  OutboundMessage
} from "./comms-types.js";
export {
  DESKTOP_RATE,
  MODEL_RATES,
  PRICING_SCHEMA,
  estimateActorCost,
  estimateDesktopCost
} from "./pricing.js";
export type {
  ActorEstimatedCost,
  DesktopCostEstimate,
  DesktopRate,
  ModelRate
} from "./pricing.js";
export { normalizeCliArgv } from "./argv.js";
export {
  CODEX_APP_SERVER_UI_SCHEMA,
  startCodexAppServerUi
} from "./codex-app-server-ui.js";
export type { CodexAppServerUiController, CodexAppServerUiOptions, CodexAppServerUiState } from "./codex-app-server-ui.js";
export {
  CODEX_APP_SERVER_TRACE_SCHEMA,
  runCodexAppServerSession
} from "./codex-app-server.js";
export type { CodexAppServerRunOptions, CodexAppServerRunResult, CodexAppServerTrace } from "./codex-app-server.js";
export {
  FEEDBACK_RESULT_SCHEMA,
  FEEDBACK_SCHEMA,
  draftFeedback,
  listFeedback,
  renderIssueMarkdown,
  renderIssueUrl,
  verifyFeedback
} from "./feedback.js";
export type { FeedbackDraft, FeedbackResult } from "./feedback.js";
export { INIT_RESPONSE_SCHEMA, runInit } from "./init.js";
export type { InitChange, InitMode, InitOptions, InitResult } from "./init.js";
export { OBSERVER_DATA_SCHEMA, buildObserverData, stripAnsi } from "./observer-data.js";
export type { ObserverData, ObserverStream } from "./observer-data.js";
export { OBSERVER_SCHEMA, openTarget, renderObserver, serveObserver } from "./observer.js";
export type { ObserverOptions, ObserverResult, ObserverServeOptions, ObserverServer } from "./observer.js";
export {
  OBSERVER_STATIC_HOST,
  createObserverStaticHandler,
  observerStaticContentType,
  respondToObserverStaticRequest,
  serveObserverStatic
} from "./observer-static.js";
export type {
  ObserverStaticHandlerOptions,
  ObserverStaticServeOptions,
  ObserverStaticServer
} from "./observer-static.js";
export {
  DEFAULT_OSS_REPOS,
  OSS_LAB_SCHEMA,
  normalizeOssRepoSlugs,
  runOssLab,
  validateOssRepoSlug
} from "./oss-lab.js";
export type { OssLabOptions, OssLabRepoResult, OssLabResult, OssLabStep } from "./oss-lab.js";
export {
  CLEANUP_SCHEMA,
  DOCTOR_SCHEMA,
  REVIEW_SCHEMA,
  RUNS_SCHEMA,
  RUN_BUNDLE_SCHEMA,
  VERIFY_SCHEMA,
  cleanupRun,
  doctor,
  extractLocalActorVerdict,
  listRuns,
  normalizeLocalActorTranscript,
  readReview,
  runDryRun,
  verifyRun
} from "./run.js";
export { SHARED_WORLD_SCHEMA } from "./run.js";
export type {
  CleanupAdapterResult,
  CleanupResourceResult,
  CleanupResult,
  DoctorResult,
  ReviewSummary,
  RunAdapterArtifact,
  RunAdapterScore,
  RunAttributionClass,
  RunBundle,
  RunCostLine,
  RunCostSummary,
  RunDesktopGeometry,
  RunEvent,
  RunFeedbackCandidate,
  RunMeaningfulUseComponentId,
  RunMeaningfulUseScore,
  RunCleanupHooks,
  RunOptions,
  RunProviderResource,
  RunResult,
  RunSimulation,
  RunStream,
  RunStreamKind,
  RunSubjectProvenance,
  RunSubjectStateStepRecord,
  RunsResult,
  SharedWorldCheckpoint,
  SharedWorldEvidence,
  SharedWorldLaneWindow,
  SharedWorldOutcome,
  SharedWorldPlane,
  SharedWorldStateSnapshot,
  SharedWorldTimelineEntry,
  SharedWorldTurn,
  VerifyResult
} from "./run.js";
export {
  CUA_ACTOR_LAB_PROVIDER_METADATA,
  CUA_ACTOR_LAB_SCHEMA,
  CUA_FANOUT_STRATEGY,
  buildCuaBundle,
  buildCuaFanoutBundle,
  resolveCuaLanePlan,
  runCuaActorLab
} from "./cua-actor-lab.js";
export type {
  CuaActorLabErrorCode,
  CuaActorLabHooks,
  CuaActorLabResult,
  CuaLanePlan,
  CuaLanePlanEntry,
  CuaLaneResult,
  CuaLaneSummary,
  CuaSubjectProjection,
  RunCuaActorLabOptions,
  SubjectPhaseEvent
} from "./cua-actor-lab.js";
export {
  SCRIPTED_BROWSER_PROVIDER,
  runScriptedBrowserSession
} from "./scripted-browser-actor.js";
export type {
  BrowserPersonaJourney,
  BrowserSurface,
  ScriptedBrowserLaunchArgs,
  ScriptedBrowserLike,
  ScriptedBrowserSessionOptions,
  ScriptedBrowserSessionResult,
  ScriptedLocatorLike,
  ScriptedPageLike
} from "./scripted-browser-actor.js";
export {
  SCRIPTED_BROWSER_LAB_SCHEMA,
  buildScriptedLabBundle,
  runScriptedBrowserLab
} from "./scripted-browser-lab.js";
export type {
  RunScriptedBrowserLabOptions,
  ScriptedBrowserLabHooks,
  ScriptedBrowserLabResult,
  ScriptedBrowserLabSession
} from "./scripted-browser-lab.js";
export {
  TERMINAL_PRODUCT_LAB_SCHEMA,
  buildTerminalProductBundle,
  runTerminalProductLab
} from "./e2b-terminal-lab.js";
export type {
  CommandLogRecord,
  CostCategory,
  CostLine,
  InterventionRecord,
  LifecycleRecord,
  NoSpendProof,
  RunTerminalProductLabOptions,
  TerminalCostLedger,
  TerminalLedgers,
  TerminalProductLabHooks,
  TerminalProductLabResult,
  TerminalProductScoringContext
} from "./e2b-terminal-lab.js";
export {
  SHARED_WORLD_LAB_PROVIDER_METADATA,
  SHARED_WORLD_LAB_SCHEMA,
  buildSharedWorldBundle,
  runSharedWorldLab
} from "./shared-world-lab.js";
export type {
  RunSharedWorldLabOptions,
  SharedWorldLabErrorCode,
  SharedWorldLabHooks,
  SharedWorldLabResult,
  SharedWorldRoleResult
} from "./shared-world-lab.js";
export {
  CONCURRENT_ATTRIBUTION_LIMITS,
  CONCURRENT_SHARED_WORLD_LAB_SCHEMA,
  CONCURRENT_SHARED_WORLD_PROVIDER_METADATA,
  EXTERNAL_PUBLIC_ATTRIBUTION_LIMITS,
  LOBBY_CODE_PATTERN,
  buildConcurrentSharedWorldBundle,
  extractLobbyCode,
  runConcurrentSharedWorld
} from "./concurrent-shared-world-lab.js";
export type {
  ConcurrentSharedWorldLabErrorCode,
  ConcurrentSharedWorldLabResult,
  ConcurrentSharedWorldPlaneClass,
  ConcurrentSharedWorldRoleResult,
  RunConcurrentSharedWorldLabOptions
} from "./concurrent-shared-world-lab.js";
export { probeUrl, readDetachedLog, runDetachedStep, startDetachedProcess } from "./e2b-detached.js";
export type { DetachedStepOptions, DetachedStepResult, DetachedTimers } from "./e2b-detached.js";
export {
  DEFAULT_DEVICE_PRESET,
  DEVICE_PRESETS,
  DEVICE_PRESET_NAMES,
  isDevicePresetName,
  resolveDevicePreset
} from "./device-presets.js";
export type { DevicePreset, DevicePresetName } from "./device-presets.js";
export {
  actorResolvesToTerminal,
  cuaLaneCount,
  cuaLaneValidationReason,
  isHttpUrl,
  isLoopbackUrl,
  LAB_CONFIG_SCHEMA,
  MAX_CUA_LANES,
  concurrentSharedWorldValidationReason,
  externalPublicSharedWorldValidationReason,
  parseLabConfig,
  resolveSeatUrl,
  routesToComputerUse,
  routesToConcurrentSharedWorld,
  routesToExternalPublicSharedWorld,
  routesToProvisionedSharedWorld,
  routesToScriptedBrowser,
  routesToSharedWorld,
  routesToTerminalProduct,
  sharedWorldValidationReason,
  subjectStateInvalidReason
} from "./lab-config.js";
export type {
  LabActor,
  LabActorLane,
  LabConfig,
  LabConfigParseResult,
  LabExecutionTerminal,
  LabRuntimeAuth,
  LabScenarioCaps,
  LabStateStepWhen,
  LabSubject,
  LabSubjectProduct,
  LabSubjectServe,
  LabSubjectSource,
  LabSubjectState,
  LabSubjectStateCheckpoint,
  LabSubjectStateStep,
  LabSubjectTopology,
  LabTerminalStdin,
  LabTerminalTransport
} from "./lab-config.js";
export { resolveLabDryRun, runLab, selectLabBackend } from "./lab-engine.js";
export type { LabBackend, LabOutcome, RunLabOptions } from "./lab-engine.js";
export { LAB_PREFLIGHT_SCHEMA, runLabPreflight } from "./lab-preflight.js";
export type {
  LabPreflightCheck,
  LabPreflightReachabilityMode,
  LabPreflightResult,
  LabPreflightSandbox,
  LabPreflightSpend,
  LabPreflightTarget,
  RunLabPreflightOptions
} from "./lab-preflight.js";
export {
  CLI_RESPONSE_SCHEMA,
  createProgram
} from "./program.js";
export type {
  CliIo,
  UnexpectedErrorEnvelope
} from "./program.js";
