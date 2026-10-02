// The feedback commands: resolve a run, draft a feedback issue from it, verify the draft, render it
// as an issue body or URL, and list a run's candidates. What a draft contains is in draft.ts.

import { realpath } from "node:fs/promises";
import path from "node:path";
import type { RunBundle, RunFeedbackCandidate } from "../run/bundle.js";
import {
  bindExistingRunArtifactPaths,
  isSafeRunIdSegment,
  resolveLatestRunDirectory,
  validatePreparedRunArtifactPaths,
  type PreparedRunArtifactPaths,
} from "../run/paths.js";
import {
  bindExistingManagedHumanishOutputDirectory,
  readContainedRegularFile,
  writeContainedOutputFile,
} from "../run/contained-output.js";
import { loadRunBundlePrepared } from "../run/locate.js";
import { verifyRunPrepared, type VerifyResult } from "../verify/verify.js";
import {
  buildAnalysisDraft,
  buildDraft,
  isUsableFeedbackCandidate,
  renderMarkdown,
  type FeedbackDraft,
  type FeedbackDraftOptions,
  type FeedbackRunContext,
} from "./draft.js";

const FEEDBACK_RESULT_SCHEMA = "humanish.feedback-result.v1";

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
  /** Every usable candidate on the bundle, so a multi-participant study's second and third findings can be
   *  chosen with `--candidate` instead of being invisible behind the first (#609). */
  candidates?: FeedbackCandidateSummary[];
  shareSafety?: VerifyResult["shareSafety"];
  error?: {
    code:
      | "HUMANISH_RUN_NOT_FOUND"
      | "HUMANISH_INVALID_RUN_BUNDLE"
      | "HUMANISH_INVALID_FEEDBACK_DRAFT"
      | "HUMANISH_FEEDBACK_SHARE_SAFETY_BLOCKED"
      | "HUMANISH_FEEDBACK_CANDIDATE_NOT_FOUND";
    message: string;
  };
}

/** One row of `feedback list`: enough to choose a candidate, never the evidence itself. */
interface FeedbackCandidateSummary {
  id: string;
  stream_id?: string;
  persona_id: string;
  failure_owner: RunFeedbackCandidate["failure_owner"];
  summary: string;
}

function summarizeCandidates(bundle: RunBundle): FeedbackCandidateSummary[] {
  return bundle.feedbackCandidates
    .filter((item): item is RunFeedbackCandidate => isUsableFeedbackCandidate(item))
    .map((item) => ({
      id: item.id,
      ...(item.stream_id === undefined ? {} : { stream_id: item.stream_id }),
      persona_id: item.persona_id,
      failure_owner: item.failure_owner,
      summary: item.summary,
    }));
}

interface BoundFeedbackResult {
  context?: FeedbackRunContext;
  result: FeedbackResult;
}

export async function draftFeedback(
  cwdInput: string,
  runInput: string,
  options: FeedbackDraftOptions = {},
): Promise<FeedbackResult> {
  return (await draftFeedbackBound(cwdInput, runInput, options)).result;
}

async function draftFeedbackBound(
  cwdInput: string,
  runInput: string,
  options: FeedbackDraftOptions = {},
): Promise<BoundFeedbackResult> {
  const cwd = path.resolve(cwdInput);
  const context = await resolveFeedbackRunContext(cwd, runInput);

  if (!context) {
    return {
      result: {
        schema: FEEDBACK_RESULT_SCHEMA,
        ok: false,
        cwd,
        run: runInput,
        error: {
          code: "HUMANISH_RUN_NOT_FOUND",
          message: `Run not found: ${runInput}`,
        },
      },
    };
  }

  const verified = await verifyRunPrepared(
    context.physicalCwd,
    context.storedRunId,
    context.preparedRunPaths,
  );
  await validatePreparedRunArtifactPaths(context.preparedRunPaths);
  if (!verified.ok) {
    return {
      context,
      result: {
        schema: FEEDBACK_RESULT_SCHEMA,
        ok: false,
        cwd,
        run: runInput,
        error: {
          code: "HUMANISH_INVALID_RUN_BUNDLE",
          message: verified.error?.message ?? "Run bundle failed verification.",
        },
      },
    };
  }

  if (verified.shareSafety.status !== "share_ready") {
    return {
      context,
      result: {
        schema: FEEDBACK_RESULT_SCHEMA,
        ok: false,
        cwd,
        run: runInput,
        shareSafety: verified.shareSafety,
        error: {
          code: "HUMANISH_FEEDBACK_SHARE_SAFETY_BLOCKED",
          message: `Run is ${verified.shareSafety.status}, not share_ready: ${verified.shareSafety.reasons.map((reason) => reason.code).join(", ")}`,
        },
      },
    };
  }

  const candidates = summarizeCandidates(context.loaded.bundle);
  if (
    options.candidate !== undefined &&
    !candidates.some((item) => item.id === options.candidate)
  ) {
    return {
      context,
      result: {
        schema: FEEDBACK_RESULT_SCHEMA,
        ok: false,
        cwd,
        run: runInput,
        candidates,
        error: {
          code: "HUMANISH_FEEDBACK_CANDIDATE_NOT_FOUND",
          message:
            candidates.length === 0
              ? `No feedback candidate on run ${context.storedRunId}; \`--candidate ${options.candidate}\` cannot be drafted.`
              : `No feedback candidate \`${options.candidate}\` on run ${context.storedRunId}. Available: ${candidates.map((item) => item.id).join(", ")}.`,
        },
      },
    };
  }

  const independent = options.analysis !== undefined || options.finding !== undefined;
  const draft = independent
    ? await buildAnalysisDraft(context, options)
    : buildDraft(context.loaded.bundle, context.loaded.bundlePath, options.candidate);
  if (!draft)
    return {
      context,
      result: {
        schema: FEEDBACK_RESULT_SCHEMA,
        ok: false,
        cwd,
        run: runInput,
        error: {
          code: "HUMANISH_INVALID_FEEDBACK_DRAFT",
          message:
            "Select a current valid analysis and finding together, without --candidate. Dismissed findings cannot be promoted into feedback.",
        },
      },
    };
  const draftPath = path.join(context.preparedRunPaths.relativeRunRoot, "feedback", "draft.json");
  await writeJson(context.preparedRunPaths, path.join("feedback", "draft.json"), draft);

  return {
    context,
    result: {
      schema: FEEDBACK_RESULT_SCHEMA,
      ok: true,
      cwd,
      run: runInput,
      draftPath,
      draft,
      candidates,
    },
  };
}

export async function verifyFeedback(
  cwdInput: string,
  runInput: string,
  options: FeedbackDraftOptions = {},
): Promise<FeedbackResult> {
  return (await verifyFeedbackBound(cwdInput, runInput, options)).result;
}

async function verifyFeedbackBound(
  cwdInput: string,
  runInput: string,
  options: FeedbackDraftOptions = {},
): Promise<BoundFeedbackResult> {
  const drafted = await draftFeedbackBound(cwdInput, runInput, options);

  if (!drafted.result.ok || !drafted.result.draft || !drafted.context) {
    return drafted;
  }

  const missingEvidence = [];
  for (const evidence of drafted.result.draft.evidence) {
    if (!(await isSafeFeedbackEvidenceFile(drafted.context, evidence.path))) {
      missingEvidence.push(evidence.path);
    }
  }

  if (missingEvidence.length > 0) {
    return {
      context: drafted.context,
      result: {
        ...drafted.result,
        ok: false,
        error: {
          code: "HUMANISH_INVALID_FEEDBACK_DRAFT",
          message: `Feedback evidence missing: ${missingEvidence.join(", ")}`,
        },
      },
    };
  }

  return drafted;
}

async function isSafeFeedbackEvidenceFile(
  context: FeedbackRunContext,
  evidencePath: string,
): Promise<boolean> {
  const absolute = path.resolve(context.physicalCwd, evidencePath);
  const relative = path.relative(context.preparedRunPaths.physicalRunRoot, absolute);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return false;
  }
  return (await readContainedRegularFile(context.preparedRunPaths, relative)) !== null;
}

export async function renderIssueMarkdown(
  cwdInput: string,
  runInput: string,
  repo: string,
  options: FeedbackDraftOptions = {},
): Promise<FeedbackResult> {
  const verified = await verifyFeedbackBound(cwdInput, runInput, options);

  if (
    !verified.result.ok ||
    !verified.result.draft ||
    !verified.result.draftPath ||
    !verified.context
  ) {
    return verified.result;
  }

  const issueMarkdown = renderMarkdown(verified.result.draft, repo);
  const issuePath = path.join(
    verified.context.preparedRunPaths.relativeRunRoot,
    "feedback",
    "issue.md",
  );
  await writeContainedOutputFile(
    verified.context.preparedRunPaths,
    path.join("feedback", "issue.md"),
    issueMarkdown,
    "utf8",
  );

  return {
    ...verified.result,
    issuePath,
    issueMarkdown,
  };
}

export async function renderIssueUrl(
  cwdInput: string,
  runInput: string,
  repo: string,
  options: FeedbackDraftOptions = {},
): Promise<FeedbackResult> {
  const rendered = await renderIssueMarkdown(cwdInput, runInput, repo, options);

  if (!rendered.ok || !rendered.issueMarkdown || !rendered.draft) {
    return rendered;
  }

  const title = `[humanish] ${rendered.draft.summary}`;
  return {
    ...rendered,
    issueUrl: `https://github.com/${encodeGitHubRepoPath(repo)}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(rendered.issueMarkdown)}`,
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
        message: `Run not found: ${runInput}`,
      },
    };
  }

  const draftBytes = await readContainedRegularFile(
    context.preparedRunPaths,
    path.join("feedback", "draft.json"),
  );
  const draft =
    draftBytes === null ? undefined : (JSON.parse(draftBytes.toString("utf8")) as FeedbackDraft);
  const draftPath = path.join(context.preparedRunPaths.relativeRunRoot, "feedback", "draft.json");

  return {
    schema: FEEDBACK_RESULT_SCHEMA,
    ok: true,
    cwd,
    run: runInput,
    ...(draft ? { draftPath, draft } : {}),
    // The choice set for `draft --candidate`: a three-participant study has up to three findings,
    // and until #609 only the first ever reached a draft.
    candidates: summarizeCandidates(context.loaded.bundle),
  };
}

async function resolveFeedbackRunContext(
  cwd: string,
  runInput: string,
): Promise<FeedbackRunContext | null> {
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
    const pointer = JSON.parse(pointerBytes.toString("utf8")) as {
      path?: unknown;
      runId?: unknown;
    };
    if (
      typeof pointer.runId !== "string" ||
      typeof pointer.path !== "string" ||
      !resolveLatestRunDirectory(physicalCwd, { path: pointer.path, runId: pointer.runId })
    ) {
      return null;
    }
    storedRunId = pointer.runId;
    preparedRunPaths = await bindExistingRunArtifactPaths(physicalCwd, storedRunId);
    if (
      preparedRunPaths.physicalRunsRoot !== runsRoot.physicalPath ||
      preparedRunPaths.runsRootIdentity.birthtimeNs !== runsRoot.identity.birthtimeNs ||
      preparedRunPaths.runsRootIdentity.dev !== runsRoot.identity.dev ||
      preparedRunPaths.runsRootIdentity.ino !== runsRoot.identity.ino
    ) {
      throw new Error("Feedback runs root changed physical destination.");
    }
  } else {
    if (!isSafeRunIdSegment(runInput)) return null;
    const boundRunPaths = await bindExistingRunArtifactPaths(physicalCwd, storedRunId).catch(
      () => null,
    );
    if (!boundRunPaths) return null;
    preparedRunPaths = boundRunPaths;
  }
  const loaded = await loadRunBundlePrepared(physicalCwd, preparedRunPaths);
  if (!loaded) return null;
  await validatePreparedRunArtifactPaths(preparedRunPaths);
  return { cwd, loaded, physicalCwd, preparedRunPaths, storedRunId };
}

function encodeGitHubRepoPath(repo: string): string {
  return repo
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

async function writeJson(
  root: PreparedRunArtifactPaths,
  relativePath: string,
  value: unknown,
): Promise<void> {
  await writeContainedOutputFile(root, relativePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
