import { CODEX_APP_SERVER_TRACE_SCHEMA } from "../actors/codex/app-server-trace.js";
import { ACTOR_TRACE_SCHEMA } from "../actors/contract.js";
import { type PreparedRunArtifactPaths } from "../run/paths.js";
import { CODEX_APP_SERVER_PROJECTED_TRACE_SCHEMA, type RunBundle } from "../run/bundle.js";
import { readSafeRunArtifactBytes, readSafeRunArtifactJson } from "../run/locate.js";
import { isRecord } from "../run/type-guards.js";
import {
  COST_CATEGORIES,
  TERMINAL_EVENTS_ARTIFACT,
  TERMINAL_LEDGERS_ARTIFACT,
  TERMINAL_TRANSCRIPT_ARTIFACT,
} from "../run/terminal-contract.js";

export function isZeroEventTerminalTrace(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.schema === ACTOR_TRACE_SCHEMA &&
    value.protocol === "terminal-exec" &&
    value.lane === "terminal" &&
    isRecord(value.counts) &&
    value.counts.terminalEvents === 0
  );
}

/**
 * Verifier for the terminal-product real-agent route (the in-sandbox command-scoped key route). A
 * live terminal stream must carry the durable proof the safety contract requires, and must fail
 * closed when any of it is missing. A blocked/failed agent run stays structurally verifiable (the
 * failure is the evidence) only when the substrate/cleanup/interventions ledgers are present; it
 * must never become a hollow pass. Credential-shape leakage across every artifact file is already
 * caught by scanRunPublicSafetyArtifacts; this check enforces the structural evidence + the
 * proven-teardown invariant. Dry-run/contract bundles are exempt (mode !== live).
 */
export async function validateTerminalProductEvidence(
  runPaths: PreparedRunArtifactPaths,
  bundle: RunBundle,
): Promise<string[]> {
  if (bundle.mode !== "live") {
    return [];
  }
  const findings: string[] = [];
  // Detect the terminal-product route by its unique actor-trace protocol ("terminal-exec") instead of
  // the broad stream.kind "terminal": the existing local codex-exec/TUI routes also use terminal
  // streams (with a different protocol) and must not be held to this route's ledger contract.
  const terminalStreams = bundle.streams.filter(
    (stream) =>
      stream.actor?.protocol === "terminal-exec" && stream.status !== "contract_proof_only",
  );
  if (terminalStreams.length === 0) {
    return findings;
  }

  // The route writes exactly one terminal run's ledgers/evidence at fixed paths in the run root.
  const ledgers = await readSafeRunArtifactJson(runPaths, TERMINAL_LEDGERS_ARTIFACT);
  if (!isRecord(ledgers) || ledgers.schema !== "humanish.terminal-ledgers.v1") {
    findings.push(
      `missing or malformed ${TERMINAL_LEDGERS_ARTIFACT} (humanish.terminal-ledgers.v1)`,
    );
    return findings;
  }

  // Substrate lifecycle ledger: must record at least sandbox creation and teardown.
  const lifecycle = Array.isArray(ledgers.lifecycle) ? ledgers.lifecycle : [];
  if (lifecycle.length === 0) {
    findings.push(
      "substrate lifecycle ledger is empty (expected create -> ready -> exec -> cleanup events)",
    );
  }

  // Command log: present (an array; empty is allowed only if the session never reached exec, which
  // the lifecycle/cleanup records still cover).
  if (!Array.isArray(ledgers.commandLog)) {
    findings.push("command log ledger is missing or not an array");
  }

  // Interventions ledger: must be present (an array). Empty is valid and expected (stdin disabled,
  // no assisted-input path), but absent fails, so an assisted run can never masquerade as one
  // without an interventions record.
  if (!Array.isArray(ledgers.interventions)) {
    findings.push(
      "interventions ledger is missing (an empty array is required-present, not optional)",
    );
  }

  // Cleanup proof: the sandbox must be killed and proven reclaimed by exact ID (remaining===0).
  // humanish never calls Sandbox.list to derive this field; a live run that cannot prove teardown
  // fails closed (remaining===1 still-present-unconfirmed, remaining===-1 kill(id) itself
  // failed; the server-side kill-on-timeout is the backstop for both).
  const cleanup = isRecord(ledgers.cleanup) ? ledgers.cleanup : undefined;
  if (!cleanup) {
    findings.push("cleanup proof is missing");
  } else if (cleanup.killed !== true || cleanup.remaining !== 0) {
    findings.push(
      `cleanup not proven by id (killed=${String(cleanup.killed)}, remaining=${String(cleanup.remaining)}); a run that cannot prove sandbox teardown fails closed`,
    );
  }

  // The redacted exec-stream + normalized transcript artifacts must be written (the producer
  // always writes them on the live path, even empty for a no-output blocked run, so absence is a
  // real evidence gap, while emptiness is legitimate and keeps blocked runs verifiable).
  if (!(await readSafeRunArtifactBytes(runPaths, TERMINAL_EVENTS_ARTIFACT))) {
    findings.push(`missing terminal event stream artifact (${TERMINAL_EVENTS_ARTIFACT})`);
  }
  if (!(await readSafeRunArtifactBytes(runPaths, TERMINAL_TRANSCRIPT_ARTIFACT))) {
    findings.push(
      `missing normalized terminal transcript artifact (${TERMINAL_TRANSCRIPT_ARTIFACT})`,
    );
  }

  // The provider-neutral actor trace must have `lane: "terminal"` with redaction passed.
  for (const stream of terminalStreams) {
    const traceArtifact = stream.artifacts.find((artifact) => artifact.kind === "trace");
    const tracePath = traceArtifact?.path ?? "actor.json";
    const trace = await readSafeRunArtifactJson(runPaths, tracePath);
    if (!isRecord(trace) || trace.lane !== "terminal") {
      findings.push(`${stream.id} missing the terminal participant's actor trace`);
      continue;
    }
    if (!isRecord(trace.redaction) || trace.redaction.status !== "passed") {
      findings.push(`${stream.id} actor trace redaction status must be passed`);
    }
  }

  // The cost ledger and no-spend proof must be present and consistent with each other.
  findings.push(...validateTerminalCostEvidence(ledgers));

  return findings;
}

/**
 * Verifier for the terminal cost ledger and no-spend proof. A live terminal-product bundle must
 * carry both (fail closed if absent on a live run). The load-bearing honesty check: the no-spend
 * proof may not claim zero on a line the ledger marks `null`
 * (unmeasured): a proof can never claim more than the ledger measured. And the observed known
 * spend may not exceed the declared cap (the proof's own maxUsd): fail-closed, not advisory.
 * The null discipline is enforced here too: a present line's `usd` must be a number or literally
 * null (never undefined/omitted), so "not measured" can never be silently dropped.
 */
function validateTerminalCostEvidence(ledgers: Record<string, unknown>): string[] {
  const findings: string[] = [];

  const cost = isRecord(ledgers.cost) ? ledgers.cost : undefined;
  if (!cost || cost.schema !== "humanish.terminal-cost-ledger.v1") {
    findings.push(
      "missing or malformed cost ledger (humanish.terminal-cost-ledger.v1) — a live terminal-product run must derive a cost ledger",
    );
    return findings;
  }
  const lines = isRecord(cost.lines) ? cost.lines : undefined;
  if (!lines) {
    findings.push("cost ledger has no lines block");
    return findings;
  }

  // The null discipline: every applicable category line must be present with `usd` as a number or
  // literally null. `undefined`/omitted is forbidden because it would silently lose the "not measured"
  // distinction. Track which categories the ledger marks null so the no-spend proof cannot lie about them.
  const nullCategories = new Set<string>();
  for (const category of COST_CATEGORIES) {
    const line = isRecord(lines[category])
      ? (lines[category] as Record<string, unknown>)
      : undefined;
    if (!line || !("usd" in line)) {
      findings.push(
        `cost ledger line "${category}" is missing its usd field (unknowns must be explicit null, never omitted)`,
      );
      continue;
    }
    const usd = line.usd;
    if (usd === null) {
      nullCategories.add(category);
    } else if (typeof usd !== "number") {
      findings.push(
        `cost ledger line "${category}" usd must be a number or null (got ${typeof usd})`,
      );
    }
  }

  const proof = isRecord(ledgers.noSpendProof) ? ledgers.noSpendProof : undefined;
  if (!proof || proof.schema !== "humanish.terminal-no-spend-proof.v1") {
    findings.push(
      "missing or malformed no-spend proof (humanish.terminal-no-spend-proof.v1) — the no-spend proof must be derived from the ledger",
    );
    return findings;
  }

  // Honesty check: the no-spend proof must not claim zero on a line the ledger marks `null`. A
  // knownZeroLines entry that is actually unmeasured in the ledger means the proof claimed more than
  // it measured, so it fails closed.
  const knownZeroLines = Array.isArray(proof.knownZeroLines) ? proof.knownZeroLines : [];
  for (const category of knownZeroLines) {
    if (nullCategories.has(String(category))) {
      findings.push(
        `no-spend proof claims zero on line "${String(category)}" but the cost ledger marks it null (UNMEASURED); a proof may not claim zero on a line it did not measure`,
      );
    }
  }

  // Fail-closed cap: observed known spend may not exceed the declared cap (the proof's maxUsd). The
  // ledger's knownTotalUsd is the measured spend; null lines do not count toward it (and the proof
  // reports them as unmeasured). A satisfied proof whose known total exceeds its cap is contradictory.
  const knownTotalUsd = typeof cost.knownTotalUsd === "number" ? cost.knownTotalUsd : Number.NaN;
  const maxUsd = typeof proof.maxUsd === "number" ? proof.maxUsd : null;
  if (maxUsd !== null && Number.isFinite(knownTotalUsd) && knownTotalUsd > maxUsd) {
    findings.push(
      `observed KNOWN spend ${knownTotalUsd} USD exceeds the declared cap maxUsd=${maxUsd}; the run must fail closed, not verify green`,
    );
  }
  // A proof that asserts `satisfied:true` while a known line is non-zero (knownNonZeroLines) is
  // self-contradictory; reject it (the proof's own derived state must be internally consistent).
  const knownNonZeroLines = Array.isArray(proof.knownNonZeroLines) ? proof.knownNonZeroLines : [];
  if (proof.satisfied === true && knownNonZeroLines.length > 0) {
    findings.push(
      `no-spend proof claims satisfied:true but reports known non-zero spend lines (${knownNonZeroLines.map(String).join(", ")})`,
    );
  }

  return findings;
}

export async function validateCodexAppServerEvidence(
  runPaths: PreparedRunArtifactPaths,
  bundle: RunBundle,
): Promise<string[]> {
  if (bundle.mode !== "live") {
    return [];
  }

  const findings: string[] = [];
  const appServerStreams = bundle.streams.filter(
    (stream) =>
      stream.status !== "contract_proof_only" &&
      (stream.codex?.provider === "codex-app-server" ||
        stream.artifacts.some((artifact) => artifact.path.includes("codex-app-server"))),
  );

  for (const stream of appServerStreams) {
    if (stream.codex?.provider !== "codex-app-server") {
      findings.push(`${stream.id} missing first-class codex app-server metadata`);
    }
    if (
      stream.status === "running" ||
      stream.codex?.state === "connecting" ||
      stream.codex?.state === "running"
    ) {
      continue;
    }
    const traceArtifact = stream.artifacts.find(
      (artifact) => artifact.kind === "trace" && artifact.path.includes("codex-app-server"),
    );
    const eventsArtifact = stream.artifacts.find(
      (artifact) => artifact.kind === "events" && artifact.path.includes("codex-app-server"),
    );
    const logArtifact = stream.artifacts.find(
      (artifact) => artifact.kind === "log" && artifact.path.includes("codex-app-server"),
    );

    if (!traceArtifact) {
      findings.push(`${stream.id} missing codex app-server trace artifact`);
      continue;
    }

    const trace = await readSafeRunArtifactJson(runPaths, traceArtifact.path);
    if (
      !isRecord(trace) ||
      ![CODEX_APP_SERVER_TRACE_SCHEMA, CODEX_APP_SERVER_PROJECTED_TRACE_SCHEMA].includes(
        String(trace.schema),
      )
    ) {
      findings.push(
        `${stream.id} trace artifact must use ${CODEX_APP_SERVER_TRACE_SCHEMA} or ${CODEX_APP_SERVER_PROJECTED_TRACE_SCHEMA}`,
      );
    }
    if (!isRecord(trace) || !isRecord(trace.redaction) || trace.redaction.status !== "passed") {
      findings.push(`${stream.id} trace redaction status must be passed`);
    }
    if (!eventsArtifact) {
      findings.push(`${stream.id} missing codex app-server event envelope log`);
    }
    if (!logArtifact) {
      findings.push(`${stream.id} missing codex app-server transcript summary log`);
    }
  }

  return findings;
}

// Trace item kinds that show the actor did something (drove UI, ran a command, called a tool,
// changed a file). reasoning/screenshot/plan/notice items are observation, not engagement.
const ACTION_BEARING_ACTOR_ITEM_KINDS = new Set([
  "ui_action",
  "command",
  "tool_call",
  "file_change",
]);

/**
 * Independent mirror of the producer-side no-engagement guard
 * (routes/computer-use/participant-execution.ts): a live actor trace claiming goal_satisfied while
 * carrying zero action-bearing items and zero message items is a hollow run (the actor neither did
 * nor said anything) and must not verify as evidence (invariant 4: evidence verifies fail-closed).
 * Live-vs-dry-run is judged exactly as the producer judges it, from bundle.mode alone;
 * dry-run/contract bundles legitimately carry no actions and stay exempt. Engagement is accepted
 * from either surface (itemized trace items or the producer's counts), because providers differ in
 * what they itemize; a hollow run reports zero on both. The trace is read defensively: isRunStream
 * does not validate the actor seam, and verify must not throw on a malformed one.
 */
export function noEngagementActorFindings(bundle: RunBundle): string[] {
  if (bundle.mode !== "live") {
    return [];
  }

  const findings: string[] = [];
  for (const stream of bundle.streams) {
    const trace: unknown = stream.actor;
    if (
      !isRecord(trace) ||
      trace.schema !== ACTOR_TRACE_SCHEMA ||
      trace.completionReason !== "goal_satisfied"
    ) {
      continue;
    }
    const items = Array.isArray(trace.items) ? trace.items : [];
    const counts = isRecord(trace.counts) ? trace.counts : {};
    const countOf = (key: string): number => {
      const value = counts[key];
      return typeof value === "number" && Number.isFinite(value) ? value : 0;
    };
    const engaged =
      countOf("actions") > 0 ||
      countOf("messages") > 0 ||
      hasStopWhenObservationEvidence(items, countOf("screenshots")) ||
      items.some(
        (item) =>
          isRecord(item) &&
          typeof item.kind === "string" &&
          (item.kind === "message" || ACTION_BEARING_ACTOR_ITEM_KINDS.has(item.kind)),
      );
    if (!engaged) {
      const provider = typeof trace.provider === "string" ? trace.provider : "unknown provider";
      findings.push(
        `${stream.id} live actor trace (${provider}) claims goal_satisfied with zero actions and zero messages`,
      );
    }
  }

  return findings;
}

function hasStopWhenObservationEvidence(items: unknown[], screenshotCount: number): boolean {
  const hasScreenshot =
    screenshotCount > 0 ||
    items.some(
      (item) =>
        isRecord(item) &&
        item.kind === "screenshot" &&
        isRecord(item.screenshotRef) &&
        typeof item.screenshotRef.path === "string" &&
        item.screenshotRef.path.length > 0,
    );
  if (!hasScreenshot) return false;
  // A matched stopWhen, or a declared dwell window that ended the session: both are
  // structured, harness-owned completion, with frames behind them.
  return items.some(
    (item) =>
      isRecord(item) &&
      item.kind === "notice" &&
      item.status === "matched" &&
      typeof item.title === "string" &&
      (item.title.startsWith("stopWhen matched") || item.title === "dwell window complete"),
  );
}

export function actorVerdictConsistencyFindings(bundle: RunBundle): string[] {
  if (bundle.mode !== "live" || bundle.review.verdict !== "pass") {
    return [];
  }

  const findings: string[] = [];
  for (const stream of bundle.streams) {
    const trace: unknown = stream.actor;
    if (!isRecord(trace) || trace.schema !== ACTOR_TRACE_SCHEMA) {
      continue;
    }
    if (trace.status !== "passed") {
      const provider = typeof trace.provider === "string" ? trace.provider : "unknown provider";
      const reason = typeof trace.reason === "string" ? trace.reason : "no actor reason";
      findings.push(
        `${stream.id} live actor trace (${provider}) has status ${String(trace.status)} under a pass review verdict: ${reason}`,
      );
    }
  }

  return findings;
}
