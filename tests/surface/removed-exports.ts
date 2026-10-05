// The library names 0.109.0 removed: the 0.107 names that 0.108.0 kept as deprecated aliases. Each
// has a study or ComputerUse name that src/index.ts exports.
export const REMOVED_EXPORTS: Readonly<Record<string, string>> = {
  runLab: "runStudy",
  parseLabConfig: "parseStudy",
  LAB_CONFIG_SCHEMA: "STUDY_SCHEMA",
  LabConfig: "StudyConfig",
  LabEvent: "StudyEvent",
  LabOutcome: "StudyOutcome",
  LabResult: "StudyResult",
  LabRoute: "StudyRoute",
  RunLabOptions: "RunStudyOptions",
  BrowserLabScoringContext: "BrowserScoringContext",
  CuaAction: "ComputerUseAction",
  CuaExecutor: "ComputerUseExecutor",
  CuaLoopOptions: "ComputerUseLoopOptions",
  CuaLoopResult: "ComputerUseLoopResult",
  CuaObservation: "ComputerUseObservation",
  CuaProvider: "ComputerUseProvider",
  CuaSafetyCheck: "ComputerUseSafetyCheck",
  CuaTurn: "ComputerUseTurn",
  CuaTurnRequest: "ComputerUseTurnRequest",
  CuaAdmissionLimitError: "ComputerUseAdmissionLimitError",
};

// The exports 0.107.0 removed, from the "Library exports and RunLabOptions" table of its release
// notes, each with what replaced it under today's names (0.108.0 renamed runLab to runStudy and
// RunLabOptions to RunStudyOptions).
export const REMOVED_IN_0_107: Readonly<Record<string, string>> = {
  runCuaActorLab: "runStudy",
  runScriptedBrowserLab: "runStudy",
  runTerminalProductLab: "runStudy",
  runConcurrentSharedWorld: "runStudy",
  RunCuaActorLabOptions: "RunStudyOptions",
  RunScriptedBrowserLabOptions: "RunStudyOptions",
  RunTerminalProductLabOptions: "RunStudyOptions",
  RunConcurrentSharedWorldLabOptions: "RunStudyOptions",
  CuaActorLabHooks: "the typed RunStudyOptions fields",
  ScriptedBrowserLabHooks: "the typed RunStudyOptions fields",
  TerminalProductLabHooks: "the typed RunStudyOptions fields",
  SharedWorldLabHooks: "the typed RunStudyOptions fields",
  AutomaticAnalysisHooks: "RunStudyOptions.onEvent and analysisSignal",
  BrowserLabAdapterHooks: "AdapterScorerModule",
  LabBackend: "StudyRoute",
  routesToComputerUse: "routeOf(config)",
  routesToScriptedBrowser: "routeOf(config)",
  routesToTerminalProduct: "routeOf(config)",
  routesToSharedWorld: "routeOf(config)",
  routesToConcurrentSharedWorld: "routeOf(config)",
  routesToProvisionedSharedWorld: "routeOf(config)",
  routesToExternalPublicSharedWorld: "routeOf(config)",
  selectLabBackend: "routeOf(config)",
  runDryRun: "runStudy on a this-repo study",
  RunOptions: "RunStudyOptions",
  RunResult: "StudyResult",
  runCuaActorSession: "runComputerUseLoop",
  actorResolvesToTerminal: "routeOf(config)",
  cuaLaneCount: "the plan StudyEvent",
  resolveSeatUrl: "parseStudy",
  cuaLaneValidationReason: "parseStudy",
  sharedWorldValidationReason: "parseStudy",
  concurrentSharedWorldValidationReason: "parseStudy",
  externalPublicSharedWorldValidationReason: "parseStudy",
  resolveLabDryRun: "RunStudyOptions.dryRun",
  MAX_CUA_LANES: "parseStudy, which refuses more than 16 participants",
  CuaActorLabResult: 'StudyResult<"computer-use">',
  ScriptedBrowserLabResult: 'StudyResult<"scripted">',
  TerminalProductLabResult: 'StudyResult<"terminal">',
  ConcurrentSharedWorldLabResult: 'StudyResult<"shared-world">',
  SubjectPhaseEvent: "the subject-phase StudyEvent",
  // The RunLabOptions hook bags, which were options and not exports. Their fields moved to typed
  // RunStudyOptions fields.
  cuaHooks: "the typed RunStudyOptions fields",
  scriptedHooks: "the typed RunStudyOptions fields",
  terminalHooks: "the typed RunStudyOptions fields",
  sharedWorldHooks: "the typed RunStudyOptions fields",
};

// The 300 names 0.106.0 removed, as its release notes list them under "The 300 names 0.105.0
// exported that this release does not". Most have no replacement export; the notes give each
// group's migration.
export const REMOVED_IN_0_106: readonly string[] = `
  ACTOR_TRACE_SCHEMA ANALYZE_RESULT_SCHEMA CLEANUP_SCHEMA CLI_RESPONSE_SCHEMA
  CODEX_APP_SERVER_CAPABILITIES CODEX_APP_SERVER_TRACE_SCHEMA CODEX_APP_SERVER_UI_SCHEMA
  COMMS_RECEIVING_SCHEMA COMMS_THREAD_SCHEMA CONCURRENT_ATTRIBUTION_LIMITS
  CONCURRENT_SHARED_WORLD_LAB_SCHEMA CONCURRENT_SHARED_WORLD_PROVIDER_METADATA
  CUA_ACTOR_LAB_PROVIDER_METADATA CUA_ACTOR_LAB_SCHEMA CUA_FANOUT_STRATEGY DEFAULT_DEVICE_PRESET
  DEFAULT_OPENAI_CU_MODEL DEFAULT_OSS_REPOS DESKTOP_RATE DESKTOP_RESOURCE_RATE DEVICE_PRESETS
  DEVICE_PRESET_NAMES DOCTOR_SCHEMA EXTERNAL_PUBLIC_ATTRIBUTION_LIMITS FEEDBACK_RESULT_SCHEMA
  FEEDBACK_SCHEMA FakeInbox INIT_RESPONSE_SCHEMA LAB_PREFLIGHT_SCHEMA LOBBY_CODE_PATTERN
  MODEL_RATES OBSERVER_DATA_SCHEMA OBSERVER_SCHEMA OBSERVER_STATIC_HOST
  OPENAI_RESPONSES_CU_CAPABILITIES OSS_LAB_SCHEMA PRICING_SCHEMA REVIEW_SCHEMA RUNS_SCHEMA
  RUN_BUNDLE_SCHEMA SCRIPTED_BROWSER_CAPABILITIES SCRIPTED_BROWSER_LAB_SCHEMA
  SCRIPTED_BROWSER_PROVIDER SHARED_WORLD_LAB_PROVIDER_METADATA SHARED_WORLD_LAB_SCHEMA
  SHARED_WORLD_SCHEMA STUDY_ANALYSIS_CORRECTION_SCHEMA STUDY_ANALYSIS_SCHEMA
  TERMINAL_AGENT_CAPABILITIES TERMINAL_AGENT_NOT_IMPLEMENTED_CODE TERMINAL_PRODUCT_LAB_SCHEMA
  VERIFY_SCHEMA actorRegistry adapterScoreFailureMessage analyzeStudy
  applyAdapterScoreFailureToReview applyBrowserAdapterHooks automaticAnalysisBudget
  buildConcurrentSharedWorldBundle buildCuaBundle buildCuaFanoutBundle buildObserverData
  buildScriptedLabBundle buildSharedWorldBundle buildTerminalProductBundle cleanupRun
  codexResultToActorTrace codexStatusToCompletionReason correctStudyAnalysis
  createE2BDesktopExecutor createObserverStaticHandler createProgram describeCuaAction doctor
  draftFeedback estimateActorCost estimateAllocatedDesktopCost estimateDesktopCost
  extractLobbyCode extractLocalActorVerdict getActor isCuaActorDescriptor isDevicePresetName
  isHttpUrl isLoopbackUrl isScriptedBrowserActorDescriptor isTerminalActorDescriptor listFeedback
  listRuns loadE2BDesktopModule normalizeCliArgv normalizeLocalActorTranscript
  normalizeOssRepoSlugs observerStaticContentType openTarget probeUrl readAutomaticStudyAnalysis
  readDetachedLog readReview renderIssueMarkdown renderIssueUrl
  requestAutomaticStudyAnalysisCancellation resolveAutomaticAnalysis resolveCuaLanePlan
  resolveDevicePreset respondToObserverStaticRequest runAutomaticStudyAnalysis
  runCodexAppServerSession runDetachedStep runInit runLabPreflight runOssLab
  runScriptedBrowserSession runSharedWorldLab runTerminalAgentSession serveObserver
  serveObserverStatic showStudyAnalysis startCodexAppServerUi startDetachedProcess stripAnsi
  subjectStateInvalidReason validateOssRepoSlug verifyFeedback ActorCompletionReason
  ActorDescriptor ActorEstimatedCost ActorId ActorLane ActorPersonaRef ActorProtocol
  ActorRuntimeProvenance ActorStatus ActorStopCause ActorTokenUsage ActorTraceItem
  ActorTraceItemKind AnalysisConcernReview AnalyzeDeps AnalyzeOptions AnalyzeResult
  AutomaticAnalysisBudget AutomaticAnalysisResult AutomaticStudyAnalysisCancellation
  AutomaticStudyAnalysisDeps AutomaticStudyAnalysisOutcome AutomaticStudyAnalysisView
  BrowserAdapterBackend BrowserPersonaJourney BrowserSurface CleanupAdapterResult
  CleanupResourceResult CleanupResult CliIo CodexAnalysisIdentity CodexAppServerRunOptions
  CodexAppServerRunResult CodexAppServerTrace CodexAppServerUiController CodexAppServerUiOptions
  CodexAppServerUiState CodexStudyAnalysisConfig CommandLogRecord CommsAddress CommsChannel
  CommsChannelKind CommsMessage CommsReceivingEvidence CommsThreadArtifact CommsThreadEntry
  ConcurrentSharedWorldLabErrorCode ConcurrentSharedWorldPlaneClass
  ConcurrentSharedWorldRoleResult CostCategory CostLine CuaActorDescriptor CuaActorLabErrorCode
  CuaActorSessionOptions CuaLanePlan CuaLanePlanEntry CuaLaneResult CuaLaneSummary
  CuaSubjectProjection DesktopCostEstimate DesktopRate DesktopResourceRate DesktopResources
  DetachedStepOptions DetachedStepResult DetachedTimers DevicePreset DevicePresetName DoctorResult
  E2BDesktopExecutorOptions E2BDesktopLike E2BDesktopModule FakeInboxOptions FeedbackDraft
  FeedbackResult FetchLike InboundRaw InitChange InitMode InitOptions InitResult
  InterventionRecord LabActor LabActorLane LabAnalysis LabConfigParseResult LabExecutionTerminal
  LabPreflightCheck LabPreflightReachabilityMode LabPreflightResult LabPreflightSandbox
  LabPreflightSpend LabPreflightTarget LabRuntimeAuth LabScenarioCaps LabStateStepWhen LabSubject
  LabSubjectProduct LabSubjectServe LabSubjectSource LabSubjectState LabSubjectStateCheckpoint
  LabSubjectStateStep LabSubjectTopology LabTerminalStdin LabTerminalTransport LifecycleRecord
  LoadedStudyAnalysis ModelRate NoSpendProof ObserverData ObserverOptions ObserverServeOptions
  ObserverServer ObserverStaticHandlerOptions ObserverStaticServeOptions ObserverStaticServer
  ObserverStream OpenAIStudyAnalysisConfig OssLabOptions OssLabRepoResult OssLabResult OssLabStep
  OutboundMessage ParticipantClosingReport ReceivingParticipantEvidence ReviewSummary
  RunAttributionClass RunCleanupHooks RunCostLine RunCostSummary RunDesktopGeometry RunEvent
  RunLabPreflightOptions RunMeaningfulUseComponentId RunMeaningfulUseScore
  RunParticipantAssignment RunProviderResource RunScorerProvenance RunSharedWorldLabOptions
  RunSimulation RunStream RunStreamKind RunSubjectProvenance RunSubjectStateStepRecord RunsResult
  ScriptedBrowserActorDescriptor ScriptedBrowserLabSession ScriptedBrowserLaunchArgs
  ScriptedBrowserLike ScriptedBrowserSessionOptions ScriptedBrowserSessionResult
  ScriptedLocatorLike ScriptedPageLike SharedWorldCheckpoint SharedWorldEvidence
  SharedWorldLabErrorCode SharedWorldLabResult SharedWorldLaneWindow SharedWorldOutcome
  SharedWorldPlane SharedWorldRoleResult SharedWorldSkippedTail SharedWorldStateSnapshot
  SharedWorldTimelineEntry SharedWorldTurn StudyAnalysisArtifact StudyAnalysisConfig
  StudyAnalysisCorrection StudyAnalysisResult TerminalActorDescriptor TerminalAgentSessionOptions
  TerminalAgentSessionResult TerminalCostLedger TerminalLedgers UnexpectedErrorEnvelope
`
  .trim()
  .split(/\s+/);
