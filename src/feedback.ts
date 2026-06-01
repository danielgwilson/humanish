import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadRunBundle, verifyRun } from "./run.js";
import type { RunBundle } from "./run.js";

export const FEEDBACK_SCHEMA = "mimetic.feedback.v1";
export const FEEDBACK_RESULT_SCHEMA = "mimetic.feedback-result.v1";

export interface FeedbackDraft {
  schema: typeof FEEDBACK_SCHEMA;
  run_id: string;
  adapter_id: string;
  scenario_id: string;
  persona_id: string;
  actor: "synthetic-dry-run";
  substrate: "local-filesystem";
  failure_owner: "harness";
  summary: string;
  expected: string;
  actual: string;
  source_bundle: string;
  evidence: Array<{
    path: string;
    kind: "review" | "state";
    note: string;
  }>;
  redaction: {
    status: "passed";
    notes: string;
  };
  idempotency_key: string;
  proposed_next_state: "watch";
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
  error?: {
    code: "MIMETIC_RUN_NOT_FOUND" | "MIMETIC_INVALID_RUN_BUNDLE" | "MIMETIC_INVALID_FEEDBACK_DRAFT";
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
        code: "MIMETIC_RUN_NOT_FOUND",
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
        code: "MIMETIC_INVALID_RUN_BUNDLE",
        message: verified.error?.message ?? "Run bundle failed verification."
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
        code: "MIMETIC_INVALID_FEEDBACK_DRAFT",
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

  const title = `[Mimetic] ${rendered.draft.summary}`;
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
        code: "MIMETIC_RUN_NOT_FOUND",
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
    expected: "Mimetic should produce verified, public-safe evidence before product claims are filed.",
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
    idempotency_key: `mimetic:${bundle.runId}:dry-run-contract-proof`,
    proposed_next_state: "watch",
    acceptance_proof: [
      `pnpm mimetic -- verify --run ${bundle.runId} --json`,
      `pnpm mimetic -- watch --run ${bundle.runId} --no-open`
    ]
  };
}

function renderMarkdown(draft: FeedbackDraft, repo: string): string {
  return `This issue was drafted by Mimetic from a verified dry-run bundle.

It contributes to public-safe simulation harness coverage. It does not claim product behavior proof.

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
- Provider spend: not used
- Production data: not used

\`\`\`yaml
mimetic_feedback:
  schema: ${draft.schema}
  run_id: ${draft.run_id}
  adapter_id: ${draft.adapter_id}
  scenario_id: ${draft.scenario_id}
  persona_id: ${draft.persona_id}
  actor: ${draft.actor}
  substrate: ${draft.substrate}
  failure_owner: ${draft.failure_owner}
  source_bundle: ${draft.source_bundle}
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
