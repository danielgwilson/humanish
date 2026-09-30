import path from "node:path";
import type { RunFeedbackCandidate } from "./bundle.js";
import { isRecord } from "./primitives.js";

export function isRunFeedbackCandidate(value: unknown): value is RunFeedbackCandidate {
  return (
    isRecord(value) &&
    value.schema === "humanish.feedback-candidate.v1" &&
    typeof value.id === "string" &&
    typeof value.run_id === "string" &&
    (typeof value.stream_id === "string" || value.stream_id === undefined) &&
    typeof value.adapter_id === "string" &&
    typeof value.scenario_id === "string" &&
    typeof value.persona_id === "string" &&
    isFeedbackActor(value.actor) &&
    isFeedbackSubstrate(value.substrate) &&
    isFeedbackFailureOwner(value.failure_owner) &&
    typeof value.summary === "string" &&
    typeof value.expected === "string" &&
    typeof value.actual === "string" &&
    Array.isArray(value.evidence) &&
    value.evidence.every(isRunFeedbackEvidence) &&
    isRecord(value.redaction) &&
    value.redaction.status === "passed" &&
    typeof value.redaction.notes === "string" &&
    typeof value.idempotency_key === "string" &&
    isFeedbackNextState(value.proposed_next_state) &&
    Array.isArray(value.acceptance_proof) &&
    value.acceptance_proof.every((item) => typeof item === "string") &&
    // Optional, adapter-namespaced product-noun block: when present, validate only its SHAPE
    // (a non-empty namespace + a data record). Core never inspects the keys inside `data`.
    (value.adapter === undefined || isFeedbackAdapterBlock(value.adapter))
  );
}

function isFeedbackAdapterBlock(
  value: unknown,
): value is NonNullable<RunFeedbackCandidate["adapter"]> {
  return (
    isRecord(value) &&
    typeof value.namespace === "string" &&
    value.namespace.trim().length > 0 &&
    isRecord(value.data)
  );
}

function isRunFeedbackEvidence(value: unknown): value is RunFeedbackCandidate["evidence"][number] {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    value.path.length > 0 &&
    !path.isAbsolute(value.path) &&
    !value.path.includes("://") &&
    !value.path.includes("..") &&
    (value.kind === "review" ||
      value.kind === "state" ||
      value.kind === "log" ||
      value.kind === "trace" ||
      value.kind === "screenshot" ||
      value.kind === "filesystem") &&
    typeof value.note === "string"
  );
}

function isFeedbackActor(value: unknown): value is RunFeedbackCandidate["actor"] {
  return (
    value === "codex-tui" ||
    value === "codex-exec" ||
    value === "codex-app-server" ||
    value === "computer-use" ||
    value === "synthetic-dry-run" ||
    value === "unknown"
  );
}

function isFeedbackSubstrate(value: unknown): value is RunFeedbackCandidate["substrate"] {
  return (
    value === "e2b-desktop" ||
    value === "local-desktop" ||
    value === "e2b-terminal" ||
    value === "local-filesystem" ||
    value === "codex-app-server" ||
    value === "unknown"
  );
}

function isFeedbackFailureOwner(value: unknown): value is RunFeedbackCandidate["failure_owner"] {
  return (
    value === "harness" ||
    value === "target-app" ||
    value === "actor" ||
    value === "environment" ||
    value === "unknown"
  );
}

function isFeedbackNextState(value: unknown): value is RunFeedbackCandidate["proposed_next_state"] {
  return (
    value === "watch" ||
    value === "adapter-hardening" ||
    value === "target-app-setup" ||
    value === "actor-auth" ||
    value === "setup-quality-review" ||
    value === "study-quality-review"
  );
}
