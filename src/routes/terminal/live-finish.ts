// Finishing a live terminal session: the actor trace from the captured stream, the spend ledger
// and its caps check, the evidence files, the bundle, and the lab result.
import { buildRunCostSummary } from "../../run/cost-summary.js";
import type { ActorPersonaRef, ActorTrace } from "../../actors/contract.js";
import type { RunBundle } from "../../run/bundle.js";
import type { RunScope } from "../../run/run.js";
import { writeContainedOutputFile } from "../../run/contained-output.js";
import {
  validatePreparedRunArtifactPaths,
  type PreparedRunArtifactPaths,
} from "../../run/paths.js";
import { estimateAggregatedTurnCost } from "../../run/pricing.js";
import {
  normalizeLocalActorTranscript,
  TERMINAL_EVENTS_ARTIFACT,
  TERMINAL_LEDGERS_ARTIFACT,
  TERMINAL_TRANSCRIPT_ARTIFACT,
} from "../../run/terminal-contract.js";
import { applyAdapterExtensionSeam } from "./adapter.js";
import { buildLiveTerminalProductBundle } from "./bundle.js";
import {
  buildCostLedger,
  buildNoSpendProof,
  describeMeasuredSpend,
  evaluateCapsAgainstLedger,
  noSpendLineMeasured,
  noSpendNotEstablished,
} from "./ledger.js";
import type { LiveSandboxInputs, LiveTerminalSandbox } from "./live-sandbox.js";
import {
  foldScorerFailures,
  judgeExecution,
  judgeTerminal,
  OUTCOME_POLICIES,
} from "../../run/judge.js";
import {
  terminalExecutionFailures,
  terminalStudyResult,
  terminalParticipantFacts,
} from "./result.js";
import { parseTerminalTokenUsage } from "./token-usage.js";
import { buildTerminalActorTrace, scrubSplitKnownValues, tailOf } from "./trace.js";
import type {
  RunLiveTerminalSessionArgs,
  TerminalEventRecord,
  TerminalLedgers,
  TerminalProductStudyResult,
} from "./types.js";

type StartedRun = Extract<Awaited<ReturnType<RunScope["startRun"]>>, { ok: true }>["run"];

/** What the finish reads from the run. */
export interface LiveFinishInputs {
  plan: RunLiveTerminalSessionArgs["plan"];
  input: RunLiveTerminalSessionArgs["input"];
  cwd: string;
  sanitize: (text: string) => string;
  nowIso: () => string;
  knownSecretValues: string[];
  runtimeEnv: LiveSandboxInputs["runtimeEnv"];
  runtime: LiveSandboxInputs["runtime"];
  persona: ActorPersonaRef;
  mission: string;
  run: StartedRun;
  source: RunBundle["source"];
  /** The run's warnings. The finish appends to them. */
  warnings: string[];
  recorder: LiveSandboxInputs["recorder"];
  /** The session's outcome; a blown cap overrides it. */
  session: LiveTerminalSandbox;
}

function buildLiveTrace(inputs: LiveFinishInputs): {
  normalizedTranscript: string;
  trace: ReturnType<typeof buildTerminalActorTrace>;
} {
  const { persona, sanitize, nowIso, runtimeEnv, runtime, knownSecretValues } = inputs;
  const { product } = inputs.plan;
  const { session } = inputs;
  const { createdAt } = inputs.run;
  const { terminalEvents, commandLog, discardedPrefixes } = inputs.recorder;
  // Prefix reconciliation may cut through a known key. Scrub literal values across the retained
  // chunks before any transcript/trace/event artifact is persisted. Check both each stream and
  // the combined event order that the transcript uses; either view can assemble a split value.
  scrubSplitKnownValues(terminalEvents, knownSecretValues, discardedPrefixes);

  // Build the actor trace first (the cost ledger reads its tokenUsage).
  const normalizedTranscript = normalizeLocalActorTranscript(
    terminalEvents.map((e) => e.chunk).join(""),
  );
  // Parsed from the full stream: usage records arrive once per turn, and the tail
  // would drop all but the last.
  const terminalTokenUsage = parseTerminalTokenUsage(normalizedTranscript);
  const trace = buildTerminalActorTrace({
    persona,
    productName: product.name,
    status: session.status,
    completionReason: session.completionReason,
    reason: sanitize(session.reason),
    createdAt,
    completedAt: nowIso(),
    durationMs: commandLog[0]?.durationMs ?? 0,
    terminalEvents,
    commandLog,
    transcriptTail: tailOf(normalizedTranscript),
    participant: inputs.recorder.participantText.finish(),
    runtimeAuth: runtimeEnv.mode,
    runtime,
    ...(terminalTokenUsage === undefined ? {} : { tokenUsage: terminalTokenUsage }),
  });
  // Priced from the model the route passed to Codex. turn.completed sums a turn's requests, so the
  // estimate uses base rates and says so.
  trace.estimatedCost = estimateAggregatedTurnCost(trace.tokenUsage, runtime.requestedModel);
  return { normalizedTranscript, trace };
}

async function settleLiveLedgers(
  inputs: LiveFinishInputs,
  trace: ReturnType<typeof buildTerminalActorTrace>,
  normalizedTranscript: string,
): Promise<{
  cost: TerminalLedgers["cost"];
  noSpendProof: TerminalLedgers["noSpendProof"];
  /** The cap check's message when known spend or jobs exceeded the caps. */
  capFailure: string | undefined;
  ledgers: TerminalLedgers;
}> {
  const { runtime, session } = inputs;
  const costProbe = inputs.input.deps?.costProbe;
  const { caps } = inputs.plan;
  const { maxUsd } = caps;
  const runPaths = inputs.run.paths;
  const { recordLifecycle, lifecycle, commandLog, interventions, terminalEvents } = inputs.recorder;
  // --- Spend ledger + no-spend proof + full caps enforcement (fail-closed). ---
  // The cost ledger is derived, with the null discipline: provider spend from the trace's
  // tokenUsage.costUsd when present (else null = not measured), product/media/payment null by
  // default (core has no signal). The costProbe hook lets tests or adapters inject known
  // spend to exercise the fail-closed cap without a real billable run.
  const injectedLines = costProbe?.(
    trace.tokenUsage?.costUsd === undefined ? {} : { tokenCostUsd: trace.tokenUsage.costUsd },
  );
  if (costProbe) await validatePreparedRunArtifactPaths(runPaths);
  const cost = buildCostLedger({
    ...(trace.tokenUsage?.costUsd === undefined ? {} : { tokenCostUsd: trace.tokenUsage.costUsd }),
    ...(trace.tokenUsage === undefined ? {} : { tokenUsage: trace.tokenUsage }),
    ...(injectedLines ? { injectedLines } : {}),
  });
  const noSpendProof = buildNoSpendProof(cost, maxUsd ?? null, trace.tokenUsage);
  const proofVerdict = !noSpendProof.satisfied
    ? `No-spend proof not satisfied for maxUsd=${maxUsd ?? "null"}.`
    : noSpendLineMeasured(noSpendProof)
      ? noSpendNotEstablished(maxUsd ?? 0)
      : `No-spend proof satisfied on the measured lines for maxUsd=${maxUsd ?? "null"}.`;
  const measuredSpend = describeMeasuredSpend(cost, trace.tokenUsage);
  recordLifecycle(
    "terminal-lab.cost.measured",
    `Cost ledger: known total ${cost.knownTotalUsd} USD${cost.fullyMeasured ? " (fully measured)" : " (lower bound)"}.${measuredSpend.length > 0 ? ` ${measuredSpend}` : ""} ${proofVerdict}`,
  );

  // Fail-closed caps enforcement: if a known spend line exceeds maxUsd (or a
  // known job count exceeds maxJobs), the run fails closed with no green result. Unknowns (null)
  // never trip the cap (we cannot claim a violation we did not measure) but never grant a pass
  // either (the no-spend proof reports them as unmeasured). maxMinutes is already wall-clock-
  // enforced above. A blown cap is an execution failure: the agent's own status stays the
  // verdict, and the result's ok is false.
  const capCheck = evaluateCapsAgainstLedger(cost, caps);
  const capFailure = capCheck.ok ? undefined : capCheck.message;
  if (capFailure !== undefined) recordLifecycle("terminal-lab.caps.exceeded", capFailure);

  // Assemble + persist the ledgers (now carrying the cost block + no-spend proof), the redacted
  // event stream, the normalized transcript, the actor trace, and the run bundle.
  const ledgers: TerminalLedgers = {
    schema: "humanish.terminal-ledgers.v1",
    runtime,
    lifecycle,
    commandLog,
    interventions, // Always present, and always empty while no assisted-input path ships.
    cleanup: session.cleanup,
    cost,
    noSpendProof,
  };

  await writeTerminalEvidence(runPaths, { terminalEvents, normalizedTranscript, ledgers, trace });
  return { cost, noSpendProof, capFailure, ledgers };
}

export async function finishLiveTerminalSession(
  inputs: LiveFinishInputs,
): Promise<TerminalProductStudyResult> {
  const { normalizedTranscript, trace } = buildLiveTrace(inputs);
  const { cost, noSpendProof, capFailure, ledgers } = await settleLiveLedgers(
    inputs,
    trace,
    normalizedTranscript,
  );
  const { plan, input, cwd, sanitize } = inputs;
  const { product, caps } = plan;
  const policies = plan.residual.policies;
  const { runtimeEnv, persona, mission, run, source, warnings, session } = inputs;
  const { runId, paths: runPaths } = run;
  // One judgment, after a blown cap has overridden the session: the bundle's verdict (and so
  // status.json's outcome) and the result's ok both read it.
  const participant = terminalParticipantFacts(trace, session.error);
  const judgment = judgeTerminal({ dryRun: false, participant });

  // The run cost summary, as the computer-use route records it: the sandbox's compute time from
  // its span and observed size, and the participant's tokens (unpriced for Codex). It is not part
  // of the cap ledger above, whose lines sum against scenario.caps.maxUsd.
  const desktops = session.runCostDesktops();
  const runCost = buildRunCostSummary({
    participants: [{ trace }],
    ...(desktops === undefined ? {} : { desktops }),
  });

  const bundle = buildLiveTerminalProductBundle({
    run,
    actorId: plan.actor,
    labId: plan.studyId,
    ...(plan.title ? { labTitle: plan.title } : {}),
    mission: sanitize(mission),
    persona,
    productName: product.name,
    publicSurfaces: product.publicSurfaces,
    caps,
    runtimeAuthKeyName: runtimeEnv.keyName,
    runtimeAuth: runtimeEnv.mode,
    policies: {
      allowPrivateRepoAccess: policies?.allowPrivateRepoAccess ?? false,
      allowProviderCredentials: policies?.allowProviderCredentials ?? false,
      allowPaymentCredentials: policies?.allowPaymentCredentials ?? false,
      allowGitHubMutation: policies?.allowGitHubMutation ?? false,
    },
    source,
    trace,
    ledgers,
    ...(runCost === undefined ? {} : { cost: runCost }),
    sessionReason: sanitize(session.reason),
    verdict: judgment.verdict,
    ...(capFailure === undefined ? {} : { capFailure }),
  });

  // The adapter extension seam. A registered scorer reads the fully assembled, redacted evidence
  // without core knowing any product noun: its namespaced RunAdapterScore lands on
  // bundle.adapterScore, and its feedback candidates are appended to bundle.feedbackCandidates.
  // The score does not replace the judged verdict, but a failing or malformed scorer fails the run
  // through foldScorerFailures below. Adapter payloads pass the same scrub and redaction as the
  // rest of the bundle, and the bundle verifier checks them downstream.
  const scorer = await applyAdapterExtensionSeam({
    scorer: input.scorer,
    bundle,
    trace,
    ledgers,
    transcript: normalizedTranscript,
    product: product.name,
    studyId: plan.studyId,
    runId,
    sanitize,
    warnings,
    ...(input.scorerProvenance === undefined ? {} : { scorerProvenance: input.scorerProvenance }),
  });
  // The one final verdict fold: scoring can only make the judged verdict stricter.
  bundle.review = foldScorerFailures(bundle.review, scorer.failures);
  await validatePreparedRunArtifactPaths(runPaths);

  const finished = await run.finish(bundle);
  const observer = await finished.renderObserver();
  await validatePreparedRunArtifactPaths(runPaths);

  // A failing agent is captured evidence on this route: only the execution and a declared scorer
  // fail ok.
  const execution = judgeExecution(
    terminalExecutionFailures({
      participant,
      capFailure,
      sessionReason: sanitize(session.reason),
      cleanup: session.cleanup,
      observer,
    }),
    OUTCOME_POLICIES.terminal,
  );
  const result = terminalStudyResult({
    cwd,
    labId: plan.studyId,
    actorId: plan.actor,
    productName: product.name,
    runId,
    sessionStatus: session.status,
    completionReason: session.completionReason,
    sessionReason: sanitize(session.reason),
    sessionError: session.error,
    sandboxId: session.sandboxId,
    cleanup: session.cleanup,
    cost,
    noSpendProof,
    capFailure,
    declaredScorerFailure: scorer.failures[0],
    judgment,
    execution,
    observer,
    warnings,
  });
  await finished.recordOutcome({ ok: result.ok, execution });
  return result;
}

/** Persist the terminal evidence: redacted events, normalized transcript, ledgers, actor trace. */
async function writeTerminalEvidence(
  runPaths: PreparedRunArtifactPaths,
  evidence: {
    terminalEvents: readonly TerminalEventRecord[];
    normalizedTranscript: string;
    ledgers: TerminalLedgers;
    trace: ActorTrace;
  },
): Promise<void> {
  const { terminalEvents, normalizedTranscript, ledgers, trace } = evidence;
  await writeContainedOutputFile(
    runPaths,
    TERMINAL_EVENTS_ARTIFACT,
    `${terminalEvents.map((e) => JSON.stringify(e)).join("\n")}${terminalEvents.length > 0 ? "\n" : ""}`,
    "utf8",
  );
  await writeContainedOutputFile(
    runPaths,
    TERMINAL_TRANSCRIPT_ARTIFACT,
    `${normalizedTranscript}\n`,
    "utf8",
  );
  await writeContainedOutputFile(
    runPaths,
    TERMINAL_LEDGERS_ARTIFACT,
    `${JSON.stringify(ledgers, null, 2)}\n`,
    "utf8",
  );
  await writeContainedOutputFile(
    runPaths,
    "actor.json",
    `${JSON.stringify(trace, null, 2)}\n`,
    "utf8",
  );
}
