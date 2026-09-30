// The LabPlan union: what planLab decides about a lab before anything runs. Each route has its own
// variant, and each supported subject and substrate pairing is its own case, so a combination the
// routes refuse cannot be written down. Numeric bounds, unique ids, safe URLs and "exactly one
// host" stay checks in planLab.

import type { StudyAnalysisConfig } from "../analysis/study-analysis.js";
import type { LocalAgentId } from "../actors/local-agent/cli.js";
import type { ReasoningEffort } from "../actors/reasoning-effort.js";
import type { BrowserSurface } from "../actors/scripted-browser/types.js";
import type { ScriptedRefusal } from "../routes/scripted-browser/plan.js";
import type { TerminalRefusal } from "../routes/terminal/plan.js";
import type { RunLabProvenance } from "../run/status.js";
import type { RunLabOptions } from "./engine.js";
import type { ComputerUseRefusal } from "../routes/computer-use/plan.js";
import type {
  ComputerUseParticipant,
  ExternalPublicSeat,
  ProvisionedSeat,
} from "./plan-participants.js";
import type { LabRoute } from "./plan.js";
import type {
  LabConfig,
  LabRuntimeAuth,
  LabScenarioCaps,
  LabSubjectProduct,
  LabSubjectServe,
  LabSubjectState,
  LabSubjectStateCheckpoint,
} from "./types.js";

export type NonEmpty<T> = readonly [T, ...T[]];
export type AtLeastTwo<T> = readonly [T, T, ...T[]];

/** Something a route checks right before acquisition. Doctor, the TUI and preflight list the same set. */
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

/** Config fields no plan field decides. Routes read nothing else from the config. */
export type ResidualConfig = Pick<
  LabConfig,
  "comms" | "policies" | "personas" | "defaults" | "review"
> & {
  readonly execution?: Pick<NonNullable<LabConfig["execution"]>, "desktop">;
  readonly subject: Pick<LabConfig["subject"], "clone" | "localTree" | "repos">;
};

export interface PlannedAnalysis {
  readonly config: StudyAnalysisConfig;
  /** "default" when the lab declared no review.analysis. */
  readonly trigger: "default" | "explicit";
  readonly preferLargerOutput: boolean;
}

interface PlanBase {
  readonly labId: string;
  readonly lab?: RunLabProvenance;
  /** A frozen copy owned by the plan. */
  readonly residual: Readonly<ResidualConfig>;
  readonly dryRun: boolean;
  readonly analysis?: PlannedAnalysis;
  /** Empty for a dry run. */
  readonly requirements: readonly Requirement[];
}

/**
 * The synthetic preview. runDryRun still checks the project directory, the sim count and a live
 * request, in that order, so the plan carries both values unchecked.
 */
interface PreviewPlan extends PlanBase {
  readonly route: "preview";
  readonly simCount: number;
}

/** The model driving a desktop participant. `caller` is the library caller's buildProvider. */
export type Brain =
  | { readonly kind: "openai"; readonly model: string }
  | { readonly kind: "local-agent"; readonly agent: LocalAgentId }
  | { readonly kind: "caller" };

export type ProvisionedSubject =
  | {
      readonly kind: "clone";
      readonly repo: string;
      readonly serve: LabSubjectServe;
      readonly env: readonly string[];
      readonly state?: LabSubjectState;
    }
  | {
      readonly kind: "local-tree";
      readonly serve: LabSubjectServe;
      readonly env: readonly string[];
      readonly state?: LabSubjectState;
    };

export interface AppUrlSubject {
  readonly kind: "app-url";
  readonly appUrl: string;
  readonly publicTargets: boolean;
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
        | { readonly kind: "desktop-cli"; readonly product: LabSubjectProduct };
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
      readonly brain: { readonly kind: "caller" };
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

type CheckpointedState = LabSubjectState & {
  readonly checkpoint: NonEmpty<LabSubjectStateCheckpoint>;
};

export type SharedWorldPlane =
  | {
      readonly kind: "provisioned";
      readonly subject: ProvisionedSubject & { readonly state: CheckpointedState };
      readonly participants: AtLeastTwo<ProvisionedSeat>;
    }
  | {
      readonly kind: "external-public";
      readonly appUrl: string;
      readonly owner: string;
      readonly participants: AtLeastTwo<ExternalPublicSeat>;
    };

export interface SharedWorldPlan extends PlanBase {
  readonly route: "shared-world";
  readonly plane: SharedWorldPlane;
  /** At least 2. */
  readonly concurrency: number;
  readonly brain: Extract<Brain, { kind: "openai" | "local-agent" }>;
  readonly caps: { readonly maxUsd?: number; readonly maxTotalUsd?: number };
}

export type TerminalPlan = PlanBase & {
  readonly route: "terminal";
  /** The registered terminal actor that runs. */
  readonly actor: string;
  readonly product: LabSubjectProduct & { readonly publicSurfaces: NonEmpty<string> };
  /** The declared persona and mission; the route supplies its defaults. */
  readonly personaId?: string;
  readonly mission?: string;
  readonly runtime: {
    readonly version?: string;
    readonly model?: string;
    readonly reasoningEffort?: ReasoningEffort;
    readonly auth?: LabRuntimeAuth;
  };
} & (
    | { readonly dryRun: true; readonly caps?: LabScenarioCaps }
    | {
        readonly dryRun: false;
        readonly caps: LabScenarioCaps & { readonly maxUsd: number; readonly maxMinutes: number };
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

export type LabPlan = PreviewPlan | ComputerUsePlan | SharedWorldPlan | TerminalPlan | ScriptedPlan;

/** The hook bags planLab read, kept with the plan so dispatch cannot pair it with other hooks. */
export type LabBindings = Pick<
  RunLabOptions,
  "cuaHooks" | "scriptedHooks" | "terminalHooks" | "sharedWorldHooks"
>;

interface PlannedLab {
  readonly plan: LabPlan;
  readonly bindings: LabBindings;
}

/**
 * A combination the plan types cannot hold. Each rule is refused by a route today; the route's
 * code and message move here when that route adopts planLab.
 */
export type PlanGap = "analysis-invalid" | "unsupported-composition";

/** The error codes the preview route returns before a run starts. */
type PreviewRefusalCode =
  | "HUMANISH_LAB_COMMS_UNSUPPORTED"
  | "HUMANISH_LAB_ANALYSIS_INVALID"
  | "HUMANISH_LAB_ANALYSIS_UNSUPPORTED"
  | "HUMANISH_LAB_TASKS_UNSUPPORTED";

/**
 * Why planLab refused. A route that runs on the plan gets its own code and message; a route that
 * has not moved onto the plan yet gets the gap.
 */
export type PlanRefusal =
  | { readonly route: "preview"; readonly code: PreviewRefusalCode; readonly message: string }
  | TerminalRefusal
  | ScriptedRefusal
  | ComputerUseRefusal
  | { readonly route: LabRoute; readonly gap: PlanGap };

export type PlanResult =
  | { readonly ok: true; readonly planned: PlannedLab }
  | { readonly ok: false; readonly refusal: PlanRefusal };
