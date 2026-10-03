// The preflight result a run returns, built from its context. preflight.ts and the probes in
// preflight-probes.ts both finish through these, so they live below both.

import { automaticAnalysisBudget } from "../analysis/automatic-config.js";
import { digestText } from "../evidence/redaction.js";
import type { StudyPreflightCheck, StudyPreflightResult, PreflightContext } from "./preflight.js";

/** The schema of `study check` results: whether a study is ready to run on this machine. */
export const STUDY_CHECK_SCHEMA = "humanish.study-check.v1";

export function finalize(
  ctx: PreflightContext,
  args?: { check?: StudyPreflightCheck },
): StudyPreflightResult {
  const checks = args?.check ? [...ctx.checks, args.check] : ctx.checks;
  const analysis = automaticAnalysisBudget(ctx.config.review?.analysis, ctx.route);
  return {
    schema: STUDY_CHECK_SCHEMA,
    ...(analysis ? { analysis } : {}),
    ok:
      checks.every((check) => check.ok) &&
      ctx.targets.every((target) => target.status !== "failed" && target.status !== "blocked"),
    cwd: ctx.cwd,
    study: ctx.study,
    studyId: ctx.studyId,
    origin: ctx.origin,
    path: ctx.path,
    route: ctx.route,
    reachability: ctx.reachability,
    checks,
    targets: ctx.targets,
    sandbox: ctx.sandbox,
    spend: {
      e2bDesktop: ctx.sandbox.created,
      model: false,
    },
    warnings: ctx.warnings,
  };
}

export function fail(
  ctx: PreflightContext,
  code: NonNullable<StudyPreflightResult["error"]>["code"],
  message: string,
  checks: StudyPreflightCheck[],
): StudyPreflightResult {
  return {
    ...finalize(ctx),
    ok: false,
    checks: [...ctx.checks, ...checks],
    error: { code, message },
  };
}

export function digest(value: string): string {
  return digestText(value, 16);
}
