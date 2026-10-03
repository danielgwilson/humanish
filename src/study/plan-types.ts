// The StudyPlan union: what planStudy decides about a study before anything runs. Each route has its own
// variant, and each supported subject and substrate pairing is its own case, so a combination the
// routes refuse cannot be written down. Numeric bounds, unique ids, safe URLs and "exactly one
// host" stay checks in planStudy.

import type { AnalysisConfig } from "../analysis/types.js";
import type { LocalAgentId } from "../actors/local-agent/cli.js";
import type { ReasoningEffort } from "../actors/reasoning-effort.js";
import type { BrowserSurface } from "../actors/scripted-browser/types.js";
import type { ScriptedRefusal } from "../routes/scripted/plan.js";
import type { TerminalRefusal } from "../routes/terminal/plan.js";
import type { RunStudyProvenance } from "../run/study-provenance.js";
import type { ComputerUseRefusal } from "../routes/computer-use/plan.js";
import type { SharedWorldRefusal } from "../routes/shared-world/plan.js";
import type {
  ComputerUseParticipant,
  ExternalPublicParticipant,
  ProvisionedParticipant,
} from "./plan-participants.js";
import type {
  StudyConfig,
  StudyExecutionTerminal,
  StudyRuntimeAuth,
  StudyScenarioCaps,
  StudySubjectProduct,
  StudySubjectServe,
  StudySubjectState,
  StudySubjectStateCheckpoint,
} from "./types.js";

export type NonEmpty<T> = readonly [T, ...T[]];
type AtLeastTwo<T> = readonly [T, T, ...T[]];

/**
 * Something a route checks right before acquisition. Preflight refuses on, and doctor and the TUI
 * report, the keys and subject env listed here, through src/study/requirements.ts.
 */
export type Requirement =
  | { readonly kind: "key"; readonly name: "OPENAI_API_KEY" | "E2B_API_KEY" }
  /** The terminal runtime key: CODEX_API_KEY, else OPENAI_API_KEY. */
  | { readonly kind: "key-one-of"; readonly names: readonly ["CODEX_API_KEY", "OPENAI_API_KEY"] }
  /** Real receiving: the key name comes from the saved connection at check time. */
  | { readonly kind: "receiving-connection"; readonly connection: string }
  | { readonly kind: "subject-env"; readonly names: NonEmpty<string> }
  | { readonly kind: "local-agent"; readonly agent: LocalAgentId }
  | { readonly kind: "local-vm" }
  | { readonly kind: "host-browser" }
  | { readonly kind: "external-catch"; readonly url: string };

/**
 * Config fields no plan field decides. After admission, computer use reads the config only to pass
 * it to the caller's createProvider and inProcess executor; its planner, refusal envelopes and local
 * VM study read it before a plan exists. Shared world, terminal and scripted still read some config
 * fields at run time.
 */
export type ResidualConfig = Pick<
  StudyConfig,
  "comms" | "policies" | "personas" | "defaults" | "review"
> & {
  readonly execution?: Pick<NonNullable<StudyConfig["execution"]>, "desktop" | "target">;
  readonly subject: Pick<StudyConfig["subject"], "clone" | "localTree" | "repos" | "envValues">;
};

export interface PlannedAnalysis {
  readonly config: AnalysisConfig;
  /** "default" when the study declared no review.analysis. */
  readonly trigger: "default" | "explicit";
  readonly preferLargerOutput: boolean;
}

interface PlanBase {
  readonly studyId: string;
  /** The study's declared title, which bundles record. */
  readonly title?: string;
  readonly study?: RunStudyProvenance;
  /** A frozen copy owned by the plan. */
  readonly residual: Readonly<ResidualConfig>;
  readonly dryRun: boolean;
  readonly analysis?: PlannedAnalysis;
  /** Empty for a dry run. */
  readonly requirements: readonly Requirement[];
}

/**
 * The synthetic preview. planPreview refuses a count that is not a positive integer and a live
 * request, so the plan carries only a dry run and a checked count. runDryRun still checks the
 * project directory, which needs the file system.
 */
interface PreviewPlan extends PlanBase {
  readonly route: "preview";
  readonly dryRun: true;
  /** A safe integer of at least 1. */
  readonly participantCount: number;
}

/**
 * The model driving a desktop participant. `caller` is the library caller's createProvider.
 * `declaredModel` is actors[0].model as the study wrote it, absent when undeclared: the providers
 * take it as written, and spend is priced at it, else the default (pricedModel). An openai
 * brain's `model` is the one its provider runs, with that default applied.
 */
export type Brain =
  | { readonly kind: "openai"; readonly model: string; readonly declaredModel?: string }
  | { readonly kind: "local-agent"; readonly agent: LocalAgentId; readonly declaredModel?: string }
  | { readonly kind: "caller"; readonly declaredModel?: string };

export type ProvisionedSubject =
  | {
      readonly kind: "clone";
      readonly repo: string;
      readonly serve: StudySubjectServe;
      readonly env: readonly string[];
      readonly state?: StudySubjectState;
    }
  | {
      readonly kind: "local-tree";
      readonly serve: StudySubjectServe;
      readonly env: readonly string[];
      readonly state?: StudySubjectState;
    };

export interface AppUrlSubject {
  readonly kind: "app-url";
  readonly appUrl: string;
  readonly publicTargets: boolean;
  /**
   * A `subject.serve.url` declared on this subject, which the parser refuses and only a library
   * config can carry. Participants map links to it back to their own app.
   */
  readonly serveUrl?: string;
}

/**
 * Supported subject and desktop pairings. The local VM also takes public targets: the route runs
 * that for a library caller, though the parser never produces it.
 */
export type ComputerUseRunner =
  | {
      readonly desktop: "e2b-desktop";
      readonly brain: Brain;
      readonly participants: NonEmpty<ComputerUseParticipant>;
      readonly subject:
        | AppUrlSubject
        | ProvisionedSubject
        | {
            readonly kind: "desktop-cli";
            readonly product: StudySubjectProduct;
            /** As on AppUrlSubject: a library config's declared `subject.serve.url`. */
            readonly serveUrl?: string;
          };
    }
  | {
      readonly desktop: "local-vm";
      readonly brain: Brain;
      readonly participants: NonEmpty<ComputerUseParticipant>;
      readonly subject: AppUrlSubject;
    }
  /** The caller's executor and provider together; one participant. */
  | {
      readonly desktop: "in-process";
      readonly brain: Extract<Brain, { kind: "caller" }>;
      readonly participants: readonly [ComputerUseParticipant];
      readonly subject: AppUrlSubject | { readonly kind: "local-app"; readonly appUrl: string };
    };

export interface ComputerUsePlan extends PlanBase {
  readonly route: "computer-use";
  /** The registered computer-use actor id. */
  readonly actor: string;
  readonly runner: ComputerUseRunner;
  /** Declared cap clamped to [1, participants]; the route may only lower it from env. */
  readonly concurrency: number;
  readonly sessionBudgetMs: number;
  readonly sandboxMs: number;
  readonly caps: { readonly maxUsd?: number; readonly maxTotalUsd?: number };
  /** The route narrows participants after reading the source run. */
  readonly rerun?: { readonly sourceRunId: string; readonly participantIds?: readonly string[] };
}

type CheckpointedState = StudySubjectState & {
  readonly checkpoint: NonEmpty<StudySubjectStateCheckpoint>;
};

export type SharedWorldPlane =
  | {
      readonly kind: "provisioned";
      readonly subject: ProvisionedSubject & { readonly state: CheckpointedState };
      readonly participants: AtLeastTwo<ProvisionedParticipant>;
    }
  | {
      readonly kind: "external-public";
      readonly appUrl: string;
      readonly owner: string;
      readonly participants: AtLeastTwo<ExternalPublicParticipant>;
    };

export interface SharedWorldPlan extends PlanBase {
  readonly route: "shared-world";
  /** The registered computer-use actor id. */
  readonly actor: string;
  readonly plane: SharedWorldPlane;
  /** At least 2. */
  readonly concurrency: number;
  /** The declared participant session timeout; the route supplies its default. */
  readonly sessionTimeoutMs?: number;
  readonly brain: Extract<Brain, { kind: "openai" | "local-agent" }>;
  readonly caps: { readonly maxUsd?: number; readonly maxTotalUsd?: number };
}

export type TerminalPlan = PlanBase & {
  readonly route: "terminal";
  /** The registered terminal actor that runs. */
  readonly actor: string;
  readonly product: StudySubjectProduct & { readonly publicSurfaces: NonEmpty<string> };
  /** The declared persona and mission; the route supplies its defaults. */
  readonly personaId?: string;
  readonly mission?: string;
  readonly runtime: {
    readonly version?: string;
    /** Passed to Codex as `--model` on every run, so the bundle can name and price it. */
    readonly model: string;
    /** `declared` by the study's actor, or humanish's participant default. */
    readonly modelSource: "declared" | "humanish_default";
    readonly reasoningEffort?: ReasoningEffort;
    readonly auth?: StudyRuntimeAuth;
  };
  /** The declared egress routing allowlist; without one the sandbox egress is unrestricted. */
  readonly egressAllow?: readonly string[];
  /** The declared operator stdin posture; the route defaults to "disabled". */
  readonly stdin?: NonNullable<StudyExecutionTerminal["stdin"]>;
} & (
    | { readonly dryRun: true; readonly caps?: StudyScenarioCaps }
    | {
        readonly dryRun: false;
        readonly caps: StudyScenarioCaps & { readonly maxUsd: number; readonly maxMinutes: number };
      }
  );

export interface ScriptedPlan extends PlanBase {
  readonly route: "scripted";
  /** The registered scripted-browser actor id. */
  readonly actor: string;
  /**
   * The loopback URL is normalized. The parser requires seed state on a clone; the route runs a
   * library caller's clone without it, so the plan does too.
   */
  readonly subject:
    | { readonly kind: "loopback"; readonly appUrl: string }
    | Extract<ProvisionedSubject, { readonly kind: "clone" }>;
  /** Resolved and parsed by the route, right before the run. */
  readonly scenarioRef: string;
  /** Empty only for a library caller's `count: 0`, which the parser refuses; that run has no sessions. */
  readonly surfaces: readonly BrowserSurface[];
  /** The declared persona and session timeout; the route supplies its defaults. */
  readonly personaId?: string;
  readonly sessionTimeoutMs?: number;
}

export type StudyPlan =
  | PreviewPlan
  | ComputerUsePlan
  | SharedWorldPlan
  | TerminalPlan
  | ScriptedPlan;

interface PlannedStudy {
  readonly plan: StudyPlan;
}

/**
 * The error a route returns before a run starts: the route, its error code and a message. Each
 * route's refusal extends it with what that route adds (the registered actor, where the route
 * returns it).
 */
export interface RouteRefusal<Route extends string, Code extends string> {
  readonly route: Route;
  readonly code: Code;
  readonly message: string;
}

/** A route's plan, or the refusal that stopped it before a run started. */
export type RoutePlanResult<Plan, Refusal> =
  | { readonly ok: true; readonly plan: Plan }
  | { readonly ok: false; readonly refusal: Refusal };

/** The error codes the preview route returns before a run starts. */
export type PreviewRefusalCode =
  | "HUMANISH_STUDY_COMMS_UNSUPPORTED"
  | "HUMANISH_STUDY_ANALYSIS_INVALID"
  | "HUMANISH_STUDY_ANALYSIS_UNSUPPORTED"
  | "HUMANISH_STUDY_TASKS_UNSUPPORTED"
  | "HUMANISH_INVALID_PARTICIPANT_COUNT"
  | "HUMANISH_LIVE_RUN_UNIMPLEMENTED";

/** Why planStudy refused: the route's own code and message, as its runner returns them. */
export type PlanRefusal =
  | RouteRefusal<"preview", PreviewRefusalCode>
  | TerminalRefusal
  | ScriptedRefusal
  | ComputerUseRefusal
  | SharedWorldRefusal;

export type PlanResult =
  | { readonly ok: true; readonly planned: PlannedStudy }
  | { readonly ok: false; readonly refusal: PlanRefusal };
