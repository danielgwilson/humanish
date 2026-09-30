// The library surface: what an adopter needs to run a lab, read a run, bring a participant or
// score a run. Everything else is internal and reached through the `humanish` bin. See
// docs/contracts/schemas.md, "Library options", and the site's library page.

// Run a lab.
export { runLab } from "./lab/engine.js";
export type { LabOutcome, LabResult, RunLabOptions } from "./lab/engine.js";
export type { LabEvent, ProviderContext } from "./lab/run-lab-options.js";
export { routeOf } from "./lab/plan.js";
export type { LabRoute } from "./lab/plan.js";
export { parseLabConfig } from "./lab/config.js";
export { LAB_CONFIG_SCHEMA } from "./lab/types.js";
export type { LabConfig } from "./lab/types.js";

// Read a run.
export { verifyRun } from "./verify/verify.js";
export type { VerifyResult } from "./verify/verify.js";
export { renderObserver } from "./observer/render.js";
export type { ObserverResult } from "./observer/render.js";
export type { RunBundle, RunFeedbackCandidate } from "./run/bundle.js";
export type { ActorTrace } from "./actors/contract.js";

// Bring a participant.
export { runComputerUseLoop, stableProgressKey } from "./actors/computer-use/loop.js";
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
export type { ActorCapabilities } from "./actors/contract.js";
export { createOpenAiResponsesProvider } from "./actors/computer-use/openai-provider.js";
export type { OpenAiResponsesProviderOptions } from "./actors/computer-use/openai-provider.js";
export { CuaAdmissionLimitError } from "./actors/computer-use/admission-limit.js";
export { defaultRedactionHooks } from "./evidence/redaction.js";
export type { RedactionHooks } from "./evidence/redaction.js";
export type { E2BDesktopSandbox } from "./substrates/e2b/sdk.js";

// Score a run.
export type { AdapterScorerModule, AdapterScoringContext } from "./lab/adapter-scorer-loader.js";
export type { BrowserLabScoringContext } from "./lab/adapter-extension.js";
export type { TerminalProductScoringContext } from "./routes/terminal/types.js";
export type { RunAdapterArtifact, RunAdapterScore } from "./run/bundle.js";

// Routing: the planLab series deprecates these and removes them in the next minor.
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
  concurrentSharedWorldValidationReason,
  cuaLaneValidationReason,
  externalPublicSharedWorldValidationReason,
  sharedWorldValidationReason,
} from "./lab/validation.js";
export { resolveLabDryRun, selectLabBackend } from "./lab/engine.js";
export type { LabBackend } from "./lab/engine.js";

// Deprecated this minor, removed in the next.
export {
  runConcurrentSharedWorld,
  runCuaActorLab,
  runCuaActorSession,
  runDryRun,
  runScriptedBrowserLab,
  runTerminalProductLab,
} from "./deprecated.js";
export type {
  AutomaticAnalysisHooks,
  BrowserLabAdapterHooks,
  ConcurrentSharedWorldLabResult,
  CuaActorLabHooks,
  CuaActorLabResult,
  RunConcurrentSharedWorldLabOptions,
  RunCuaActorLabOptions,
  RunOptions,
  RunResult,
  RunScriptedBrowserLabOptions,
  RunTerminalProductLabOptions,
  ScriptedBrowserLabHooks,
  ScriptedBrowserLabResult,
  SharedWorldLabHooks,
  SubjectPhaseEvent,
  TerminalProductLabHooks,
  TerminalProductLabResult,
} from "./deprecated.js";
