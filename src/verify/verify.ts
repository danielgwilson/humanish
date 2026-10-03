import path from "node:path";
import { listAnalysisExecutions } from "../analysis/store-executions.js";
import { loadAnalysis } from "../analysis/load.js";
import { analysisSharingProblems } from "../analysis/sharing.js";
import { containsSensitive, REDACTED_SANDBOX_ID } from "../evidence/redaction.js";
import { readRunSandboxIds } from "../run/sandbox-ids.js";
import { validatePreparedRunArtifactPaths, type PreparedRunArtifactPaths } from "../run/paths.js";
import { RUN_BUNDLE_FILE, RUN_BUNDLE_SCHEMA, type RunBundle } from "../run/bundle.js";
import { isCleanupResult, isRunBundle } from "../run/bundle-shape.js";
import { readRunJsonIfExists, readRunTextIfExists, resolveRunPath } from "../run/locate.js";
import { isRecord } from "../run/type-guards.js";
import { runNotFoundMessage } from "../run/run-not-found.js";
import {
  actorVerdictConsistencyFindings,
  noEngagementActorFindings,
  validateCodexAppServerEvidence,
  validateTerminalProductEvidence,
} from "./actor.js";
import {
  invalidRunEvidenceReferences,
  MAX_REPORTED_FINDINGS,
  missingLocalEvidenceArtifacts,
  rawScreenshotPostureWarnings,
  rawScreenshotStreamIds,
  redactedShapeFramePaths,
  scanRunPublicSafetyArtifacts,
  streamScreenshotPaths,
} from "./artifacts.js";
import { flatContextWarnings } from "./context-growth.js";
import { runNotFinishedWarnings } from "./liveness.js";
import { costAndReceiptFindings } from "./costs.js";
import { rerunLineageFindings } from "./rerun.js";
import { sharedWorldEvidenceFindings } from "./shared-world.js";
import { subjectStateFindings, undeclaredSubjectStateWarnings } from "./subject.js";
import { plural } from "../run/text.js";

export const VERIFY_SCHEMA = "humanish.verify-result.v1";

// The UNSCANNED_ARTIFACT reason names this many paths and counts the rest.
const MAX_LISTED_UNSCANNED = 10;

export interface VerifyResult {
  schema: typeof VERIFY_SCHEMA;
  ok: boolean;
  /** Only present when source evidence verifies but derived analysis failed the public-safety scan. */
  recordingOk?: boolean;
  cwd: string;
  run: string;
  bundlePath?: string;
  checks: Array<{
    name: string;
    ok: boolean;
    message: string;
  }>;
  shareSafety: {
    status: "share_ready" | "local_only" | "blocked";
    reasons: Array<{
      code:
        | "VERIFY_FAILED"
        | "PUBLIC_SAFETY_FINDINGS"
        | "ANALYSIS_UNVERIFIED"
        | "RAW_SCREENSHOTS"
        | "RAW_SANDBOX_ID"
        | "CONTINUOUS_MEDIA"
        | "REAL_COMMUNICATIONS"
        | "UNSCANNED_ARTIFACT";
      message: string;
    }>;
  };
  // Advisory postures the operator must see (e.g. raw full-fidelity screenshots) that never
  // flip ok: overriding a default is supported, but ok: true must not read as "share-ready".
  warnings: string[];
  error?: {
    code: "HUMANISH_RUN_NOT_FOUND" | "HUMANISH_INVALID_RUN_BUNDLE";
    message: string;
  };
}

export async function verifyRun(cwdInput: string, runInput: string): Promise<VerifyResult> {
  const cwd = path.resolve(cwdInput);
  let runPaths: PreparedRunArtifactPaths | null;
  try {
    runPaths = await resolveRunPath(cwd, runInput);
  } catch {
    return invalidRunStorageVerifyResult(cwd, runInput);
  }
  return verifyResolvedRun(cwd, runInput, runPaths);
}

export function invalidRunStorageVerifyResult(cwd: string, runInput: string): VerifyResult {
  return {
    schema: VERIFY_SCHEMA,
    ok: false,
    cwd,
    run: runInput,
    checks: [
      {
        name: "run storage containment",
        ok: false,
        message:
          "run storage must contain only identity-bound directories and single-link regular files",
      },
    ],
    shareSafety: {
      status: "blocked",
      reasons: [{ code: "VERIFY_FAILED", message: "Run storage failed containment validation." }],
    },
    warnings: [],
    error: {
      code: "HUMANISH_INVALID_RUN_BUNDLE",
      message: "Run storage failed containment validation.",
    },
  };
}

/** Verify a run already resolved to prepared paths; null reports the run as not found. */
export async function verifyResolvedRun(
  cwd: string,
  runInput: string,
  runPaths: PreparedRunArtifactPaths | null,
): Promise<VerifyResult> {
  const checks: VerifyResult["checks"] = [];

  if (!runPaths) {
    const message = await runNotFoundMessage(cwd, runInput);
    return {
      schema: VERIFY_SCHEMA,
      ok: false,
      cwd,
      run: runInput,
      checks,
      shareSafety: { status: "blocked", reasons: [{ code: "VERIFY_FAILED", message }] },
      warnings: [],
      error: { code: "HUMANISH_RUN_NOT_FOUND", message },
    };
  }

  const bundlePath = path.join(runPaths.absoluteRunRoot, RUN_BUNDLE_FILE);
  const bundle = await readRunJsonIfExists(runPaths, RUN_BUNDLE_FILE);
  const cleanupJson = await readRunJsonIfExists(runPaths, "cleanup.json");
  const reviewJson = await readRunJsonIfExists(runPaths, "review.json");
  const reviewMarkdown = await readRunTextIfExists(runPaths, "review.md");

  checks.push(
    ...bundlePresenceChecks(bundle, {
      json: reviewJson !== null,
      markdown: reviewMarkdown !== null,
    }),
  );
  const derivedPublicSafetyFindings: string[] = [];
  const unscannedArtifacts: string[] = [];
  const sandboxIdFiles: string[] = [];
  const publicSafetyFindings = await scanRunPublicSafetyArtifacts(
    runPaths,
    derivedPublicSafetyFindings,
    {
      recordingPaths: new Set(
        isRunBundle(bundle)
          ? bundle.streams.flatMap((stream) => (stream.recording ? [stream.recording.path] : []))
          : [],
      ),
      screenshotPaths: isRunBundle(bundle) ? streamScreenshotPaths(bundle) : new Set(),
      sandboxIds: await readRunSandboxIds(runPaths),
      sandboxIdFiles,
    },
    unscannedArtifacts,
  );
  // JSON escapes can hide a sensitive value from the byte scan while the
  // decoded recording exposes it to Observer, feedback, or analysis input.
  if (
    publicSafetyFindings.length < MAX_REPORTED_FINDINGS &&
    bundle !== null &&
    containsSensitive(JSON.stringify(bundle))
  ) {
    publicSafetyFindings.push("sensitive decoded run.json");
  }
  checks.push({
    name: "public-safety scan",
    ok: publicSafetyFindings.length === 0,
    message:
      publicSafetyFindings.length === 0
        ? "no run text artifact or public-proof path matches a known secret or browser-profile pattern"
        : `public-safety findings: ${publicSafetyFindings.slice(0, 5).join(", ")}`,
  });
  const missingEvidenceArtifacts = isRunBundle(bundle)
    ? await missingLocalEvidenceArtifacts(runPaths, bundle)
    : [];
  const redactedShapeFrames = isRunBundle(bundle)
    ? await redactedShapeFramePaths(runPaths, bundle)
    : new Set<string>();
  const invalidEvidenceReferences = isRunBundle(bundle) ? invalidRunEvidenceReferences(bundle) : [];
  checks.push({
    name: "local evidence artifacts exist",
    ok: missingEvidenceArtifacts.length === 0 && invalidEvidenceReferences.length === 0,
    message:
      missingEvidenceArtifacts.length === 0 && invalidEvidenceReferences.length === 0
        ? isRunBundle(bundle)
          ? "every referenced screenshot, trace, log and filesystem artifact is present"
          : SHAPE_UNCHECKED
        : invalidEvidenceReferences.length > 0
          ? `invalid evidence artifact references: ${invalidEvidenceReferences.join(", ")}`
          : `missing local evidence artifacts: ${missingEvidenceArtifacts.join(", ")}`,
  });
  checks.push(...(await evidenceChecks(runPaths, bundle, cleanupJson)));

  const recordingOk = checks.every((check) => check.ok);
  if (derivedPublicSafetyFindings.length > 0)
    checks.push({
      name: "derived analysis public-safety scan",
      ok: false,
      message:
        "Derived analysis contains sensitive text or unsafe artifact paths; sharing is blocked, original recording remains independently verifiable.",
    });
  const ok = checks.every((check) => check.ok);
  const warnings = isRunBundle(bundle)
    ? [
        ...rawScreenshotPostureWarnings(bundle, redactedShapeFrames),
        ...undeclaredSubjectStateWarnings(bundle),
        ...desktopGeometryWarnings(bundle),
        ...flatContextWarnings(bundle),
        ...(await runNotFinishedWarnings(runPaths, bundle)),
      ]
    : [];
  const shareSafety = isRunBundle(bundle)
    ? buildShareSafety({
        ok,
        bundle,
        publicSafetyFindings,
        unscannedArtifacts,
        redactedShapeFrames,
        sandboxIdFiles,
      })
    : {
        status: "blocked" as const,
        reasons: [
          {
            code: "VERIFY_FAILED" as const,
            message: "Run bundle failed verification.",
          },
        ],
      };

  await applyAnalysisSharing(runPaths, warnings, shareSafety);

  return {
    schema: VERIFY_SCHEMA,
    ok,
    ...(!ok && recordingOk ? { recordingOk: true } : {}),
    cwd,
    run: runInput,
    bundlePath: path.relative(cwd, bundlePath),
    checks,
    shareSafety,
    warnings,
    ...(ok
      ? {}
      : {
          error: {
            code: "HUMANISH_INVALID_RUN_BUNDLE" as const,
            message: "Run bundle failed verification.",
          },
        }),
  };
}

/** verifyRun for a caller that already holds prepared paths. Revalidates them first. */
export async function verifyRunPrepared(
  cwdInput: string,
  runInput: string,
  runPaths: PreparedRunArtifactPaths,
): Promise<VerifyResult> {
  const cwd = path.resolve(cwdInput);
  try {
    await validatePreparedRunArtifactPaths(runPaths);
  } catch {
    return invalidRunStorageVerifyResult(cwd, runInput);
  }
  return verifyResolvedRun(cwd, runInput, runPaths);
}

type VerifyCheck = VerifyResult["checks"][number];

/** The top-level run.json sections the shape guard requires. */
const REQUIRED_SECTIONS = [
  "source",
  "persona",
  "scenario",
  "lifecycle",
  "simulations",
  "streams",
  "events",
  "artifacts",
  "review",
  "redaction",
  "feedbackCandidates",
] as const;

/**
 * Whether run.json, its schema, shape and redaction, and the review artifacts are present. Each
 * check says what it found, so a failing row never prints the rule it enforces.
 */
function bundlePresenceChecks(
  bundle: unknown,
  review: { json: boolean; markdown: boolean },
): VerifyCheck[] {
  const record = isRecord(bundle) ? bundle : undefined;
  const schema = record?.schema;
  const schemaOk = schema === RUN_BUNDLE_SCHEMA;
  const redactionRecord = record?.redaction;
  const redaction = isRecord(redactionRecord) ? redactionRecord.status : undefined;
  const missingSections = REQUIRED_SECTIONS.filter((key) => record?.[key] === undefined);
  const missingReview = [
    ...(review.json ? [] : ["review.json is missing or not valid JSON"]),
    ...(review.markdown ? [] : ["review.md is missing"]),
  ];
  return [
    {
      name: "run.json exists",
      ok: bundle !== null,
      message: bundle === null ? "run.json is missing or not valid JSON" : "run.json is present",
    },
    {
      name: "run schema",
      ok: schemaOk,
      message: schemaOk
        ? `run.json declares ${RUN_BUNDLE_SCHEMA}`
        : record === undefined
          ? "no readable run.json, so no schema"
          : `run.json declares ${typeof schema === "string" ? schema : "no schema"}; verify reads ${RUN_BUNDLE_SCHEMA}`,
    },
    {
      name: "run bundle shape",
      ok: isRunBundle(bundle),
      message: isRunBundle(bundle)
        ? "run.json has every required section"
        : record === undefined
          ? "no readable run.json, so no sections"
          : missingSections.length > 0
            ? `run.json is missing ${missingSections.join(", ")}`
            : schemaOk
              ? "one or more run.json sections have the wrong shape"
              : "sections not checked, because the schema differs",
    },
    {
      name: "redaction passed",
      ok: redaction === "passed",
      message:
        redaction === "passed"
          ? "redaction passed"
          : `redaction did not pass (status: ${typeof redaction === "string" ? redaction : "missing"})`,
    },
    {
      name: "review artifacts exist",
      ok: missingReview.length === 0,
      message:
        missingReview.length === 0
          ? "review.json and review.md are present"
          : missingReview.join("; "),
    },
  ];
}

/**
 * Interpretation validity is independent of run validity. Keep recordings usable, while refusing
 * to silently promote stale or malformed derived text into sharing.
 */
async function applyAnalysisSharing(
  runPaths: PreparedRunArtifactPaths,
  warnings: string[],
  shareSafety: VerifyResult["shareSafety"],
): Promise<void> {
  const analysis = await loadAnalysis(runPaths);
  const analysisSharing = analysisSharingProblems(analysis);
  const executionHistory = await listAnalysisExecutions(runPaths);
  if (
    !analysisSharing.unverified &&
    !analysisSharing.sensitive &&
    executionHistory.warnings.length === 0
  )
    return;
  warnings.push(
    "Some study analysis or correction records could not be validated against current evidence.",
  );
  shareSafety.reasons.push({
    code: "ANALYSIS_UNVERIFIED",
    message:
      "Derived analysis or corrections need review against the current evidence before sharing.",
  });
  if (analysisSharing.sensitive) shareSafety.status = "blocked";
  else if (shareSafety.status === "share_ready") shareSafety.status = "local_only";
}

/** Passes when `findings` is empty; otherwise lists them after `failLabel`. */
function findingsCheck(
  name: string,
  findings: readonly string[],
  okMessage: string,
  failLabel: string,
): VerifyCheck {
  return {
    name,
    ok: findings.length === 0,
    message: findings.length === 0 ? okMessage : `${failLabel}: ${findings.join(", ")}`,
  };
}

/**
 * The pass message of a check that reads bundle content when run.json failed its shape guard. The
 * check has no findings and stays ok; the shape check is the failure.
 */
const SHAPE_UNCHECKED = "not checked, because run.json failed the shape check";

/** The bundle-content checks, in report order. A bundle that fails its shape guard has no findings. */
async function evidenceChecks(
  runPaths: PreparedRunArtifactPaths,
  bundle: unknown,
  cleanupJson: unknown,
): Promise<VerifyCheck[]> {
  const valid = isRunBundle(bundle) ? bundle : null;
  const pass = (message: string) => (valid ? message : SHAPE_UNCHECKED);
  const checks: VerifyCheck[] = [
    findingsCheck(
      "terminal-product evidence",
      valid ? await validateTerminalProductEvidence(runPaths, valid) : [],
      pass(
        "live terminal-product evidence is complete (ledgers, redacted output, proven teardown, known spend within the cap), or the run has none",
      ),
      "terminal-product findings",
    ),
    findingsCheck(
      "codex app-server evidence",
      valid ? await validateCodexAppServerEvidence(runPaths, valid) : [],
      pass("live Codex app-server traces are valid and redacted, or the run has none"),
      "codex app-server findings",
    ),
    findingsCheck(
      "actor engagement",
      valid ? noEngagementActorFindings(valid) : [],
      pass("every live actor that claims its goal took at least one action or sent a message"),
      "no-engagement findings",
    ),
    findingsCheck(
      "actor verdict consistency",
      valid ? actorVerdictConsistencyFindings(valid) : [],
      pass("no live pass verdict hides a failed, blocked or timed-out actor"),
      "actor verdict findings",
    ),
    findingsCheck(
      "subject state provenance",
      valid ? subjectStateFindings(valid) : [],
      pass(
        "subject state claims match the recorded seed and external evidence, or the run makes none",
      ),
      "subject state findings",
    ),
    findingsCheck(
      "shared-world evidence",
      valid ? sharedWorldEvidenceFindings(valid) : [],
      pass(
        "live shared-world evidence is well formed for its mode, with single-plane provenance, digest-only checkpoints and attributionLimits, or the run has none",
      ),
      "shared-world findings",
    ),
    {
      name: "cleanup receipt",
      ok: cleanupJson === null || (isCleanupResult(cleanupJson) && cleanupJson.ok),
      message:
        cleanupJson === null
          ? "no cleanup.json; cleanup was not requested"
          : !isCleanupResult(cleanupJson)
            ? "cleanup.json is malformed"
            : cleanupJson.ok
              ? "cleanup.json records a successful cleanup"
              : "cleanup.json records a failed cleanup",
    },
    findingsCheck(
      "rerun lineage",
      valid ? rerunLineageFindings(valid) : [],
      pass(
        "rerun participants link to their prior status and a fan-out rerun event, or this run is not a rerun",
      ),
      "rerun lineage findings",
    ),
    // Cost is advisory on magnitude and fail-closed on labeling/provenance (claims match mechanism).
    // Absence passes (fail-open on display); a claimed dollar figure without its ratesAsOf date +
    // source, or a total that does not match its known lines, fails. Magnitude is never inspected:
    // a correctly-labeled huge estimate still passes.
    findingsCheck(
      "cost estimate labeling",
      valid ? costAndReceiptFindings(valid) : [],
      pass(
        "every cost estimate carries its ratesAsOf date and source and the total matches its lines, or the run claims no cost",
      ),
      "cost labeling findings",
    ),
  ];
  return checks;
}

/** Non-fatal hosted-desktop geometry disclosures, deduplicated across shared-screen streams. */
function desktopGeometryWarnings(bundle: RunBundle): string[] {
  return [...new Set(bundle.streams.flatMap((stream) => stream.desktopGeometry?.warnings ?? []))];
}

function buildShareSafety(args: {
  ok: boolean;
  bundle: RunBundle;
  publicSafetyFindings: string[];
  unscannedArtifacts: string[];
  /** Declared frames whose bytes have the redactor's output shape. */
  redactedShapeFrames: ReadonlySet<string>;
  /** Files other than sandbox-receipts.ndjson that name one of the run's raw sandbox ids. */
  sandboxIdFiles: readonly string[];
}): VerifyResult["shareSafety"] {
  const reasons: VerifyResult["shareSafety"]["reasons"] = [];

  if (!args.ok) {
    reasons.push({
      code: "VERIFY_FAILED",
      message: "The run bundle is not valid enough to promote into public feedback.",
    });
  }

  if (args.publicSafetyFindings.length > 0) {
    reasons.push({
      code: "PUBLIC_SAFETY_FINDINGS",
      message:
        "Text artifacts or public-proof paths matched known secret, token, local-path, browser-profile, or hosted-substrate URL patterns.",
    });
  }

  if (args.bundle.publication !== undefined || args.bundle.commsReceiving !== undefined) {
    reasons.push({
      code: "REAL_COMMUNICATIONS",
      message:
        "This study used real email. Message content may appear in recordings, narration or analysis. Local review is supported; screenshot blurring does not make it public-safe.",
    });
  }
  if (args.bundle.streams.some((stream) => stream.recording !== undefined)) {
    reasons.push({
      code: "CONTINUOUS_MEDIA",
      message:
        "Continuous screen/audio recordings are retained for local review. Screenshot redaction does not redact this media.",
    });
  }
  if (args.unscannedArtifacts.length > 0) {
    const paths = [...args.unscannedArtifacts].sort();
    const shown = paths.slice(0, MAX_LISTED_UNSCANNED).join(", ");
    const more = paths.length - MAX_LISTED_UNSCANNED;
    reasons.push({
      code: "UNSCANNED_ARTIFACT",
      message: `The public-safety scan cannot read ${plural(paths.length, "file")} as text that ${paths.length === 1 ? "is not a stream screenshot under screenshots/ or a registered recording" : "are not stream screenshots under screenshots/ or registered recordings"}: ${shown}${more > 0 ? ` and ${more} more` : ""}. Review them before sharing.`,
    });
  }
  // Runs from 0.110 keep raw sandbox ids only in sandbox-receipts.ndjson. An earlier run records
  // them in run.json, and any file that names one is not share-ready as it is.
  const rawResources = (args.bundle.providerResources ?? []).some(
    (resource) => resource.id !== REDACTED_SANDBOX_ID,
  );
  if (rawResources || args.sandboxIdFiles.length > 0) {
    const files = [
      ...new Set([...(rawResources ? [RUN_BUNDLE_FILE] : []), ...args.sandboxIdFiles]),
    ];
    reasons.push({
      code: "RAW_SANDBOX_ID",
      message: `Raw sandbox ids appear in ${files.sort().join(", ")}. Runs from 0.110 keep them only in sandbox-receipts.ndjson; \`humanish export --format bundle --redact-screenshots\` writes a copy without them.`,
    });
  }
  const rawStreamIds = rawScreenshotStreamIds(args.bundle, args.redactedShapeFrames);
  if (rawStreamIds.length > 0) {
    reasons.push({
      code: "RAW_SCREENSHOTS",
      message: `Full-fidelity screenshots, or frames with no redaction claim, are present on ${rawStreamIds.join(", ")}. This is valid local evidence, but not share-ready as-is.`,
    });
  }

  if (
    reasons.some(
      (reason) => reason.code === "VERIFY_FAILED" || reason.code === "PUBLIC_SAFETY_FINDINGS",
    )
  ) {
    return { status: "blocked", reasons };
  }

  if (reasons.length > 0) {
    return { status: "local_only", reasons };
  }

  return { status: "share_ready", reasons: [] };
}
