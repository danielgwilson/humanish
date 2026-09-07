import type { RunBundle, RunFeedbackCandidate } from "./run.js";

/** Commands run from the evidence workspace using an installed Humanish CLI. */
export function feedbackProofCommands(runId: string): { verify: string; watch: string } {
  const argument = /^[a-z0-9][a-z0-9._-]*$/i.test(runId) ? runId : `'${runId.replace(/'/g, "'\\''")}'`;
  return {
    verify: `humanish verify --run ${argument} --json`,
    watch: `humanish watch --run ${argument} --no-open`
  };
}

/** Legacy command compatibility belongs in the draft, never in the source receipt. */
export function projectFeedbackAcceptanceProof(bundle: RunBundle, candidate: RunFeedbackCandidate): string[] {
  if (!isFirstPartyCandidate(bundle, candidate)) return [...candidate.acceptance_proof];
  const commands = feedbackProofCommands(bundle.runId);
  return candidate.acceptance_proof.map((instruction) => {
    if (instruction === `pnpm humanish -- verify --run ${bundle.runId} --json`) return commands.verify;
    if (instruction === `pnpm humanish -- watch --run ${bundle.runId} --no-open`) return commands.watch;
    return instruction;
  });
}

function isFirstPartyCandidate(bundle: RunBundle, candidate: RunFeedbackCandidate): boolean {
  if (candidate.run_id !== bundle.runId || !candidate.stream_id
    || !bundle.streams.some((stream) => stream.id === candidate.stream_id)) return false;

  if (candidate.actor === "computer-use" && candidate.failure_owner === "target-app"
    && candidate.proposed_next_state === "study-quality-review" && candidate.id.startsWith("participant-report-")) {
    const laneId = candidate.id.slice("participant-report-".length);
    return laneId.length > 0 && candidate.idempotency_key === `humanish:${bundle.runId}:${laneId}:participant-report`;
  }

  if (candidate.adapter_id !== "oss-meta-lab" || candidate.actor !== "codex-tui"
    || candidate.substrate !== "e2b-desktop") return false;
  const streamToken = candidate.stream_id.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
  const kinds = [
    { id: "setup-quality", owner: "actor", next: "setup-quality-review" },
    { id: "published-cli-app-url", owner: "harness", next: "adapter-hardening" },
    { id: "study-quality", owner: "actor", next: "study-quality-review" }
  ];
  return kinds.some((kind) => candidate.id === `${kind.id}-${streamToken}`
    && candidate.failure_owner === kind.owner && candidate.proposed_next_state === kind.next
    && candidate.idempotency_key === `humanish:${bundle.runId}:${candidate.stream_id}:${kind.id}`);
}
