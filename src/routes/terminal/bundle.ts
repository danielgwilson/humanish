import type { ActorPersonaRef, ActorTrace } from "../../actors/contract.js";
import type { LabScenarioCaps, LabRuntimeAuth } from "../../lab/types.js";
import { redactText } from "../../evidence/redaction.js";
import { participantAssignment } from "../../lab/participant-assignment.js";
import {
  REVIEW_SCHEMA,
  type ReviewSummary,
  type RunBundle,
  type RunCostSummary,
  type RunEvent,
  type RunSimulation,
  bundleArtifacts,
  bundleHead,
  type BundleRun,
} from "../../run/bundle.js";
import { type Verdict, verdictText } from "../../run/judge.js";
import { type RunSimulationStatus, type RunStream } from "../../run/streams.js";
import {
  participantEvent,
  participantIds,
  participantRecord,
  participantStream,
} from "../../run/participant-records.js";
import {
  TERMINAL_EVENTS_ARTIFACT,
  TERMINAL_LEDGERS_ARTIFACT,
  TERMINAL_TRANSCRIPT_ARTIFACT,
} from "../../run/terminal-contract.js";
import type { TerminalLedgers } from "./types.js";
import { describeMeasuredSpend, noSpendLineMeasured, noSpendNotEstablished } from "./ledger.js";

/**
 * Project the terminal-product lab run into a humanish.run-bundle.v1 (no schema change: a new
 * producer only). Dry run: a contract bundle. The terminal stream is a contract placeholder
 * (stdin disabled, no captured tail, because nothing ran), the subject is declared unpinned, and
 * the caps/policies/runtime-auth declarations are recorded without pretending that live ledgers
 * exist. The shipped live builder fills the same evidence contract. Exported for tests.
 */
export function buildTerminalProductBundle(args: {
  /** The run this bundle belongs to; the bundle head reads its id, mode, start and lab. */
  run: BundleRun;
  actorId: string;
  dryRun: boolean;
  labId: string;
  labTitle?: string;
  mission: string;
  persona: ActorPersonaRef;
  productName: string;
  publicSurfaces: string[];
  caps?: LabScenarioCaps;
  runtimeAuth?: string;
  stdin: "disabled" | "planned" | "sent";
  policies: {
    allowPrivateRepoAccess: boolean;
    allowProviderCredentials: boolean;
    allowPaymentCredentials: boolean;
    allowGitHubMutation: boolean;
  };
  source: RunBundle["source"];
  /** The run's judgment verdict (judgeTerminal): a contract for a dry run. */
  verdict: Verdict;
}): RunBundle {
  const reason =
    "Dry run: the terminal-product study was declared without creating an E2B sandbox, injecting any key, or spending. This run did not execute an agent or prove live behavior.";

  // The terminal stream is a contract placeholder on the dry-run path: stdin is disabled and no
  // exec output was captured, so the tail is empty and transport stays "snapshot", never "pty"
  // (captured non-interactive exec output is never an interactive PTY). The shipped live builder
  // fills terminal.tail from redacted exec-stream capture.
  const { simulation, stream } = terminalParticipant(args, {
    status: "contract_proof_only",
    reason,
    summary: `Dry-run participant for the terminal agent (${args.actorId}) studying ${args.productName} from public surfaces.`,
    updatedAt: args.run.createdAt,
    stdin: args.stdin,
    tail: "",
    artifacts: [
      { label: "run bundle", path: "run.json", kind: "bundle" as const },
      { label: "review", path: "review.md", kind: "review" as const },
      { label: "events", path: "events.ndjson", kind: "events" as const },
    ],
  });

  const capsText = describeCaps(args.caps);
  const events: RunEvent[] = [
    {
      id: "event-000-created",
      at: args.run.createdAt,
      level: "info",
      type: "terminal-lab.run.created",
      message: `Created terminal-product lab run for ${args.labId} (actor ${args.actorId}, product ${args.productName}).`,
    },
    participantEvent(TERMINAL_IDS, {
      id: "event-001-subject",
      at: args.run.createdAt,
      level: "info",
      type: "terminal-lab.subject.declared",
      // Provenance is recorded or its absence declared. The agent drives public surfaces
      // and nothing is cloned, so the subject provenance is explicitly unpinned; evidence binds to the
      // composed-prompt digest. Public surfaces are recorded (they are public by declaration).
      message: `Subject product declared: ${args.productName}; public surfaces: ${args.publicSurfaces.join(", ")}. The lab did not provision/clone the product — subject provenance is UNPINNED (a public-surface study cannot be commit-pinned); evidence binds to the composed-prompt digest ${args.persona.promptDigest}.`,
    }),
    participantEvent(TERMINAL_IDS, {
      id: "event-002-credentials",
      at: args.run.createdAt,
      level: "info",
      type: "terminal-lab.credentials.declared",
      // Names-only evidence: the runtime-auth channel is declared; no value is ever
      // recorded. The deny-by-default policies are recorded so the credential posture is auditable.
      message: `Runtime auth channel: ${args.runtimeAuth ?? "none declared"} (names only; values never persist; the live engine applies the selected key placement, while this dry-run performs no injection). Credential policies (deny-by-default): allowPrivateRepoAccess=${args.policies.allowPrivateRepoAccess}, allowProviderCredentials=${args.policies.allowProviderCredentials}, allowPaymentCredentials=${args.policies.allowPaymentCredentials}, allowGitHubMutation=${args.policies.allowGitHubMutation}.`,
    }),
    participantEvent(TERMINAL_IDS, {
      id: "event-003-caps",
      at: args.run.createdAt,
      level: "info",
      type: "terminal-lab.caps.declared",
      message: `Spend/job/time caps: ${capsText}. A live run never exercises the runtime key without a fail-closed cap; its no-spend proof is derived from the persisted cost ledger. This dry-run spends $0 by mechanism.`,
    }),
    participantEvent(TERMINAL_IDS, {
      id: "event-004-contract",
      at: args.run.createdAt,
      level: "info",
      type: "terminal-lab.contract.ready",
      message:
        "Dry-run bundle ready. Switch scenario.mode to live with the required runtime auth and caps to exercise the in-sandbox agent route, captured exec stream, and declared runtime-auth placement.",
    }),
  ];

  const review: ReviewSummary = {
    schema: REVIEW_SCHEMA,
    verdict: args.verdict,
    summary: reason,
    gaps: [
      "This dry run did not execute the live in-sandbox agent route; it checks the evidence shape only, not live behavior, scale, or adoption.",
      "No exec-stream, transcript, substrate, cost, or cleanup artifacts were produced because no live session ran; live verification requires those artifacts.",
    ],
  };

  return terminalRunBundle(args, {
    lifecycle: [
      {
        at: args.run.createdAt,
        event: "terminal-lab.run.created",
        message: `Created terminal-product lab run with one in-sandbox agent participant (actor ${args.actorId}, product ${args.productName}).`,
      },
    ],
    simulation,
    stream,
    events,
    redactionNotes:
      "Dry-run bundle: no sandbox ran, no key was injected, no exec output was captured. The author mission is public-safe committed lab text (redacted defensively); the composed prompt is bound by digest. The shipped live path applies scrubKnownValues then redactText at the capture source before persistence.",
    review,
  });
}

/**
 * Build the live terminal-product run bundle (mode "live") from the captured session: the actor
 * trace seam (stream.actor = trace), the substrate-lifecycle events, the terminal stream with the
 * redacted transcript tail, and references to the written evidence artifacts (terminal event
 * stream, transcript, ledgers, actor trace). verifyRun's terminal-product check (gated on
 * mode==="live") enforces the ledgers + proven cleanup + interventions-present over this bundle.
 */
export function buildLiveTerminalProductBundle(args: {
  /** The run this bundle belongs to; the bundle head reads its id, mode, start and lab. */
  run: BundleRun;
  actorId: string;
  labId: string;
  labTitle?: string;
  mission: string;
  persona: ActorPersonaRef;
  productName: string;
  publicSurfaces: string[];
  caps?: LabScenarioCaps;
  runtimeAuthKeyName: string;
  runtimeAuth?: LabRuntimeAuth;
  policies: {
    allowPrivateRepoAccess: boolean;
    allowProviderCredentials: boolean;
    allowPaymentCredentials: boolean;
    allowGitHubMutation: boolean;
  };
  source: RunBundle["source"];
  trace: ActorTrace;
  ledgers: TerminalLedgers;
  cost?: RunCostSummary;
  sessionReason: string;
  /** The run's judgment verdict (judgeTerminal). */
  verdict: Verdict;
  /** The cap check's message when known spend or jobs exceeded the caps: an execution failure
   *  the review names, beside the agent's own verdict. */
  capFailure?: string;
}): RunBundle {
  const recordStatus: RunSimulationStatus =
    args.trace.status === "passed"
      ? "passed"
      : args.trace.status === "blocked"
        ? "blocked"
        : args.trace.status === "timed_out"
          ? "timed_out"
          : "failed";
  const commandItem = args.trace.items.find((item) => item.kind === "command");
  const tail = (commandItem?.command?.outputTail || args.trace.reason).slice(0, 2000);

  // transport "snapshot": the persisted tail is a redacted snapshot of the captured exec output,
  // never an interactive PTY (stdin disabled). The actor trace seam carries the structured evidence.
  const { simulation, stream } = terminalParticipant(args, {
    status: recordStatus,
    reason: args.sessionReason,
    summary: `Terminal agent (${args.actorId}) studied ${args.productName} from public surfaces (${args.trace.status}).`,
    updatedAt: args.trace.completedAt,
    stdin: "disabled",
    tail,
    actor: args.trace,
    artifacts: [
      { label: "run bundle", path: "run.json", kind: "bundle" as const },
      { label: "review", path: "review.md", kind: "review" as const },
      { label: "event log", path: "events.ndjson", kind: "events" as const },
      { label: "actor trace", path: "actor.json", kind: "trace" as const },
      { label: "terminal event stream", path: TERMINAL_EVENTS_ARTIFACT, kind: "log" as const },
      { label: "terminal transcript", path: TERMINAL_TRANSCRIPT_ARTIFACT, kind: "log" as const },
      { label: "terminal ledgers", path: TERMINAL_LEDGERS_ARTIFACT, kind: "log" as const },
    ],
  });

  // Substrate-lifecycle ledger -> bundle events (each already sanitized when recorded).
  const lifecycleEvents: RunEvent[] = args.ledgers.lifecycle.map((record, index) =>
    participantEvent(TERMINAL_IDS, {
      id: `event-${String(index).padStart(3, "0")}-${record.event}`,
      at: record.at,
      level:
        record.event.includes("error") ||
        record.event.includes("timed_out") ||
        record.event.includes("exceeded")
          ? "warn"
          : "info",
      type: record.event,
      message: record.message,
    }),
  );

  // Surface the no-spend proof as a first-class bundle event so the Observer/review can show it.
  // It is derived from the cost ledger (never asserted): it lists the known-zero lines it vouches
  // for and the unmeasured (null) lines it explicitly cannot vouch for.
  const noSpend = args.ledgers.noSpendProof;
  lifecycleEvents.push(
    participantEvent(TERMINAL_IDS, {
      id: "event-cost-no-spend-proof",
      at: args.trace.completedAt,
      level: noSpend.satisfied ? "info" : "warn",
      type: "terminal-lab.no-spend.proof",
      message: noSpend.statement,
    }),
  );

  const review: ReviewSummary = {
    schema: REVIEW_SCHEMA,
    verdict: args.verdict,
    summary: args.sessionReason,
    gaps: [
      ...(args.trace.status === "passed"
        ? []
        : [`Agent session ended ${args.trace.status}: ${args.sessionReason}`]),
      ...(args.capFailure === undefined ? [] : [args.capFailure]),
      // Honesty gap: the no-spend proof always declares which spend lines it could not measure, so a
      // green run never silently over-claims a fully-proven $0.
      ...(noSpend.unmeasuredLines.length > 0
        ? [
            `${noSpendLineMeasured(noSpend) ? noSpendNotEstablished(noSpend.maxUsd ?? 0) : "No-spend proof is partial."} ${describeMeasuredSpend(args.ledgers.cost, args.trace.tokenUsage)} An adapter may supply the missing signals through costProbe.`,
          ]
        : []),
    ],
  };

  return terminalRunBundle(args, {
    lifecycle: args.ledgers.lifecycle.map((record) => ({
      at: record.at,
      event: record.event,
      message: record.message,
    })),
    simulation,
    stream,
    events: lifecycleEvents,
    redactionNotes: `Live terminal-product run: the in-sandbox agent's output was captured via commands.run onStdout/onStderr and scrubbed (literal known values incl. the runtime key) THEN redacted (shape patterns) AT THE SOURCE before persisting. ${args.runtimeAuth === "openai-egress" ? `Runtime auth openai-egress: the raw key from ${args.runtimeAuthKeyName} is reserved for E2B's external api.openai.com HTTPS header transform. ${args.ledgers.commandLog.some((command) => command.label === "codex-exec") ? "Codex received an inert CODEX_API_KEY placeholder." : "Codex was not launched."} Any created sandbox retains a spendable OpenAI proxy capability until teardown; additional provider calls may not appear in the Codex usage ledger.` : `Runtime auth openai-env: the runtime key (${args.runtimeAuthKeyName}) was injected ONLY into the command-scoped codex invocation, never sandbox-global env or metadata; only its NAME appears in evidence.`} Subject provenance is UNPINNED (public-surface study).`,
    review,
    ...(args.cost === undefined ? {} : { cost: args.cost }),
  });
}

/** What both builders read to name the run, its persona and its scenario. */
interface TerminalBundleCommon {
  run: BundleRun;
  actorId: string;
  labId: string;
  labTitle?: string;
  mission: string;
  persona: ActorPersonaRef;
  productName: string;
  source: RunBundle["source"];
}

/** The one terminal participant's saved ids. */
const TERMINAL_IDS = participantIds(0);

/** The one terminal participant: its record and its stream. */
function terminalParticipant(
  args: TerminalBundleCommon,
  session: {
    status: RunSimulationStatus;
    reason: string;
    summary: string;
    updatedAt: string;
    stdin: "disabled" | "planned" | "sent";
    tail: string;
    actor?: ActorTrace;
    artifacts: RunStream["artifacts"];
  },
): { simulation: RunSimulation; stream: RunStream } {
  const simulation = participantRecord(TERMINAL_IDS, 1, {
    personaId: args.persona.id,
    scenarioId: `terminal-${args.labId}`,
    status: session.status,
    streamKind: "terminal",
    mode: "cli-sim",
    progress: 100,
    currentStep: session.reason,
    summary: session.summary,
    startedAt: args.run.createdAt,
    updatedAt: session.updatedAt,
  });
  const stream = participantStream(TERMINAL_IDS, {
    assignment: participantAssignment({ mission: args.mission }),
    kind: "terminal",
    label: `Terminal agent — ${args.labId}`,
    status: session.status,
    transport: "snapshot",
    updatedAt: session.updatedAt,
    embed: { kind: "placeholder", title: `Terminal agent (${args.productName})` },
    terminal: {
      title: `${args.actorId} exec (stdin ${session.stdin})`,
      format: "plain",
      stdin: session.stdin,
      tail: session.tail,
    },
    ui: {
      intent: `Watch the terminal agent discover and use ${args.productName} from its public surfaces.`,
      state: session.reason,
    },
    ...(session.actor === undefined ? {} : { actor: session.actor }),
    artifacts: session.artifacts,
  });
  return { simulation, stream };
}

/** The run bundle around the terminal session: the fields both builders fill the same way. */
function terminalRunBundle(
  args: TerminalBundleCommon,
  parts: {
    lifecycle: RunBundle["lifecycle"];
    simulation: RunSimulation;
    stream: RunStream;
    events: RunEvent[];
    redactionNotes: string;
    review: ReviewSummary;
    cost?: RunCostSummary;
  },
): RunBundle {
  return {
    ...bundleHead(args.run, { participants: 1, source: args.source }),
    persona: {
      id: args.persona.id,
      name: `Autonomous terminal agent (${args.persona.id})`,
      source: `lab:${args.labId}`,
      sourceDigest: args.persona.promptDigest,
    },
    scenario: {
      id: `terminal-${args.labId}`,
      title: args.labTitle ?? `Terminal-product lab: ${args.labId}`,
      // The author mission is public-safe committed lab text. It is recorded plaintext as the goal,
      // redacted defensively before persisting (it never carries a secret, but the harness never
      // trusts that). The full composed prompt is bound by digest, not text.
      goal: redactText(args.mission),
      source: `lab:${args.labId}`,
      sourceDigest: args.persona.promptDigest,
    },
    lifecycle: parts.lifecycle,
    simulations: [parts.simulation],
    streams: [parts.stream],
    events: parts.events,
    redaction: { status: "passed", notes: parts.redactionNotes },
    artifacts: bundleArtifacts(),
    review: parts.review,
    feedbackCandidates: [],
    ...(parts.cost === undefined ? {} : { cost: parts.cost }),
  };
}

function describeCaps(caps: LabScenarioCaps | undefined): string {
  if (!caps) return "none declared (a live run requires caps)";
  const parts: string[] = [];
  if (caps.maxUsd !== undefined) parts.push(`maxUsd=${caps.maxUsd}`);
  if (caps.maxJobs !== undefined) parts.push(`maxJobs=${caps.maxJobs}`);
  if (caps.maxMinutes !== undefined) parts.push(`maxMinutes=${caps.maxMinutes}`);
  return parts.length > 0 ? parts.join(", ") : "empty";
}

export function renderTerminalReviewMarkdown(bundle: RunBundle): string {
  const subject = bundle.events.find((event) => event.type === "terminal-lab.subject.declared");
  const credentials = bundle.events.find(
    (event) => event.type === "terminal-lab.credentials.declared",
  );
  const caps = bundle.events.find((event) => event.type === "terminal-lab.caps.declared");
  return [
    `# ${bundle.scenario.title}`,
    "",
    `- run: ${bundle.runId}`,
    `- mode: ${bundle.mode}`,
    `- verdict: ${verdictText(bundle.review.verdict, bundle.mode)}`,
    `- summary: ${bundle.review.summary}`,
    `- mission: ${bundle.scenario.goal}`,
    ...(subject ? [`- subject: ${subject.message}`] : []),
    ...(credentials ? [`- credentials: ${credentials.message}`] : []),
    ...(caps ? [`- caps: ${caps.message}`] : []),
    ...(bundle.review.gaps.length > 0
      ? ["", "## Gaps", ...bundle.review.gaps.map((gap) => `- ${gap}`)]
      : []),
    "",
  ].join("\n");
}
