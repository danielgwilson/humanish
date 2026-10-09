import { personaBackgroundWarnings, plannedParticipants } from "./warnings.js";
import { resolveCommittedPersonasForCwd, studyPersonaIds } from "./persona-resolve.js";
import path from "node:path";
import type { AutomaticAnalysisBudget } from "../analysis/automatic-config.js";
import type { E2BDesktopModule } from "../substrates/e2b/sdk.js";
import { isLoopbackUrl } from "./parse/subject.js";
import { type StudyConfig } from "./types.js";
import { runPublicPreviewPreflight, runSandboxLoopbackPreflight } from "./preflight-probes.js";
import { digest, fail, finalize, STUDY_CHECK_SCHEMA } from "./preflight-result.js";
import { type StudyRoute, planStudy, routeOf } from "./plan.js";
import type { PlanRefusal } from "./plan-types.js";
import { resolveStudyManifest, type StudyResolveFailure } from "./discover.js";
import { participantList } from "./study-fields.js";
import { isLocalBrowserStudy } from "../substrates/local/runtime-config.js";
import { cli } from "../cli/invocation.js";

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
  /** `false` on a row the CLI could not check; its message names the command that checks it. */
  checked?: false;
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
      | "HUMANISH_STUDY_PREFLIGHT_TEARDOWN_FAILED"
      | PlanRefusal["code"];
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

  const participants = plannedParticipants(resolved.config);
  const personas =
    participants.length === 0
      ? new Map()
      : (await resolveCommittedPersonasForCwd(cwd, studyPersonaIds(resolved.config))).personas;
  const route = routeOf(resolved.config);
  const env = options.env ?? process.env;
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
    env,
    hooks: options.hooks ?? {},
    checks: [
      { name: "study file", ok: true, message: `resolved ${resolved.origin} study file` },
      { name: "route", ok: true, message: `selected the ${route} route` },
    ],
    targets: collectTargets(resolved.config),
    sandbox: { created: false },
    warnings: [
      ...resolved.warnings,
      ...personaBackgroundWarnings(resolved.config.id, participants, personas),
    ],
  };

  // The plan `humanish run <study>` makes before it creates anything: no run options, so the file's
  // mode decides dry or live, and the same environment for the sandbox ceiling. A study the run
  // would refuse fails here with the run's code, before any probe creates a sandbox.
  const planned = planStudy(resolved.config, { cwd, env });
  if (!planned.ok) {
    const { code, message } = planned.refusal;
    return fail(ctx, code, message, [{ name: "plan", ok: false, message }]);
  }

  const machine = machineCheck(ctx.config);
  // A local study's app and desktops run on this machine, so the hosted probes do not apply.
  if (reachability !== "metadata" && isLocalBrowserStudy(ctx.config))
    return finalize(ctx, {
      checks: [
        {
          name: "reachability",
          ok: true,
          checked: false,
          message: `${reachability} reachability does not apply to a local study: its app runs on this machine and its participant desktops in the local runtime, not in a hosted sandbox.`,
        },
        machine,
      ],
    });
  switch (reachability) {
    case "metadata":
      return finalize(ctx, {
        checks: [
          {
            name: "reachability",
            ok: true,
            message:
              "metadata-only; no network, sandbox, or model calls. Target reachability was not checked.",
          },
          machine,
        ],
      });
    case "public-preview":
      return await runPublicPreviewPreflight(ctx);
    case "sandbox-loopback":
      return await runSandboxLoopbackPreflight(ctx);
    case "prepared-host":
      return finalize(ctx, {
        checks: [
          {
            name: "reachability",
            ok: true,
            checked: false,
            message:
              "prepared-host reachability has no CLI check: it needs a library adapter hook for a host you prepare yourself. The study file was checked.",
          },
          machine,
        ],
      });
  }
}

/** What study check leaves to doctor: this machine's setup for the study, and the command. */
function machineCheck(config: StudyConfig): StudyPreflightCheck {
  const command = cli(`doctor --study ${config.id}`);
  return {
    name: "this machine",
    ok: true,
    checked: false,
    message: isLocalBrowserStudy(config)
      ? `The local runtime, the participant sign-in and whether this study's desktops fit were not checked. Run ${command} to check them.`
      : `Credentials, local login and dependencies were not checked. Run ${command} to check them.`,
  };
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
