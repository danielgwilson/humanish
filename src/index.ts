// The library surface: what an adopter needs to run a study, read a run, bring a participant or
// score a run. Everything else is internal and reached through the `humanish` bin. See
// docs/contracts/schemas.md, "Library options", and the site's library page.

// Run a study.
export { runPackageLab as runStudy } from "./run-lab.js";
export type {
  LabOutcome as StudyOutcome,
  LabResult as StudyResult,
  RunLabOptions as RunStudyOptions,
} from "./run-lab.js";
export type { StudyEvent } from "./study/run-study-events.js";
export type { ProviderContext } from "./study/run-study-homes.js";
export { routeOf } from "./study/plan.js";
export type { StudyRoute } from "./study/plan.js";
export { parseStudy } from "./study/config.js";
export { STUDY_SCHEMA } from "./study/types.js";
export type { StudyConfig } from "./study/types.js";

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
  CuaAction as ComputerUseAction,
  CuaExecutor as ComputerUseExecutor,
  CuaLoopOptions as ComputerUseLoopOptions,
  CuaLoopResult as ComputerUseLoopResult,
  CuaObservation as ComputerUseObservation,
  CuaProvider as ComputerUseProvider,
  CuaSafetyCheck as ComputerUseSafetyCheck,
  CuaTurn as ComputerUseTurn,
  CuaTurnRequest as ComputerUseTurnRequest,
} from "./actors/computer-use/loop.js";
export type { ActorCapabilities } from "./actors/contract.js";
export { createOpenAiResponsesProvider } from "./actors/computer-use/openai-provider.js";
export type { OpenAiResponsesProviderOptions } from "./actors/computer-use/openai-provider.js";
export { CuaAdmissionLimitError as ComputerUseAdmissionLimitError } from "./actors/computer-use/admission-limit.js";
export { defaultRedactionHooks } from "./evidence/redaction.js";
export type { RedactionHooks } from "./evidence/redaction.js";
export type { E2BDesktopSandbox } from "./substrates/e2b/sdk.js";

// Score a run.
export { browserScorer, terminalScorer } from "./study/adapter-scorer-loader.js";
export type { AdapterScorerModule, AdapterScoringContext } from "./study/adapter-scorer-loader.js";
export type { BrowserScoringContext } from "./study/adapter-extension.js";
export type { TerminalProductScoringContext } from "./routes/terminal/types.js";
export type { RunAdapterArtifact, RunAdapterScore } from "./run/bundle.js";

// The 0.107 names, deprecated until 0.109 removes them. Each is its new name's value or type.
export {
  CuaAdmissionLimitError,
  LAB_CONFIG_SCHEMA,
  parseLabConfig,
  runLab,
} from "./library-aliases.js";
export type {
  BrowserLabScoringContext,
  CuaAction,
  CuaExecutor,
  CuaLoopOptions,
  CuaLoopResult,
  CuaObservation,
  CuaProvider,
  CuaSafetyCheck,
  CuaTurn,
  CuaTurnRequest,
  LabConfig,
  LabEvent,
  LabOutcome,
  LabResult,
  LabRoute,
  RunLabOptions,
} from "./library-aliases.js";
