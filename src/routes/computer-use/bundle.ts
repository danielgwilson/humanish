// The computer-use route's judge and bundle builder. judgeComputerUseRun judges a run by its shape,
// and buildCuaRunBundle sends it to the single-participant or the fan-out builder with that
// shape's arguments. renderCuaReviewMarkdown writes review.md. shared-world/bundle.ts holds the
// same for that route.

import type { ActorTrace } from "../../actors/contract.js";
import type { CuaActorDescriptor } from "../../actors/registry.js";
import type { ComputerUsePlan } from "../../study/plan-types.js";
import type {
  BundleRun,
  RunBundle,
  RunRerunLineage,
  RunSubjectProvenance,
} from "../../run/bundle.js";
import { judgeOneParticipant, judgeParticipants, type Judgment } from "../../run/judge.js";
import { renderReviewMarkdown } from "../../run/review-markdown.js";
import { desktopSpanToMinutes } from "../../run/cost-summary.js";
import { e2bDesktopTemplate } from "../../substrates/e2b/sandbox.js";
import { providerResourcesForOutcome } from "./bundle-parts.js";
import { participantFactsOf } from "./participant-facts.js";
import { buildCuaFanoutBundle } from "./fanout-bundle.js";
import { buildSingleParticipantBundle } from "./single-bundle.js";
import type { HostSuspensionReading } from "../../run/host-suspension.js";
import type { CuaParticipantPlan, DesktopParticipantRun, ParticipantRunOutcome } from "./types.js";
import { plural } from "../../run/text.js";

/** What every bundle of one run shares, in progress or final. */
export interface CuaRunBundleBase {
  /** The run every bundle of it belongs to. */
  run: BundleRun;
  participantRuns: DesktopParticipantRun[];
  descriptor: CuaActorDescriptor;
  appUrl: string;
  plan: ComputerUsePlan;
  source: RunBundle["source"];
  participantPlan: CuaParticipantPlan;
  rerun?: RunRerunLineage;
  redactScreenshots: boolean;
  publicRepo?: string;
}

/** One participant without a rerun keeps the single-participant bundle shape and its rule. */
function isOneParticipantRun(base: Pick<CuaRunBundleBase, "participantRuns" | "rerun">): boolean {
  return base.participantRuns.length === 1 && base.rerun === undefined;
}

/**
 * The judgment for the current state of a computer-use run, by the rule for its shape: one
 * participant (its tallied status is the verdict) or several (every participant must pass). The bundle's
 * verdict and the study result's ok both come from it.
 */
export function judgeComputerUseRun(
  base: Pick<CuaRunBundleBase, "participantRuns" | "rerun">,
  state: { dryRun: boolean; outcomes: ParticipantRunOutcome[] | undefined; inProgress?: true },
): Judgment {
  const inProgress = state.inProgress === true;
  if (isOneParticipantRun(base)) {
    const outcome = state.outcomes?.[0];
    return judgeOneParticipant({
      dryRun: state.dryRun,
      inProgress,
      participant: outcome === undefined ? undefined : participantFactsOf(outcome),
    });
  }
  return judgeParticipants({
    dryRun: state.dryRun,
    inProgress,
    expected: base.participantRuns.length,
    participants: (state.outcomes ?? []).map(participantFactsOf),
  });
}

/** The run's state a bundle is built from, in progress or final. */
interface CuaRunBundleState {
  judgment: Judgment;
  dryRun: boolean;
  outcomes: ParticipantRunOutcome[] | undefined;
  subjects: RunSubjectProvenance[];
  aggregateSubject: RunSubjectProvenance;
  failFastReason?: string;
  /** The final bundle's reading of the run's host suspensions. */
  hostSuspension?: HostSuspensionReading;
  inProgress?: true;
}

/**
 * The run bundle for the current state of a computer-use run. One participant without a rerun
 * keeps the single-participant shape; a fan-out or a rerun uses the fan-out shape, which carries
 * the participant plan and each participant's subject. Both argument mappings are here.
 */
export function buildCuaRunBundle(base: CuaRunBundleBase, state: CuaRunBundleState): RunBundle {
  const inProgress = state.inProgress === undefined ? {} : { inProgress: true };
  if (isOneParticipantRun(base))
    return buildSingleParticipantBundle(singleParticipantArgs(base, state));
  return buildCuaFanoutBundle({
    verdict: state.judgment.verdict,
    run: base.run,
    specs: base.participantRuns,
    ...(state.outcomes === undefined ? {} : { outcomes: state.outcomes }),
    subjects: state.subjects,
    aggregateSubject: state.aggregateSubject,
    descriptor: base.descriptor,
    appUrl: base.appUrl,
    dryRun: state.dryRun,
    plan: base.plan,
    source: base.source,
    participantPlan: base.participantPlan,
    ...(base.rerun === undefined ? {} : { rerun: base.rerun }),
    ...(state.failFastReason === undefined ? {} : { failFastReason: state.failFastReason }),
    ...(state.hostSuspension === undefined ? {} : { hostSuspension: state.hostSuspension }),
    ...(base.publicRepo === undefined ? {} : { publicRepo: base.publicRepo }),
    ...inProgress,
  });
}

/** The single-participant builder's arguments, from the run's base and current state. */
function singleParticipantArgs(
  base: CuaRunBundleBase,
  state: CuaRunBundleState,
): Parameters<typeof buildSingleParticipantBundle>[0] {
  const spec = base.participantRuns[0]!;
  const outcome = state.outcomes?.[0];
  const { plan } = base;
  const desktopTemplate = e2bDesktopTemplate(plan.residual);
  return {
    verdict: state.judgment.verdict,
    realEmail: plan.residual.comms?.email?.kind === "real",
    run: base.run,
    actorId: base.descriptor.id,
    appUrl: spec.planned.targetUrl ?? base.appUrl,
    participantId: spec.planned.id,
    ...(spec.planned.labels.actorType === undefined
      ? {}
      : { actorType: spec.planned.labels.actorType }),
    ...(spec.planned.labels.surface === undefined ? {} : { surface: spec.planned.labels.surface }),
    ...(spec.planned.labels.caseGroup === undefined
      ? {}
      : { caseGroup: spec.planned.labels.caseGroup }),
    dryRun: state.dryRun,
    studyId: plan.studyId,
    ...(plan.title ? { studyTitle: plan.title } : {}),
    mission: spec.evidenceInstructions ?? spec.instructions,
    ...(spec.evidenceAssignment === undefined ? {} : { assignment: spec.evidenceAssignment }),
    persona: spec.persona,
    resolution: spec.planned.device.resolution,
    deviceName: spec.planned.device.name,
    desktopRoute: base.plan.runner.desktop !== "in-process",
    substrate:
      base.plan.runner.desktop === "in-process"
        ? "local-filesystem"
        : plan.residual.execution?.target === "local"
          ? "local-desktop"
          : "e2b-desktop",
    ...(outcome?.desktopGeometry === undefined ? {} : { desktopGeometry: outcome.desktopGeometry }),
    ...(outcome?.recording === undefined ? {} : { recording: outcome.recording }),
    isMobile: spec.planned.device.preset.isMobile,
    screenshots: outcome?.screenshots ?? [],
    captureRedaction: base.redactScreenshots ? "blurred" : "raw",
    ...(outcome?.session ? { session: outcome.session } : {}),
    ...(outcome?.sessionError !== undefined ? { sessionError: outcome.sessionError } : {}),
    ...(outcome === undefined
      ? {}
      : {
          credibility: {
            noEngagement: outcome.noEngagement === true,
            selfReportedBlocker: outcome.selfReportedBlocker === true,
            reportedFriction: outcome.reportedFriction === true,
          },
        }),
    source: base.source,
    ...(state.inProgress === undefined ? {} : { inProgress: state.inProgress }),
    ...(state.hostSuspension === undefined ? {} : { hostSuspension: state.hostSuspension }),
    subject: state.aggregateSubject,
    ...(desktopTemplate === undefined ? {} : { desktopTemplate }),
    ...(outcome?.desktopBrowser === undefined ? {} : { desktopBrowser: outcome.desktopBrowser }),
    providerResources: providerResourcesForOutcome({
      outcome,
      createdAt: base.run.createdAt,
      ids: spec,
      participantId: spec.planned.id,
    }),
    ...(base.plan.runner.subject.kind === "local-app" || base.plan.runner.desktop === "in-process"
      ? { entryKind: "local-app" as const }
      : {}),
    ...(outcome?.session ? { traceArtifactPath: spec.traceArtifactPath } : {}),
    ...(outcome?.commsArtifactPath === undefined
      ? {}
      : { commsArtifactPath: outcome.commsArtifactPath }),
    ...(desktopSpanToMinutes(outcome?.desktopDurationMs) === undefined
      ? {}
      : { desktopMinutes: desktopSpanToMinutes(outcome?.desktopDurationMs)! }),
    ...(outcome?.sandboxId === undefined
      ? {}
      : {
          desktopUsage: {
            participantId: spec.planned.id,
            minutes: desktopSpanToMinutes(outcome.desktopDurationMs),
            observation: outcome.desktopResources,
            lifetimeComplete: outcome.killed,
          },
        }),
    phaseEvents: outcome?.phaseRecords ?? [],
  };
}

/** The run's review.md: title, run, mode, gate, summary, subject, actor evidence and gaps. */
export function renderCuaReviewMarkdown(bundle: RunBundle, status?: unknown): string {
  const trace: ActorTrace | undefined = bundle.streams[0]?.actor;
  const provenance = bundle.events.find((event) => event.type === "cua-lab.subject.provenance");
  return renderReviewMarkdown(
    bundle,
    [
      ...(provenance ? [`- subject: ${provenance.message}`] : []),
      ...(trace
        ? [
            `- actor: ${trace.provider} (${trace.lane}/${trace.protocol})`,
            // Name the trace's actual screenshot mode ("raw" | "blurred"); say
            // nothing when no frames exist ("n/a") rather than claim a redaction that never ran.
            `- evidence: ${plural(trace.items.length, "trace item")}, ${plural(
              trace.counts.screenshots ?? 0,
              trace.redaction.screenshots === "raw" || trace.redaction.screenshots === "blurred"
                ? `${trace.redaction.screenshots} screenshot`
                : "screenshot",
            )}`,
          ]
        : []),
    ],
    { status },
  );
}
