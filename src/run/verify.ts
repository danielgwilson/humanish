import { contradictsAccountBilling } from "./pricing.js";
import path from "node:path";
import { validActorExecutionProfile, validActorProviderRequests } from "../actors/contract.js";
import { round6 } from "./pricing.js";
import { listStudyAnalysisExecutions } from "../analysis/store.js";
import { loadStudyAnalysis } from "../analysis/load.js";
import { studyAnalysisSharingProblems } from "../analysis/sharing.js";
import { validatePreparedRunArtifactPaths, type PreparedRunArtifactPaths } from "./paths.js";
import { RUN_BUNDLE_SCHEMA, type RunBundle } from "./bundle.js";
import { COMMAND_DIGEST_PATTERN, SUBJECT_ENV_NAME_PATTERN } from "./guards-shared-world.js";
import { ARCHIVE_SHA256_PATTERN, isCleanupResult, isRunBundle } from "./guards.js";
import { readRunJsonIfExists, readRunTextIfExists, resolveRunPath } from "./locate.js";
import { isRecord } from "./primitives.js";
import {
  actorVerdictConsistencyFindings,
  noEngagementActorFindings,
  validateCodexAppServerEvidence,
  validateTerminalProductEvidence,
} from "./verify-actor.js";
import {
  containsSensitivePattern,
  invalidRunEvidenceReferences,
  missingLocalEvidenceArtifacts,
  rawScreenshotPostureWarnings,
  rawScreenshotStreamIds,
  scanRunPublicSafetyArtifacts,
} from "./verify-artifacts.js";
import {
  sharedWorldEvidenceFindings,
  undeclaredSubjectStateWarnings,
} from "./verify-shared-world.js";

export const VERIFY_SCHEMA = "humanish.verify-result.v1";

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
        | "CONTINUOUS_MEDIA"
        | "REAL_COMMUNICATIONS";
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
  return verifyPreparedRun(cwd, runInput, runPaths);
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

export async function verifyPreparedRun(
  cwd: string,
  runInput: string,
  runPaths: PreparedRunArtifactPaths | null,
): Promise<VerifyResult> {
  const checks: VerifyResult["checks"] = [];

  if (!runPaths) {
    return {
      schema: VERIFY_SCHEMA,
      ok: false,
      cwd,
      run: runInput,
      checks,
      shareSafety: {
        status: "blocked",
        reasons: [
          {
            code: "VERIFY_FAILED",
            message: `Run not found: ${runInput}`,
          },
        ],
      },
      warnings: [],
      error: {
        code: "HUMANISH_RUN_NOT_FOUND",
        message: `Run not found: ${runInput}`,
      },
    };
  }

  const bundlePath = path.join(runPaths.absoluteRunRoot, "run.json");
  const bundle = await readRunJsonIfExists(runPaths, "run.json");
  const cleanupJson = await readRunJsonIfExists(runPaths, "cleanup.json");
  const reviewJson = await readRunJsonIfExists(runPaths, "review.json");
  const reviewMarkdown = await readRunTextIfExists(runPaths, "review.md");

  checks.push({
    name: "run.json exists",
    ok: bundle !== null,
    message: bundle === null ? "run.json missing" : "run.json present",
  });
  checks.push({
    name: "run schema",
    ok: isRecord(bundle) && bundle.schema === RUN_BUNDLE_SCHEMA,
    message: "run bundle schema is humanish.run-bundle.v1",
  });
  checks.push({
    name: "run bundle shape",
    ok: isRunBundle(bundle),
    message:
      "run bundle must include source, persona, scenario, lifecycle, simulations, streams, events, artifacts, review, and feedback candidates",
  });
  checks.push({
    name: "redaction passed",
    ok: isRecord(bundle) && isRecord(bundle.redaction) && bundle.redaction.status === "passed",
    message: "redaction status must be passed",
  });
  checks.push({
    name: "review artifacts exist",
    ok: reviewJson !== null && reviewMarkdown !== null,
    message: "review.json and review.md must exist",
  });
  const derivedPublicSafetyFindings: string[] = [];
  const publicSafetyFindings = await scanRunPublicSafetyArtifacts(
    runPaths,
    derivedPublicSafetyFindings,
    new Set(
      isRunBundle(bundle)
        ? bundle.streams.flatMap((stream) => (stream.recording ? [stream.recording.path] : []))
        : [],
    ),
  );
  // JSON escapes can hide a sensitive value from the byte scan while the
  // decoded recording exposes it to Observer, feedback, or analysis input.
  if (
    publicSafetyFindings.length < 50 &&
    bundle !== null &&
    containsSensitivePattern(JSON.stringify(bundle))
  ) {
    publicSafetyFindings.push("sensitive decoded run.json");
  }
  checks.push({
    name: "public-safety scan",
    ok: publicSafetyFindings.length === 0,
    message:
      publicSafetyFindings.length === 0
        ? "run text artifacts and public-proof paths must not match known secret or browser-profile patterns"
        : `public-safety findings: ${publicSafetyFindings.slice(0, 5).join(", ")}`,
  });
  const missingEvidenceArtifacts = isRunBundle(bundle)
    ? await missingLocalEvidenceArtifacts(runPaths, bundle)
    : [];
  const invalidEvidenceReferences = isRunBundle(bundle) ? invalidRunEvidenceReferences(bundle) : [];
  checks.push({
    name: "local evidence artifacts exist",
    ok: missingEvidenceArtifacts.length === 0 && invalidEvidenceReferences.length === 0,
    message:
      missingEvidenceArtifacts.length === 0 && invalidEvidenceReferences.length === 0
        ? "referenced local screenshot/trace/log/filesystem artifacts are present"
        : invalidEvidenceReferences.length > 0
          ? `invalid evidence artifact references: ${invalidEvidenceReferences.join(", ")}`
          : `missing local evidence artifacts: ${missingEvidenceArtifacts.join(", ")}`,
  });
  const terminalProductFindings = isRunBundle(bundle)
    ? await validateTerminalProductEvidence(runPaths, bundle)
    : [];
  checks.push({
    name: "terminal-product evidence",
    ok: terminalProductFindings.length === 0,
    message:
      terminalProductFindings.length === 0
        ? "live terminal-product streams either are absent or carry the substrate/cleanup/interventions/cost ledgers + a ledger-derived no-spend proof + redacted terminal evidence, with proven teardown and known spend within the declared cap"
        : `terminal-product findings: ${terminalProductFindings.join(", ")}`,
  });
  const codexAppServerFindings = isRunBundle(bundle)
    ? await validateCodexAppServerEvidence(runPaths, bundle)
    : [];
  checks.push({
    name: "codex app-server evidence",
    ok: codexAppServerFindings.length === 0,
    message:
      codexAppServerFindings.length === 0
        ? "live Codex app-server streams either are absent or include valid redacted trace evidence"
        : `codex app-server findings: ${codexAppServerFindings.join(", ")}`,
  });
  const noEngagementFindings = isRunBundle(bundle) ? noEngagementActorFindings(bundle) : [];
  checks.push({
    name: "actor engagement",
    ok: noEngagementFindings.length === 0,
    message:
      noEngagementFindings.length === 0
        ? "live actor traces that claim goal_satisfied carry at least one action or message"
        : `no-engagement findings: ${noEngagementFindings.join(", ")} — a hollow run is not credible evidence`,
  });
  const actorVerdictFindings = isRunBundle(bundle) ? actorVerdictConsistencyFindings(bundle) : [];
  checks.push({
    name: "actor verdict consistency",
    ok: actorVerdictFindings.length === 0,
    message:
      actorVerdictFindings.length === 0
        ? "live pass verdicts do not hide failed, blocked, or timed-out actor traces"
        : `actor verdict findings: ${actorVerdictFindings.join(", ")}`,
  });
  const stateFindings = isRunBundle(bundle) ? subjectStateFindings(bundle) : [];
  checks.push({
    name: "subject state provenance",
    ok: stateFindings.length === 0,
    message:
      stateFindings.length === 0
        ? "subject state claims match the recorded seed/external evidence (or the subject block is honestly absent)"
        : `subject state findings: ${stateFindings.join(", ")}`,
  });
  const sharedWorldFindings = isRunBundle(bundle) ? sharedWorldEvidenceFindings(bundle) : [];
  checks.push({
    name: "shared-world evidence",
    ok: sharedWorldFindings.length === 0,
    message:
      sharedWorldFindings.length === 0
        ? "live shared-world runs either are absent or carry a well-formed alternating timeline (cp-baseline → turn → cp), single-plane provenance, digest-only checkpoints, the mandatory attributionLimits, and a checkpoint delta on a passed run"
        : `shared-world findings: ${sharedWorldFindings.join(", ")}`,
  });
  checks.push({
    name: "cleanup receipt",
    ok: cleanupJson === null || (isCleanupResult(cleanupJson) && cleanupJson.ok),
    message:
      cleanupJson === null
        ? "cleanup receipt not present; cleanup was not requested"
        : isCleanupResult(cleanupJson) && cleanupJson.ok
          ? "cleanup receipt is present and successful"
          : "cleanup receipt is present but malformed or failed",
  });
  const rerunFindings = isRunBundle(bundle) ? rerunLineageFindings(bundle) : [];
  checks.push({
    name: "rerun lineage",
    ok: rerunFindings.length === 0,
    message:
      rerunFindings.length === 0
        ? "rerun bundles either are absent or link selected lanes to prior lane status and a fan-out rerun event"
        : `rerun lineage findings: ${rerunFindings.join(", ")}`,
  });
  // Cost is ADVISORY on magnitude, FAIL-CLOSED on labeling/provenance (claims match mechanism).
  // Absence PASSES (fail-open on display); a claimed dollar figure without its ratesAsOf date +
  // source, or a total that does not match its known lines, FAILS. Magnitude is never inspected —
  // a correctly-labeled huge estimate still passes.
  const costFindings = isRunBundle(bundle) ? costLabelingFindings(bundle) : [];
  checks.push({
    name: "cost estimate labeling",
    ok: costFindings.length === 0,
    message:
      costFindings.length === 0
        ? "cost figures are absent, or every claimed estimate carries its ratesAsOf date + source and the total matches its known lines (estimates never presented as exact)"
        : `cost labeling findings: ${costFindings.join(", ")}`,
  });

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
        ...rawScreenshotPostureWarnings(bundle),
        ...undeclaredSubjectStateWarnings(bundle),
        ...desktopGeometryWarnings(bundle),
      ]
    : [];
  const shareSafety = isRunBundle(bundle)
    ? buildShareSafety({ ok, bundle, publicSafetyFindings })
    : {
        status: "blocked" as const,
        reasons: [
          {
            code: "VERIFY_FAILED" as const,
            message: "Run bundle failed verification.",
          },
        ],
      };

  // Interpretation validity is independent of run validity. Keep recordings usable,
  // while refusing to silently promote stale or malformed derived text into sharing.
  const analysis = await loadStudyAnalysis(runPaths);
  const analysisSharing = studyAnalysisSharingProblems(analysis);
  const executionHistory = await listStudyAnalysisExecutions(runPaths);
  if (
    analysisSharing.unverified ||
    analysisSharing.sensitive ||
    executionHistory.warnings.length > 0
  ) {
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

export async function loadRunBundle(
  cwdInput: string,
  runInput: string,
): Promise<{ bundle: RunBundle; bundlePath: string; runDir: string } | null> {
  const cwd = path.resolve(cwdInput);
  const runPaths = await resolveRunPath(cwd, runInput).catch(() => null);

  if (!runPaths) {
    return null;
  }

  return loadRunBundlePrepared(cwd, runPaths);
}

/** Internal continuity seam for callers that already bound one run identity. */
export async function loadRunBundlePrepared(
  cwdInput: string,
  runPaths: PreparedRunArtifactPaths,
): Promise<{ bundle: RunBundle; bundlePath: string; runDir: string } | null> {
  const cwd = path.resolve(cwdInput);
  await validatePreparedRunArtifactPaths(runPaths);
  const bundlePath = path.join(runPaths.absoluteRunRoot, "run.json");
  const bundle = await readRunJsonIfExists(runPaths, "run.json");

  if (!isRunBundle(bundle)) {
    return null;
  }

  return {
    bundle,
    bundlePath: path.relative(cwd, bundlePath),
    runDir: runPaths.absoluteRunRoot,
  };
}

/** Internal continuity seam for callers that already bound one run identity. */
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
  return verifyPreparedRun(cwd, runInput, runPaths);
}

/** Non-fatal hosted-desktop geometry disclosures, deduplicated across shared-screen streams. */
function desktopGeometryWarnings(bundle: RunBundle): string[] {
  return [...new Set(bundle.streams.flatMap((stream) => stream.desktopGeometry?.warnings ?? []))];
}

function buildShareSafety(args: {
  ok: boolean;
  bundle: RunBundle;
  publicSafetyFindings: string[];
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
  const rawStreamIds = rawScreenshotStreamIds(args.bundle);
  if (rawStreamIds.length > 0) {
    reasons.push({
      code: "RAW_SCREENSHOTS",
      message: `Full-fidelity screenshots are present on ${rawStreamIds.join(", ")}. This is valid local evidence, but not share-ready as-is.`,
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

/**
 * The `subject state provenance` check (invariant 5 + invariant 4): a bundle's subject CLAIM
 * must match its recorded evidence. Bundles without a subject block (all pre-existing and
 * non-cua bundles) pass untouched. Live-vs-dry-run is judged from bundle.mode, exactly like
 * noEngagementActorFindings. Covers both the state story (seed/external) and, for the
 * local-tree route, the archive content pin.
 */
function subjectStateFindings(bundle: RunBundle): string[] {
  const subject = bundle.subject;
  if (subject === undefined) {
    return [];
  }

  const findings: string[] = [];
  const state = subject.state;
  const seed = state.seed ?? [];
  const live = bundle.mode === "live";

  // Local-tree fail-closed pin: a LIVE local-tree subject must carry a well-formed archive
  // digest -- a dirty tree cannot be commit-pinned, so archiveSha256 is the only content pin
  // this route has. Mirrors the seeded-on-dry-run discriminator immediately below: judged by
  // bundle.mode, never by the presence/shape of other fields. Never echoes the malformed value
  // (it could itself be a leaked value, same discipline as the externalEnvNames check below).
  if (live && subject.source === "local-tree") {
    // Note: a malformed-but-present string is already rejected upstream by the
    // isRunSubjectProvenance shape gate, so in practice this branch fires for the
    // MISSING case; the pattern re-check stays as defense in depth for callers
    // that bypass the schema gate.
    const pin = (subject as { archiveSha256?: unknown }).archiveSha256;
    if (typeof pin !== "string" || !ARCHIVE_SHA256_PATTERN.test(pin)) {
      findings.push(
        "subject.source is local-tree on a live run but archiveSha256 is missing or malformed (a local-tree subject must carry a well-formed 64-hex archive digest)",
      );
    }
  }

  // Marker-independent rule: a passed LIVE run can never ride on a seed step that did not
  // complete ok (closes the hollow-seeded × unpinned hole — an unpinned bundle still carries
  // its seed records, and a failed migration must not hide behind the external marker).
  if (live && bundle.review.verdict === "pass" && seed.some((record) => record.ok !== true)) {
    findings.push(
      "review verdict is pass but a recorded seed step did not complete ok — a passed live run cannot carry failed or unexecuted state steps",
    );
  }

  switch (state.provenance) {
    case "seeded": {
      if (!live) {
        findings.push(
          'state marker "seeded" on a dry-run bundle — a contract bundle cannot claim executed state',
        );
      }
      if (seed.length === 0) {
        findings.push('state marker "seeded" with zero seed step records is a hollow state claim');
      }
      for (const record of seed) {
        if (!COMMAND_DIGEST_PATTERN.test(record.commandDigest)) {
          findings.push(`seed step "${record.name}" lacks a sha256-16 commandDigest`);
        }
        if (live && record.ok !== true) {
          findings.push(`state marker "seeded" but step "${record.name}" did not complete ok`);
        }
      }
      break;
    }
    case "unpinned": {
      const externalEnvNames = state.externalEnvNames ?? [];
      if (externalEnvNames.length === 0) {
        findings.push(
          'state marker "unpinned" requires non-empty externalEnvNames (the declaration must name the external channel)',
        );
      }
      for (const name of externalEnvNames) {
        if (!SUBJECT_ENV_NAME_PATTERN.test(name)) {
          // Deliberately does NOT echo the entry: a malformed entry may BE a value.
          findings.push(
            "externalEnvNames carries an entry that is not an env var NAME shape (values must never appear in evidence)",
          );
        }
      }
      break;
    }
    case "declared-not-run": {
      if (live && bundle.review.verdict === "pass") {
        findings.push(
          'a passed live run cannot claim its declared seed steps did not run (state marker "declared-not-run")',
        );
      }
      break;
    }
    case "undeclared":
      break;
    case "external-public": {
      // #164 phase 2: an operator-declared, operator-owned public deployment humanish neither
      // provisioned nor seeded. There is no in-sandbox state story — a seed record or an external
      // channel here would contradict the "no subject sandbox" invariant of this plane class.
      if (subject.source !== "app-url") {
        findings.push(
          'state marker "external-public" requires subject.source "app-url" — the external-public plane is a real public deployment, not a clone/local-tree subject',
        );
      }
      if (seed.length > 0) {
        findings.push(
          'state marker "external-public" cannot carry seed step records — the external-public plane is neither provisioned nor seeded by the harness',
        );
      }
      if ((state.externalEnvNames ?? []).length > 0) {
        findings.push(
          'state marker "external-public" cannot carry externalEnvNames — the plane is operator-owned, not an uncontrolled external channel',
        );
      }
      break;
    }
    default:
      findings.push("unknown subject state provenance marker");
  }

  return findings;
}

function rerunLineageFindings(bundle: RunBundle): string[] {
  const rerun = bundle.rerun;
  if (!rerun) {
    return [];
  }

  const findings: string[] = [];
  const selectedLaneIds = rerun.selectedLaneIds;
  const selectedSet = new Set(selectedLaneIds);
  const previousLaneIds = rerun.previous.map((entry) => entry.laneId);
  const previousSet = new Set(previousLaneIds);
  const currentLaneIds = bundle.streams.map((stream) => stream.laneId);
  const currentConcreteLaneIds = currentLaneIds.filter(
    (laneId): laneId is string => typeof laneId === "string" && laneId.trim().length > 0,
  );
  const currentSet = new Set(currentConcreteLaneIds);

  if (selectedSet.size !== selectedLaneIds.length) {
    findings.push("selectedLaneIds contains duplicate lane ids");
  }
  if (previousSet.size !== previousLaneIds.length) {
    findings.push("previous contains duplicate lane ids");
  }
  if (currentConcreteLaneIds.length !== bundle.streams.length) {
    findings.push("every rerun stream must carry a laneId");
  }
  for (const laneId of selectedLaneIds) {
    if (!previousSet.has(laneId)) {
      findings.push(`selected lane ${laneId} is missing prior status`);
    }
    if (!currentSet.has(laneId)) {
      findings.push(`selected lane ${laneId} is missing from current streams`);
    }
  }
  for (const laneId of previousLaneIds) {
    if (!selectedSet.has(laneId)) {
      findings.push(`previous lane ${laneId} was not selected`);
    }
  }
  for (const laneId of currentConcreteLaneIds) {
    if (!selectedSet.has(laneId)) {
      findings.push(`current stream lane ${laneId} was not selected`);
    }
  }
  if (!bundle.events.some((event) => event.type === "cua-lab.fanout.rerun")) {
    findings.push("missing cua-lab.fanout.rerun event");
  }

  return findings;
}

/**
 * Verify the LABELING/provenance of any cost figure a bundle CLAIMS — never its magnitude. Returns
 * [] (pass) unless a dollar claim lacks its provenance (invariant 6) or a total misreports its
 * known lines. ABSENCE always passes (fail-open on display, discipline #3): a bundle with no cost,
 * a null estimate, or a lane without estimatedCost is fine. A NON-NULL figure must carry its
 * ratesAsOf date + source; a NUMBER total must equal round6(sum of ONLY the non-null lines) and a
 * null line may never be coerced to 0. A null estimate must be declared honestly (a reason + null
 * ratesAsOf), mirroring the terminal no-spend proof's null-discipline.
 */
function costLabelingFindings(bundle: RunBundle): string[] {
  const findings: string[] = [];
  if (contradictsAccountBilling(bundle.streams, bundle.cost))
    findings.push("Run cost lines contradict account billing identity");

  const cost = bundle.cost;
  if (cost) {
    if (cost.schema !== "humanish.run-cost-summary.v1") {
      findings.push(
        `run cost summary schema is ${String(cost.schema)}, expected humanish.run-cost-summary.v1`,
      );
    }
    let knownSum = 0;
    let anyKnown = false;
    for (const [index, line] of (cost.breakdown ?? []).entries()) {
      if (line.estimatedCostUsd === null) {
        continue;
      }
      anyKnown = true;
      knownSum += line.estimatedCostUsd;
      if (typeof line.ratesAsOf !== "string" || line.ratesAsOf.length === 0) {
        findings.push(
          `cost breakdown line ${index} (${line.kind}) claims $${line.estimatedCostUsd} without a ratesAsOf date`,
        );
      }
      if (typeof line.source !== "string" || line.source.length === 0) {
        findings.push(
          `cost breakdown line ${index} (${line.kind}) claims $${line.estimatedCostUsd} without a pricing source`,
        );
      }
    }
    if (cost.estimatedTotalUsd !== null) {
      // A spend-free run's explicit zero prices nothing, so only a priced line needs a rates date.
      if (anyKnown && (typeof cost.ratesAsOf !== "string" || cost.ratesAsOf.length === 0)) {
        findings.push(
          "run cost summary claims a number estimatedTotalUsd without a ratesAsOf date",
        );
      }
      if (round6(cost.estimatedTotalUsd) !== round6(knownSum)) {
        findings.push(
          `run cost estimatedTotalUsd ${cost.estimatedTotalUsd} does not equal the sum of its known breakdown lines (${round6(knownSum)})`,
        );
      }
    } else if (anyKnown) {
      // Every-line-null is the only honest null total; a null total beside a known line hides spend.
      findings.push(
        "run cost estimatedTotalUsd is null but a breakdown line carries a known (non-null) cost",
      );
    }
  }

  for (const stream of bundle.streams) {
    for (const actor of [stream.actor, stream.liveActor]) {
      if (actor?.executionProfile !== undefined) {
        if (!validActorExecutionProfile(actor.executionProfile))
          findings.push("Invalid actor execution profile");
        if (!validActorProviderRequests(actor.providerRequests))
          findings.push("Invalid account participant request receipts");
        if (
          actor.historyTurnsOmitted !== undefined &&
          (!Number.isSafeInteger(actor.historyTurnsOmitted) || actor.historyTurnsOmitted < 0)
        )
          findings.push("Invalid participant history omission count");
        if (
          actor.executionProfile?.billing === "account-unknown" &&
          (typeof actor.estimatedCost?.estimatedCostUsd === "number" ||
            actor.tokenUsage?.costUsd !== undefined)
        )
          findings.push("Account participant dollars must remain unknown");
      }
    }
    const estimate = stream.actor?.estimatedCost;
    if (!estimate) {
      continue;
    }
    const laneLabel = stream.laneId ?? stream.id;
    if (estimate.schema !== "humanish.actor-estimated-cost.v1") {
      findings.push(
        `lane ${laneLabel} actor estimatedCost schema is ${String(estimate.schema)}, expected humanish.actor-estimated-cost.v1`,
      );
    }
    if (estimate.estimatedCostUsd !== null) {
      if (typeof estimate.ratesAsOf !== "string" || estimate.ratesAsOf.length === 0) {
        findings.push(
          `lane ${laneLabel} claims a model-token cost $${estimate.estimatedCostUsd} without a ratesAsOf date`,
        );
      }
      if (typeof estimate.source !== "string" || estimate.source.length === 0) {
        findings.push(
          `lane ${laneLabel} claims a model-token cost $${estimate.estimatedCostUsd} without a pricing source`,
        );
      }
    } else {
      // Declared-absent honesty (invariant 5): a null estimate must say WHY and carry null ratesAsOf.
      if (estimate.reason === undefined) {
        findings.push(`lane ${laneLabel} records a null cost estimate without a reason`);
      }
      if (estimate.ratesAsOf !== null) {
        findings.push(
          `lane ${laneLabel} records a null cost estimate but carries a non-null ratesAsOf`,
        );
      }
    }
  }

  return findings;
}
