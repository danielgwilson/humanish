import { realpath } from "node:fs/promises";
import path from "node:path";

import { loadRunBundlePrepared, verifyRunPrepared } from "./run.js";
import type { RunBundle, RunFeedbackCandidate, VerifyResult } from "./run.js";
import {
  bindExistingRunArtifactPaths,
  isSafeRunIdSegment,
  resolveLatestRunDirectory,
  type PreparedRunArtifactPaths,
  validatePreparedRunArtifactPaths
} from "./run-paths.js";
import {
  bindExistingManagedHumanishOutputDirectory,
  readContainedRegularFile,
  writeContainedOutputFile
} from "./selected-output-paths.js";

export const FEEDBACK_SCHEMA = "humanish.feedback.v1";
export const FEEDBACK_RESULT_SCHEMA = "humanish.feedback-result.v1";

export interface FeedbackDraft {
  schema: typeof FEEDBACK_SCHEMA;
  run_id: string;
  adapter_id: string;
  scenario_id: string;
  persona_id: string;
  actor: RunFeedbackCandidate["actor"];
  substrate: RunFeedbackCandidate["substrate"];
  failure_owner: RunFeedbackCandidate["failure_owner"];
  summary: string;
  expected: string;
  actual: string;
  source_candidate_id?: string;
  source_bundle: string;
  evidence: Array<{
    path: string;
    kind: RunFeedbackCandidate["evidence"][number]["kind"];
    note: string;
  }>;
  redaction: {
    status: "passed";
    notes: string;
  };
  idempotency_key: string;
  proposed_next_state: RunFeedbackCandidate["proposed_next_state"];
  acceptance_proof: string[];
}

export interface FeedbackResult {
  schema: typeof FEEDBACK_RESULT_SCHEMA;
  ok: boolean;
  cwd: string;
  run: string;
  draftPath?: string;
  issuePath?: string;
  issueMarkdown?: string;
  issueUrl?: string;
  draft?: FeedbackDraft;
  shareSafety?: VerifyResult["shareSafety"];
  error?: {
    code:
      | "HUMANISH_RUN_NOT_FOUND"
      | "HUMANISH_INVALID_RUN_BUNDLE"
      | "HUMANISH_INVALID_FEEDBACK_DRAFT"
      | "HUMANISH_FEEDBACK_SHARE_SAFETY_BLOCKED";
    message: string;
  };
}

type LoadedRunBundle = NonNullable<Awaited<ReturnType<typeof loadRunBundlePrepared>>>;

interface FeedbackRunContext {
  cwd: string;
  loaded: LoadedRunBundle;
  physicalCwd: string;
  preparedRunPaths: PreparedRunArtifactPaths;
  storedRunId: string;
}

interface BoundFeedbackResult {
  context?: FeedbackRunContext;
  result: FeedbackResult;
}

export async function draftFeedback(cwdInput: string, runInput: string): Promise<FeedbackResult> {
  return (await draftFeedbackBound(cwdInput, runInput)).result;
}

async function draftFeedbackBound(cwdInput: string, runInput: string): Promise<BoundFeedbackResult> {
  const cwd = path.resolve(cwdInput);
  const context = await resolveFeedbackRunContext(cwd, runInput);

  if (!context) {
    return { result: {
      schema: FEEDBACK_RESULT_SCHEMA,
      ok: false,
      cwd,
      run: runInput,
      error: {
        code: "HUMANISH_RUN_NOT_FOUND",
        message: `Run not found: ${runInput}`
      }
    } };
  }

  const verified = await verifyRunPrepared(
    context.physicalCwd,
    context.storedRunId,
    context.preparedRunPaths
  );
  await validatePreparedRunArtifactPaths(context.preparedRunPaths);
  if (!verified.ok) {
    return { context, result: {
      schema: FEEDBACK_RESULT_SCHEMA,
      ok: false,
      cwd,
      run: runInput,
      error: {
        code: "HUMANISH_INVALID_RUN_BUNDLE",
        message: verified.error?.message ?? "Run bundle failed verification."
      }
    } };
  }

  if (verified.shareSafety.status !== "share_ready") {
    return { context, result: {
      schema: FEEDBACK_RESULT_SCHEMA,
      ok: false,
      cwd,
      run: runInput,
      shareSafety: verified.shareSafety,
      error: {
        code: "HUMANISH_FEEDBACK_SHARE_SAFETY_BLOCKED",
        message: `Run is ${verified.shareSafety.status}, not share_ready: ${verified.shareSafety.reasons.map((reason) => reason.code).join(", ")}`
      }
    } };
  }

  const draft = buildDraft(context.loaded.bundle, context.loaded.bundlePath);
  const draftPath = path.join(context.preparedRunPaths.relativeRunRoot, "feedback", "draft.json");
  await writeJson(context.preparedRunPaths, path.join("feedback", "draft.json"), draft);

  return { context, result: {
    schema: FEEDBACK_RESULT_SCHEMA,
    ok: true,
    cwd,
    run: runInput,
    draftPath,
    draft
  } };
}

export async function verifyFeedback(cwdInput: string, runInput: string): Promise<FeedbackResult> {
  return (await verifyFeedbackBound(cwdInput, runInput)).result;
}

async function verifyFeedbackBound(cwdInput: string, runInput: string): Promise<BoundFeedbackResult> {
  const drafted = await draftFeedbackBound(cwdInput, runInput);

  if (!drafted.result.ok || !drafted.result.draft || !drafted.context) {
    return drafted;
  }

  const missingEvidence = [];
  for (const evidence of drafted.result.draft.evidence) {
    if (!await isSafeFeedbackEvidenceFile(drafted.context, evidence.path)) {
      missingEvidence.push(evidence.path);
    }
  }

  if (missingEvidence.length > 0) {
    return { context: drafted.context, result: {
      ...drafted.result,
      ok: false,
      error: {
        code: "HUMANISH_INVALID_FEEDBACK_DRAFT",
        message: `Feedback evidence missing: ${missingEvidence.join(", ")}`
      }
    } };
  }

  return drafted;
}

async function isSafeFeedbackEvidenceFile(context: FeedbackRunContext, evidencePath: string): Promise<boolean> {
  const absolute = path.resolve(context.physicalCwd, evidencePath);
  const relative = path.relative(context.preparedRunPaths.physicalRunRoot, absolute);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return false;
  }
  return await readContainedRegularFile(context.preparedRunPaths, relative) !== null;
}

export async function renderIssueMarkdown(
  cwdInput: string,
  runInput: string,
  repo: string
): Promise<FeedbackResult> {
  const verified = await verifyFeedbackBound(cwdInput, runInput);

  if (!verified.result.ok || !verified.result.draft || !verified.result.draftPath || !verified.context) {
    return verified.result;
  }

  const issueMarkdown = renderMarkdown(verified.result.draft, repo);
  const issuePath = path.join(verified.context.preparedRunPaths.relativeRunRoot, "feedback", "issue.md");
  await writeContainedOutputFile(verified.context.preparedRunPaths, path.join("feedback", "issue.md"), issueMarkdown, "utf8");

  return {
    ...verified.result,
    issuePath,
    issueMarkdown
  };
}

export async function renderIssueUrl(cwdInput: string, runInput: string, repo: string): Promise<FeedbackResult> {
  const rendered = await renderIssueMarkdown(cwdInput, runInput, repo);

  if (!rendered.ok || !rendered.issueMarkdown || !rendered.draft) {
    return rendered;
  }

  const title = `[Humanish] ${rendered.draft.summary}`;
  return {
    ...rendered,
    issueUrl: `https://github.com/${encodeGitHubRepoPath(repo)}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(rendered.issueMarkdown)}`
  };
}

export async function listFeedback(cwdInput: string, runInput: string): Promise<FeedbackResult> {
  const cwd = path.resolve(cwdInput);
  const context = await resolveFeedbackRunContext(cwd, runInput);

  if (!context) {
    return {
      schema: FEEDBACK_RESULT_SCHEMA,
      ok: false,
      cwd,
      run: runInput,
      error: {
        code: "HUMANISH_RUN_NOT_FOUND",
        message: `Run not found: ${runInput}`
      }
    };
  }

  const draftBytes = await readContainedRegularFile(context.preparedRunPaths, path.join("feedback", "draft.json"));
  const draft = draftBytes === null ? undefined : JSON.parse(draftBytes.toString("utf8")) as FeedbackDraft;
  const draftPath = path.join(context.preparedRunPaths.relativeRunRoot, "feedback", "draft.json");

  return {
    schema: FEEDBACK_RESULT_SCHEMA,
    ok: true,
    cwd,
    run: runInput,
    ...(draft ? { draftPath, draft } : {})
  };
}

async function resolveFeedbackRunContext(cwd: string, runInput: string): Promise<FeedbackRunContext | null> {
  let physicalCwd: string;
  try {
    physicalCwd = await realpath(cwd);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  let storedRunId = runInput;
  let preparedRunPaths: PreparedRunArtifactPaths;
  if (runInput === "latest") {
    const runsRoot = await bindExistingManagedHumanishOutputDirectory(physicalCwd, "runs");
    if (!runsRoot) return null;
    const pointerBytes = await readContainedRegularFile(runsRoot, "latest.json");
    if (!pointerBytes) return null;
    const pointer = JSON.parse(pointerBytes.toString("utf8")) as { path?: unknown; runId?: unknown };
    if (
      typeof pointer.runId !== "string"
      || typeof pointer.path !== "string"
      || !resolveLatestRunDirectory(physicalCwd, { path: pointer.path, runId: pointer.runId })
    ) {
      return null;
    }
    storedRunId = pointer.runId;
    preparedRunPaths = await bindExistingRunArtifactPaths(physicalCwd, storedRunId);
    if (
      preparedRunPaths.physicalRunsRoot !== runsRoot.physicalPath
      || preparedRunPaths.runsRootIdentity.dev !== runsRoot.identity.dev
      || preparedRunPaths.runsRootIdentity.ino !== runsRoot.identity.ino
    ) {
      throw new Error("Feedback runs root changed physical destination.");
    }
  } else {
    if (!isSafeRunIdSegment(runInput)) return null;
    const boundRunPaths = await bindExistingRunArtifactPaths(physicalCwd, storedRunId).catch(() => null);
    if (!boundRunPaths) return null;
    preparedRunPaths = boundRunPaths;
  }
  const loaded = await loadRunBundlePrepared(physicalCwd, preparedRunPaths);
  if (!loaded) return null;
  await validatePreparedRunArtifactPaths(preparedRunPaths);
  return { cwd, loaded, physicalCwd, preparedRunPaths, storedRunId };
}

function buildDraft(bundle: RunBundle, bundlePath: string): FeedbackDraft {
  const candidate = bundle.feedbackCandidates.find((item): item is RunFeedbackCandidate => isUsableFeedbackCandidate(item));
  if (candidate) {
    return {
      schema: FEEDBACK_SCHEMA,
      run_id: bundle.runId,
      adapter_id: candidate.adapter_id,
      scenario_id: candidate.scenario_id,
      persona_id: candidate.persona_id,
      actor: candidate.actor,
      substrate: candidate.substrate,
      failure_owner: candidate.failure_owner,
      summary: candidate.summary,
      expected: candidate.expected,
      actual: candidate.actual,
      source_candidate_id: candidate.id,
      source_bundle: bundlePath,
      evidence: [
        {
          path: bundlePath,
          kind: "state",
          note: "Source run bundle."
        },
        ...candidate.evidence.map((item) => ({
          path: path.join(path.dirname(bundlePath), item.path),
          kind: item.kind,
          note: item.note
        }))
      ],
      redaction: {
        status: "passed",
        notes: candidate.redaction.notes
      },
      idempotency_key: candidate.idempotency_key,
      proposed_next_state: candidate.proposed_next_state,
      acceptance_proof: candidate.acceptance_proof
    };
  }

  return {
    schema: FEEDBACK_SCHEMA,
    run_id: bundle.runId,
    adapter_id: bundle.source.packageName ?? "synthetic-app",
    scenario_id: bundle.scenario.id,
    persona_id: bundle.persona.id,
    actor: "synthetic-dry-run",
    substrate: "local-filesystem",
    failure_owner: "harness",
    summary: "Dry-run contract proof needs product-evidence follow-up",
    expected: "Humanish should produce verified, public-safe evidence before product claims are filed.",
    actual: "This dry-run produced a contract-proof bundle only; no browser or product behavior was exercised.",
    source_bundle: bundlePath,
    evidence: [
      {
        path: bundlePath,
        kind: "state",
        note: "Synthetic run bundle."
      },
      {
        path: path.join(path.dirname(bundlePath), "review.md"),
        kind: "review",
        note: "Review skeleton labels this as contract proof only."
      }
    ],
    redaction: {
      status: "passed",
      notes: bundle.redaction.notes
    },
    idempotency_key: `humanish:${bundle.runId}:dry-run-contract-proof`,
    proposed_next_state: "watch",
    acceptance_proof: [
      `pnpm humanish -- verify --run ${bundle.runId} --json`,
      `pnpm humanish -- watch --run ${bundle.runId} --no-open`
    ]
  };
}

function isUsableFeedbackCandidate(candidate: unknown): candidate is RunFeedbackCandidate {
  if (!isRecord(candidate)
    || candidate.schema !== "humanish.feedback-candidate.v1"
    || !isRecord(candidate.redaction)
    || candidate.redaction.status !== "passed"
    || typeof candidate.summary !== "string"
    || candidate.summary.trim().length === 0
    || !Array.isArray(candidate.evidence)
  ) {
    return false;
  }

  return candidate.evidence.every((item) =>
    isRecord(item)
    && typeof item.path === "string"
    && item.path.length > 0
    && !path.isAbsolute(item.path)
    && !item.path.includes("://")
    && !item.path.includes("..")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderMarkdown(draft: FeedbackDraft, repo: string): string {
  return `This issue was drafted by Humanish from a verified Humanish run bundle.

It contributes to public-safe simulation harness coverage. The feedback command did not mutate GitHub, commit code, or claim unobserved product behavior.

## Summary

${draft.summary}

## Expected

${draft.expected}

## Actual

${draft.actual}

## Evidence

${draft.evidence.map((item) => `- ${item.kind}: \`${item.path}\` - ${item.note}`).join("\n")}

## Filing Notes

- Repository: ${repo}
- GitHub mutation: not performed
- Substrate: ${draft.substrate}
- Production data: not used

\`\`\`yaml
humanish_feedback:
  schema: ${draft.schema}
  run_id: ${draft.run_id}
  adapter_id: ${draft.adapter_id}
  scenario_id: ${draft.scenario_id}
  persona_id: ${draft.persona_id}
  actor: ${draft.actor}
  substrate: ${draft.substrate}
  failure_owner: ${draft.failure_owner}
${draft.source_candidate_id ? `  source_candidate_id: ${draft.source_candidate_id}\n` : ""}  source_bundle: ${draft.source_bundle}
  evidence:
${draft.evidence.map((item) => `    - path: ${item.path}\n      kind: ${item.kind}\n      note: ${item.note}`).join("\n")}
  redaction:
    status: ${draft.redaction.status}
    notes: ${draft.redaction.notes}
  idempotency_key: ${draft.idempotency_key}
  proposed_next_state: ${draft.proposed_next_state}
  acceptance_proof:
${draft.acceptance_proof.map((proof) => `    - ${proof}`).join("\n")}
\`\`\`
`;
}

function encodeGitHubRepoPath(repo: string): string {
  return repo.split("/").map((part) => encodeURIComponent(part)).join("/");
}

async function writeJson(root: PreparedRunArtifactPaths, relativePath: string, value: unknown): Promise<void> {
  await writeContainedOutputFile(root, relativePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
