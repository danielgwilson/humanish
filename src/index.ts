export {
  ANALYZE_RESULT_SCHEMA,
  analyzeStudy,
  showStudyAnalysis,
  correctStudyAnalysis,
} from "./analysis/service.js";
export type { AnalyzeOptions, AnalyzeResult, AnalyzeDeps } from "./analysis/service.js";
export {
  runAutomaticStudyAnalysis,
  readAutomaticStudyAnalysis,
  requestAutomaticStudyAnalysisCancellation,
} from "./analysis/automatic.js";
export { resolveAutomaticAnalysis, automaticAnalysisBudget } from "./analysis/automatic-config.js";
export type { LabAnalysis, AutomaticAnalysisBudget } from "./analysis/automatic-config.js";
export type {
  AutomaticAnalysisHooks,
  AutomaticAnalysisResult,
} from "./analysis/automatic-completion.js";
export type {
  AutomaticStudyAnalysisDeps,
  AutomaticStudyAnalysisOutcome,
  AutomaticStudyAnalysisView,
  AutomaticStudyAnalysisCancellation,
} from "./analysis/automatic.js";
export {
  STUDY_ANALYSIS_SCHEMA,
  STUDY_ANALYSIS_CORRECTION_SCHEMA,
} from "./analysis/study-analysis.js";
export type {
  StudyAnalysisConfig,
  OpenAIStudyAnalysisConfig,
  CodexStudyAnalysisConfig,
  CodexAnalysisIdentity,
  StudyAnalysisArtifact,
  StudyAnalysisResult,
  StudyAnalysisCorrection,
  AnalysisConcernReview,
  LoadedStudyAnalysis,
} from "./analysis/study-analysis.js";
export {
  ACTOR_TRACE_SCHEMA,
  CODEX_APP_SERVER_CAPABILITIES,
  SCRIPTED_BROWSER_CAPABILITIES,
  TERMINAL_AGENT_CAPABILITIES,
  codexResultToActorTrace,
  codexStatusToCompletionReason,
} from "./actors/contract.js";
export type {
  ActorCapabilities,
  ActorCompletionReason,
  ActorStopCause,
  ActorLane,
  ActorPersonaRef,
  ActorProtocol,
  ActorStatus,
  ActorTokenUsage,
  ActorTrace,
  ActorRuntimeProvenance,
  ActorTraceItem,
  ActorTraceItemKind,
  ParticipantClosingReport,
} from "./actors/contract.js";
export {
  actorRegistry,
  getActor,
  isCuaActorDescriptor,
  isScriptedBrowserActorDescriptor,
  isTerminalActorDescriptor,
} from "./actors/registry.js";
export type {
  ActorDescriptor,
  ActorId,
  CuaActorDescriptor,
  ScriptedBrowserActorDescriptor,
  TerminalActorDescriptor,
} from "./actors/registry.js";
export {
  TERMINAL_AGENT_NOT_IMPLEMENTED_CODE,
  runTerminalAgentSession,
} from "./actors/terminal-agent.js";
export type {
  TerminalAgentSessionOptions,
  TerminalAgentSessionResult,
} from "./actors/terminal-agent.js";
export {
  describeCuaAction,
  runComputerUseLoop,
  stableProgressKey,
} from "./actors/computer-use/loop.js";
export type {
  CuaAction,
  CuaExecutor,
  CuaLoopOptions,
  CuaLoopResult,
  CuaObservation,
  CuaProvider,
  CuaSafetyCheck,
  CuaTurn,
  CuaTurnRequest,
} from "./actors/computer-use/loop.js";
export { runCuaActorSession } from "./actors/computer-use/actor.js";
export type { CuaActorSessionOptions } from "./actors/computer-use/actor.js";
export { createE2BDesktopExecutor } from "./substrates/e2b/desktop-executor.js";
export type {
  E2BDesktopExecutorOptions,
  E2BDesktopLike,
} from "./substrates/e2b/desktop-executor.js";
export { loadE2BDesktopModule } from "./substrates/e2b/desktop-launch.js";
export type { E2BDesktopModule, E2BDesktopSandbox } from "./substrates/e2b/desktop-launch.js";
export {
  DEFAULT_OPENAI_CU_MODEL,
  OPENAI_RESPONSES_CU_CAPABILITIES,
  createOpenAiResponsesProvider,
} from "./actors/computer-use/openai-provider.js";
export type {
  FetchLike,
  OpenAiResponsesProviderOptions,
} from "./actors/computer-use/openai-provider.js";
export { CuaAdmissionLimitError } from "./actors/computer-use/admission-limit.js";
export {
  adapterScoreFailureMessage,
  applyAdapterScoreFailureToReview,
  applyBrowserAdapterHooks,
} from "./lab/adapter-extension.js";
export type {
  BrowserAdapterBackend,
  BrowserLabAdapterHooks,
  BrowserLabScoringContext,
} from "./lab/adapter-extension.js";
// #316 CLI-loadable adopter scorer: the adopter-facing module contract + its read-model context union
// (so an adopter types its `.mjs` scorer against `import("humanish")` alone). The loader itself is
// CLI-internal (declared via `review.scorer.ref` / `--scorer`), not part of the library surface.
export type { AdapterScorerModule, AdapterScoringContext } from "./lab/adapter-scorer-loader.js";
export type { RedactionHooks } from "./evidence/redaction.js";
// Off-app comms (#297) — the LIBRARY extension surface only. The capability is driven CLI-first via a
// lab `comms:` block (see the humanish skill + lab schema), so the catch, drain, inbox-render, and
// origin-rewrite MACHINERY is internal to that route and intentionally NOT re-exported. What IS public:
// the `CommsChannel` port (implement it for a custom/real provider-backed adapter), its reference
// in-process adapter (`FakeInbox`), and the digest-only evidence types (to read a `humanish.comms-thread.v1`
// artifact from a run bundle). Study receiving adapters and cleanup authority remain internal.
export type {
  CommsAddress,
  CommsChannel,
  CommsChannelKind,
  CommsMessage,
  InboundRaw,
  OutboundMessage,
} from "./comms/types.js";
export { FakeInbox } from "./comms/fake-inbox.js";
export type { FakeInboxOptions } from "./comms/fake-inbox.js";
export { COMMS_THREAD_SCHEMA } from "./comms/evidence.js";
export type { CommsThreadArtifact, CommsThreadEntry } from "./comms/evidence.js";
export { COMMS_RECEIVING_SCHEMA } from "./comms/receiving-types.js";
export type {
  CommsReceivingEvidence,
  ReceivingParticipantEvidence,
} from "./comms/receiving-types.js";
export {
  DESKTOP_RATE,
  DESKTOP_RESOURCE_RATE,
  MODEL_RATES,
  PRICING_SCHEMA,
  estimateActorCost,
  estimateAllocatedDesktopCost,
  estimateDesktopCost,
} from "./run/pricing.js";
export type {
  ActorEstimatedCost,
  DesktopCostEstimate,
  DesktopRate,
  DesktopResources,
  DesktopResourceRate,
  ModelRate,
} from "./run/pricing.js";
export { normalizeCliArgv } from "./cli/argv.js";
export { CODEX_APP_SERVER_UI_SCHEMA, startCodexAppServerUi } from "./actors/codex/app-server-ui.js";
export type {
  CodexAppServerUiController,
  CodexAppServerUiOptions,
  CodexAppServerUiState,
} from "./actors/codex/app-server-ui.js";
export {
  CODEX_APP_SERVER_TRACE_SCHEMA,
  runCodexAppServerSession,
} from "./actors/codex/app-server.js";
export type {
  CodexAppServerRunOptions,
  CodexAppServerRunResult,
  CodexAppServerTrace,
} from "./actors/codex/app-server.js";
export {
  FEEDBACK_RESULT_SCHEMA,
  draftFeedback,
  listFeedback,
  renderIssueMarkdown,
  renderIssueUrl,
  verifyFeedback,
} from "./feedback/feedback.js";
export { FEEDBACK_SCHEMA } from "./feedback/draft.js";
export type { FeedbackResult } from "./feedback/feedback.js";
export type { FeedbackDraft } from "./feedback/draft.js";
export { INIT_RESPONSE_SCHEMA, runInit } from "./lab/init.js";
export type { InitChange, InitMode, InitOptions, InitResult } from "./lab/init.js";
export { OBSERVER_DATA_SCHEMA, buildObserverData, stripAnsi } from "./observer/data.js";
export type { ObserverData, ObserverStream } from "./observer/data.js";
export { OBSERVER_SCHEMA, openTarget, renderObserver, serveObserver } from "./observer/render.js";
export type {
  ObserverOptions,
  ObserverResult,
  ObserverServeOptions,
  ObserverServer,
} from "./observer/render.js";
export {
  OBSERVER_STATIC_HOST,
  createObserverStaticHandler,
  observerStaticContentType,
  respondToObserverStaticRequest,
  serveObserverStatic,
} from "./observer/static.js";
export type {
  ObserverStaticHandlerOptions,
  ObserverStaticServeOptions,
  ObserverStaticServer,
} from "./observer/static.js";
export { CLEANUP_SCHEMA, REVIEW_SCHEMA, RUN_BUNDLE_SCHEMA } from "./run/bundle.js";
export { DOCTOR_SCHEMA, doctor } from "./cli/doctor.js";
export { RUNS_SCHEMA, cleanupRun, listRuns, readReview } from "./run/manage.js";
export { VERIFY_SCHEMA, verifyRun } from "./run/verify.js";
export { extractLocalActorVerdict, normalizeLocalActorTranscript } from "./run/verify-actor.js";
export { runDryRun } from "./run/dry-run.js";
export { SHARED_WORLD_SCHEMA } from "./run/bundle.js";
export type {
  CleanupAdapterResult,
  CleanupResourceResult,
  CleanupResult,
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
  RunOptions,
  RunParticipantAssignment,
  RunProviderResource,
  RunResult,
  RunScorerProvenance,
  RunSimulation,
  RunStream,
  RunStreamKind,
  RunSubjectProvenance,
  RunSubjectStateStepRecord,
  SharedWorldCheckpoint,
  SharedWorldEvidence,
  SharedWorldLaneWindow,
  SharedWorldOutcome,
  SharedWorldPlane,
  SharedWorldSkippedTail,
  SharedWorldStateSnapshot,
  SharedWorldTimelineEntry,
  SharedWorldTurn,
} from "./run/bundle.js";
export type { DoctorResult } from "./cli/doctor.js";
export type { RunCleanupHooks, RunsResult } from "./run/manage.js";
export type { VerifyResult } from "./run/verify.js";
export { runCuaActorLab } from "./routes/computer-use/lab.js";
export { CUA_ACTOR_LAB_PROVIDER_METADATA } from "./substrates/e2b/cua-desktop.js";
export { CUA_ACTOR_LAB_SCHEMA, CUA_FANOUT_STRATEGY } from "./routes/computer-use/types.js";
export { buildCuaBundle } from "./routes/computer-use/single-bundle.js";
export { buildCuaFanoutBundle } from "./routes/computer-use/fanout-bundle.js";
export { resolveCuaLanePlan } from "./routes/computer-use/lane-plan.js";
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
} from "./routes/computer-use/types.js";
export type { SubjectPhaseEvent } from "./subject/steps.js";
export { SCRIPTED_BROWSER_PROVIDER, runScriptedBrowserSession } from "./actors/scripted-browser.js";
export type {
  BrowserPersonaJourney,
  BrowserSurface,
  ScriptedBrowserLaunchArgs,
  ScriptedBrowserLike,
  ScriptedBrowserSessionOptions,
  ScriptedBrowserSessionResult,
  ScriptedLocatorLike,
  ScriptedPageLike,
} from "./actors/scripted-browser.js";
export {
  SCRIPTED_BROWSER_LAB_SCHEMA,
  buildScriptedLabBundle,
  runScriptedBrowserLab,
} from "./routes/scripted-browser.js";
export type {
  RunScriptedBrowserLabOptions,
  ScriptedBrowserLabHooks,
  ScriptedBrowserLabResult,
  ScriptedBrowserLabSession,
} from "./routes/scripted-browser.js";
export { TERMINAL_PRODUCT_LAB_SCHEMA } from "./routes/terminal/types.js";
export { buildTerminalProductBundle } from "./routes/terminal/bundle.js";
export { runTerminalProductLab } from "./routes/terminal/lab.js";
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
  TerminalProductScoringContext,
} from "./routes/terminal/types.js";
export type { SharedWorldLabHooks } from "./routes/shared-world/hooks.js";
export {
  CONCURRENT_ATTRIBUTION_LIMITS,
  CONCURRENT_SHARED_WORLD_LAB_SCHEMA,
  CONCURRENT_SHARED_WORLD_PROVIDER_METADATA,
  EXTERNAL_PUBLIC_ATTRIBUTION_LIMITS,
  LOBBY_CODE_PATTERN,
  buildConcurrentSharedWorldBundle,
  extractLobbyCode,
  runConcurrentSharedWorld,
} from "./routes/shared-world/concurrent.js";
export type {
  ConcurrentSharedWorldLabErrorCode,
  ConcurrentSharedWorldLabResult,
  ConcurrentSharedWorldPlaneClass,
  ConcurrentSharedWorldRoleResult,
  RunConcurrentSharedWorldLabOptions,
} from "./routes/shared-world/concurrent.js";
export {
  probeUrl,
  readDetachedLog,
  runDetachedStep,
  startDetachedProcess,
} from "./substrates/detached.js";
export type {
  DetachedStepOptions,
  DetachedStepResult,
  DetachedTimers,
} from "./substrates/detached.js";
// The detached-step primitives take a Shell; e2bShell adapts an E2B desktop handle to one.
export { e2bShell } from "./substrates/e2b/shell.js";
export type { Shell, ShellResult } from "./substrates/shell.js";
export {
  DEFAULT_DEVICE_PRESET,
  DEVICE_PRESETS,
  DEVICE_PRESET_NAMES,
  isDevicePresetName,
  resolveDevicePreset,
} from "./lab/device-presets.js";
export type { DevicePreset, DevicePresetName } from "./lab/device-presets.js";
export {
  actorResolvesToTerminal,
  cuaLaneCount,
  MAX_CUA_LANES,
  resolveSeatUrl,
  routesToComputerUse,
  routesToConcurrentSharedWorld,
  routesToExternalPublicSharedWorld,
  routesToProvisionedSharedWorld,
  routesToScriptedBrowser,
  routesToSharedWorld,
  routesToTerminalProduct,
} from "./lab/routing.js";
export {
  cuaLaneValidationReason,
  concurrentSharedWorldValidationReason,
  externalPublicSharedWorldValidationReason,
  sharedWorldValidationReason,
} from "./lab/validation.js";
export { isHttpUrl, isLoopbackUrl, subjectStateInvalidReason } from "./lab/parse-subject.js";
export { LAB_CONFIG_SCHEMA } from "./lab/types.js";
export { parseLabConfig } from "./lab/config.js";
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
  LabTerminalTransport,
} from "./lab/types.js";
export { resolveLabDryRun, runLab, selectLabBackend } from "./lab/engine.js";
export type { LabBackend, LabOutcome, RunLabOptions } from "./lab/engine.js";
export { LAB_PREFLIGHT_SCHEMA, runLabPreflight } from "./lab/preflight.js";
export type {
  LabPreflightCheck,
  LabPreflightReachabilityMode,
  LabPreflightResult,
  LabPreflightSandbox,
  LabPreflightSpend,
  LabPreflightTarget,
  RunLabPreflightOptions,
} from "./lab/preflight.js";
export { CLI_RESPONSE_SCHEMA } from "./cli/io.js";
export { createProgram } from "./cli/program.js";
export type { CliIo } from "./cli/io.js";
export type { UnexpectedErrorEnvelope } from "./cli/program.js";
