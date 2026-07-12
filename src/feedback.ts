import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadRunBundle, verifyRun } from "./run.js";
import type { RunBundle, RunFeedbackCandidate, VerifyResult } from "./run.js";

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

export async function draftFeedback(cwdInput: string, runInput: string): Promise<FeedbackResult> {
  const cwd = path.resolve(cwdInput);
  const loaded = await loadRunBundle(cwd, runInput);

  if (!loaded) {
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

  const verified = await verifyRun(cwd, runInput);
  if (!verified.ok) {
    return {
      schema: FEEDBACK_RESULT_SCHEMA,
      ok: false,
      cwd,
      run: runInput,
      error: {
        code: "HUMANISH_INVALID_RUN_BUNDLE",
        message: verified.error?.message ?? "Run bundle failed verification."
      }
    };
  }

  if (verified.shareSafety.status !== "share_ready") {
    return {
      schema: FEEDBACK_RESULT_SCHEMA,
      ok: false,
      cwd,
      run: runInput,
      shareSafety: verified.shareSafety,
      error: {
        code: "HUMANISH_FEEDBACK_SHARE_SAFETY_BLOCKED",
        message: `Run is ${verified.shareSafety.status}, not share_ready: ${verified.shareSafety.reasons.map((reason) => reason.code).join(", ")}`
      }
    };
  }

  const draft = buildDraft(loaded.bundle, loaded.bundlePath);
  const feedbackDir = path.join(loaded.runDir, "feedback");
  const draftPath = path.join(feedbackDir, "draft.json");
  await mkdir(feedbackDir, { recursive: true });
  await writeJson(draftPath, draft);

  return {
    schema: FEEDBACK_RESULT_SCHEMA,
    ok: true,
    cwd,
    run: runInput,
    draftPath: path.relative(cwd, draftPath),
    draft
  };
}

export async function verifyFeedback(cwdInput: string, runInput: string): Promise<FeedbackResult> {
  const drafted = await draftFeedback(cwdInput, runInput);

  if (!drafted.ok || !drafted.draft) {
    return drafted;
  }

  const missingEvidence = [];
  for (const evidence of drafted.draft.evidence) {
    if (!await fileExists(path.join(drafted.cwd, evidence.path))) {
      missingEvidence.push(evidence.path);
    }
  }

  if (missingEvidence.length > 0) {
    return {
      ...drafted,
      ok: false,
      error: {
        code: "HUMANISH_INVALID_FEEDBACK_DRAFT",
        message: `Feedback evidence missing: ${missingEvidence.join(", ")}`
      }
    };
  }

  return drafted;
}

export async function renderIssueMarkdown(
  cwdInput: string,
  runInput: string,
  repo: string
): Promise<FeedbackResult> {
  const verified = await verifyFeedback(cwdInput, runInput);

  if (!verified.ok || !verified.draft || !verified.draftPath) {
    return verified;
  }

  const loaded = await loadRunBundle(verified.cwd, runInput);
  if (!loaded) {
    return verified;
  }

  const issueMarkdown = renderMarkdown(verified.draft, repo);
  const issuePath = path.join(loaded.runDir, "feedback", "issue.md");
  await writeFile(issuePath, issueMarkdown, "utf8");

  return {
    ...verified,
    issuePath: path.relative(verified.cwd, issuePath),
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
  const loaded = await loadRunBundle(cwd, runInput);

  if (!loaded) {
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

  const draftPath = path.join(loaded.runDir, "feedback", "draft.json");
  const draftText = await readTextIfExists(draftPath);
  const draft = draftText === null ? undefined : JSON.parse(draftText) as FeedbackDraft;

  return {
    schema: FEEDBACK_RESULT_SCHEMA,
    ok: true,
    cwd,
    run: runInput,
    ...(draft ? { draftPath: path.relative(cwd, draftPath), draft } : {})
  };
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

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}
