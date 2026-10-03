// The names 0.107's library exported for running a lab and driving a computer-use participant.
// Each is the same function, constant, class or type as the name that replaces it, so an existing
// import, call or `instanceof` check keeps working, and editors mark it deprecated.
// Removed in 0.109.0: this module and its exports in src/index.ts.

import { CuaAdmissionLimitError as AdmissionLimitError } from "./actors/computer-use/admission-limit.js";
import type {
  CuaAction as Action,
  CuaExecutor as Executor,
  CuaLoopOptions as LoopOptions,
  CuaLoopResult as LoopResult,
  CuaObservation as Observation,
  CuaProvider as Provider,
  CuaSafetyCheck as SafetyCheck,
  CuaTurn as Turn,
  CuaTurnRequest as TurnRequest,
} from "./actors/computer-use/loop.js";
import type { BrowserScoringContext } from "./study/adapter-extension.js";
import { parseStudy } from "./study/config.js";
import type { StudyRoute } from "./study/routing.js";
import type { StudyEvent } from "./study/run-study-events.js";
import { V2_SCHEMA, type StudyConfig } from "./study/types.js";
import {
  runPackageLab as runStudy,
  type LabOutcome as StudyOutcome,
  type LabResult as StudyResult,
  type RunLabOptions as RunStudyOptions,
} from "./run-lab.js";

/** @deprecated Use `runStudy`, the same function. 0.109 removes `runLab`. */
export const runLab = runStudy;

/** @deprecated Use `parseStudy`, the same function. 0.109 removes `parseLabConfig`. */
export const parseLabConfig = parseStudy;

/**
 * The `humanish.lab.v2` schema id, which 0.109 stops parsing.
 * @deprecated Write `STUDY_SCHEMA` (`humanish.study.v3`) files. 0.109 removes `LAB_CONFIG_SCHEMA`.
 */
export const LAB_CONFIG_SCHEMA = V2_SCHEMA;

/** @deprecated Use `StudyConfig`, the same type. 0.109 removes `LabConfig`. */
export type LabConfig = StudyConfig;

/** @deprecated Use `StudyEvent`, the same type. 0.109 removes `LabEvent`. */
export type LabEvent = StudyEvent;

/** @deprecated Use `StudyOutcome`, the same type. 0.109 removes `LabOutcome`. */
export type LabOutcome = StudyOutcome;

/** @deprecated Use `StudyResult`, the same type. 0.109 removes `LabResult`. */
export type LabResult<R extends StudyRoute = StudyRoute> = StudyResult<R>;

/** @deprecated Use `StudyRoute`, the same type. 0.109 removes `LabRoute`. */
export type LabRoute = StudyRoute;

/** @deprecated Use `RunStudyOptions`, the same type. 0.109 removes `RunLabOptions`. */
export type RunLabOptions = RunStudyOptions;

/** @deprecated Use `BrowserScoringContext`, the same type. 0.109 removes `BrowserLabScoringContext`. */
export type BrowserLabScoringContext = BrowserScoringContext;

/**
 * @deprecated Use `ComputerUseAdmissionLimitError`, the same class, so `instanceof` matches either
 * name. 0.109 removes `CuaAdmissionLimitError`.
 */
export const CuaAdmissionLimitError = AdmissionLimitError;
/** @deprecated Use `ComputerUseAdmissionLimitError`. 0.109 removes `CuaAdmissionLimitError`. */
export type CuaAdmissionLimitError = AdmissionLimitError;

/** @deprecated Use `ComputerUseAction`, the same type. 0.109 removes `CuaAction`. */
export type CuaAction = Action;

/** @deprecated Use `ComputerUseExecutor`, the same type. 0.109 removes `CuaExecutor`. */
export type CuaExecutor = Executor;

/** @deprecated Use `ComputerUseLoopOptions`, the same type. 0.109 removes `CuaLoopOptions`. */
export type CuaLoopOptions = LoopOptions;

/** @deprecated Use `ComputerUseLoopResult`, the same type. 0.109 removes `CuaLoopResult`. */
export type CuaLoopResult = LoopResult;

/** @deprecated Use `ComputerUseObservation`, the same type. 0.109 removes `CuaObservation`. */
export type CuaObservation = Observation;

/** @deprecated Use `ComputerUseProvider`, the same type. 0.109 removes `CuaProvider`. */
export type CuaProvider = Provider;

/** @deprecated Use `ComputerUseSafetyCheck`, the same type. 0.109 removes `CuaSafetyCheck`. */
export type CuaSafetyCheck = SafetyCheck;

/** @deprecated Use `ComputerUseTurn`, the same type. 0.109 removes `CuaTurn`. */
export type CuaTurn = Turn;

/** @deprecated Use `ComputerUseTurnRequest`, the same type. 0.109 removes `CuaTurnRequest`. */
export type CuaTurnRequest = TurnRequest;
