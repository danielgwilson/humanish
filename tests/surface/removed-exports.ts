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
