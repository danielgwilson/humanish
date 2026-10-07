import { personaBackgroundWarnings } from "./warnings.js";
import { resolveCommittedPersonasForCwd, studyPersonaIds } from "./persona-resolve.js";
import path from "node:path";
import type { AutomaticAnalysisBudget } from "../analysis/automatic-config.js";
import type { E2BDesktopModule } from "../substrates/e2b/sdk.js";
import { isLoopbackUrl } from "./parse/subject.js";
import { type StudyConfig } from "./types.js";
import { runPublicPreviewPreflight, runSandboxLoopbackPreflight } from "./preflight-probes.js";
import { digest, fail, finalize, STUDY_CHECK_SCHEMA } from "./preflight-result.js";
import { type StudyRoute, routeOf } from "./plan.js";
import { resolveStudyManifest, type StudyResolveFailure } from "./discover.js";
import { participantList } from "./study-fields.js";

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 30_000;

export type StudyPreflightReachabilityMode =
  | "metadata"
  | "public-preview"
  | "sandbox-loopback"
  | "prepared-host";

export interface StudyPreflightCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface StudyPreflightTarget {
  label: string;
  kind:
    | "subject.appUrl"
    | "participants[].target"
    | "subject.serve.url"
    | "subject.product.publicSurface";
  targetDigest: string;
  originDigest?: string;
  loopback: boolean;
  checked: boolean;
  reachable?: boolean;
  status: "not_checked" | "passed" | "failed" | "blocked";
  statusCode?: number;
  errorCode?: "HUMANISH_PREFLIGHT_TARGET_BLOCKED" | "HUMANISH_PREFLIGHT_TARGET_UNREACHABLE";
  message: string;
}

interface StudyPreflightSandbox {
  created: boolean;
  killed?: boolean;
  /** The probe's server-side timeout, after which the provider kills it. */
  timeoutMs?: number;
  sandboxIdDigest?: string;
  template?: string;
}

interface StudyPreflightSpend {
  e2bDesktop: boolean;
  model: false;
}

export interface StudyPreflightResult {
  /** The separate budget for a future live run, never spend by preflight itself. */
  analysis?: AutomaticAnalysisBudget;
  schema: typeof STUDY_CHECK_SCHEMA;
  ok: boolean;
  cwd: string;
  /** The study the caller asked for, as given. */
  study: string;
  /** The resolved study's `id`, once the file parses. */
  studyId?: string;
  origin?: string;
  path?: string;
  route?: StudyRoute;
  reachability: StudyPreflightReachabilityMode;
  checks: StudyPreflightCheck[];
  targets: StudyPreflightTarget[];
  sandbox: StudyPreflightSandbox;
  spend: StudyPreflightSpend;
  warnings: string[];
  error?: {
    code:
      | StudyResolveFailure["error"]["code"]
      | "HUMANISH_STUDY_PREFLIGHT_INVALID_OPTION"
      | "HUMANISH_STUDY_PREFLIGHT_UNSUPPORTED_ROUTE"
      | "HUMANISH_STUDY_PREFLIGHT_TARGET_POLICY"
      | "HUMANISH_STUDY_PREFLIGHT_ENV_MISSING"
      | "HUMANISH_STUDY_PREFLIGHT_E2B_REQUIRED"
      | "HUMANISH_STUDY_PREFLIGHT_TARGET_UNREACHABLE"
      | "HUMANISH_STUDY_PREFLIGHT_PROVISION_FAILED"
      | "HUMANISH_STUDY_PREFLIGHT_TEARDOWN_FAILED";
    message: string;
  };
}

interface StudyPreflightHooks {
  loadDesktopModule?: () => Promise<E2BDesktopModule>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunStudyPreflightOptions {
  cwd: string;
  study: string;
  reachability?: StudyPreflightReachabilityMode;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  hooks?: StudyPreflightHooks;
}

/** A preflight run's state; the probes in preflight-probes.ts read and extend it. */
export interface PreflightContext {
  cwd: string;
  study: string;
  studyId: string;
  origin: string;
  path: string;
  config: StudyConfig;
  route: StudyRoute;
  reachability: StudyPreflightReachabilityMode;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  hooks: StudyPreflightHooks;
  checks: StudyPreflightCheck[];
  targets: StudyPreflightTarget[];
  sandbox: StudyPreflightSandbox;
  warnings: string[];
}

export async function runStudyPreflight(
  options: RunStudyPreflightOptions,
): Promise<StudyPreflightResult> {
  const cwd = path.resolve(options.cwd);
  const reachability = options.reachability ?? "metadata";
  const timeoutMs = options.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
  const resolved = await resolveStudyManifest(cwd, options.study);

  if (!resolved.ok) {
    return {
      schema: STUDY_CHECK_SCHEMA,
      ok: false,
      cwd,
      study: options.study,
      reachability,
      checks: [
        {
          name: "study file",
          ok: false,
          message: resolved.error.message,
        },
      ],
      targets: [],
      sandbox: { created: false },
      spend: { e2bDesktop: false, model: false },
      warnings: resolved.warnings,
      error: resolved.error,
    };
  }

  const personas =
    resolved.config.route === "computer-use" || resolved.config.route === "shared-world"
      ? (await resolveCommittedPersonasForCwd(cwd, studyPersonaIds(resolved.config))).personas
      : new Map();
  const route = routeOf(resolved.config);
  const ctx: PreflightContext = {
    cwd,
    study: options.study,
    studyId: resolved.config.id,
    origin: resolved.origin,
    path: resolved.path,
    config: resolved.config,
    route,
    reachability,
    timeoutMs,
    env: options.env ?? process.env,
    hooks: options.hooks ?? {},
    checks: [
      { name: "study file", ok: true, message: `resolved ${resolved.origin} study file` },
      { name: "route", ok: true, message: `selected the ${route} route` },
    ],
    targets: collectTargets(resolved.config),
    sandbox: { created: false },
    warnings: [...resolved.warnings, ...personaBackgroundWarnings(resolved.config, personas)],
  };

  switch (reachability) {
    case "metadata":
      return finalize(ctx, {
        check: {
          name: "reachability",
          ok: true,
          message:
            "metadata-only; no network, sandbox, or model calls. Credentials, local login, dependencies and target reachability were not checked; use humanish doctor --study <study> for setup checks.",
        },
      });
    case "public-preview":
      return await runPublicPreviewPreflight(ctx);
    case "sandbox-loopback":
      return await runSandboxLoopbackPreflight(ctx);
    case "prepared-host":
      return fail(
        ctx,
        "HUMANISH_STUDY_PREFLIGHT_UNSUPPORTED_ROUTE",
        "prepared-host preflight requires a library adapter hook; the plain CLI can validate metadata only for this mode.",
        [
          {
            name: "prepared-host",
            ok: false,
            message: "no generic CLI hook exists for adopter-prepared hosts yet",
          },
        ],
      );
  }
}

function collectTargets(config: StudyConfig): StudyPreflightTarget[] {
  const targets: StudyPreflightTarget[] = [];
  if (config.subject.appUrl) {
    targets.push(makeTarget("subject.appUrl", "subject.appUrl", config.subject.appUrl));
  }
  for (const [index, entry] of (participantList(config) ?? []).entries()) {
    if (entry.target) {
      targets.push(
        makeTarget(`participants[${index}].target`, "participants[].target", entry.target),
      );
    }
  }
  if (config.subject.serve?.url) {
    targets.push(makeTarget("subject.serve.url", "subject.serve.url", config.subject.serve.url));
  }
  for (const [index, surface] of (config.subject.product?.publicSurfaces ?? []).entries()) {
    targets.push(
      makeTarget(
        `subject.product.publicSurfaces[${index}]`,
        "subject.product.publicSurface",
        surface,
      ),
    );
  }
  return targets;
}

function makeTarget(
  label: StudyPreflightTarget["label"],
  kind: StudyPreflightTarget["kind"],
  url: string,
): StudyPreflightTarget {
  return {
    label,
    kind,
    targetDigest: digest(url),
    ...originDigest(url),
    loopback: isLoopbackUrl(url),
    checked: false,
    status: "not_checked",
    message: "target declared; reachability not checked",
  };
}

function originDigest(value: string): { originDigest?: string } {
  try {
    return { originDigest: digest(new URL(value).origin) };
  } catch {
    return {};
  }
}
