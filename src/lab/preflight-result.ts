// The preflight result a run returns, built from its context. preflight.ts and the probes in
// preflight-probes.ts both finish through these, so they live below both.

import { backendOf } from "./plan.js";
import { automaticAnalysisBudget } from "../analysis/automatic-config.js";
import { digestText } from "../evidence/redaction.js";
import type { LabPreflightCheck, LabPreflightResult, PreflightContext } from "./preflight.js";

export const LAB_PREFLIGHT_SCHEMA = "humanish.lab-preflight-result.v1";

export function finalize(
  ctx: PreflightContext,
  args?: { check?: LabPreflightCheck },
): LabPreflightResult {
  const checks = args?.check ? [...ctx.checks, args.check] : ctx.checks;
  const analysis = automaticAnalysisBudget(ctx.config.review?.analysis, ctx.route);
  return {
    schema: LAB_PREFLIGHT_SCHEMA,
    ...(analysis ? { analysis } : {}),
    ok:
      checks.every((check) => check.ok) &&
      ctx.targets.every((target) => target.status !== "failed" && target.status !== "blocked"),
    cwd: ctx.cwd,
    lab: ctx.lab,
    labId: ctx.labId,
    origin: ctx.origin,
    path: ctx.path,
    backend: backendOf(ctx.route),
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
  code: NonNullable<LabPreflightResult["error"]>["code"],
  message: string,
  checks: LabPreflightCheck[],
): LabPreflightResult {
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
