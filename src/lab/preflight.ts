import path from "node:path";
import type { AutomaticAnalysisBudget } from "../analysis/automatic-config.js";
import type { E2BDesktopModule } from "../substrates/e2b/sdk.js";
import { isLoopbackUrl } from "./parse/subject.js";
import { type LabConfig } from "./types.js";
import { runPublicPreviewPreflight, runSandboxLoopbackPreflight } from "./preflight-probes.js";
import { digest, fail, finalize, LAB_PREFLIGHT_SCHEMA } from "./preflight-result.js";
import { type LabRoute, routeOf } from "./plan.js";
import { resolveLabManifest, type LabResolveFailure } from "./discover.js";
import { rosterOf } from "./parse/actors.js";

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 30_000;

export type LabPreflightReachabilityMode =
  | "metadata"
  | "public-preview"
  | "sandbox-loopback"
  | "prepared-host";

export interface LabPreflightCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface LabPreflightTarget {
  label: string;
  kind:
    | "subject.appUrl"
    | "actors[0].lanes[].target"
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

interface LabPreflightSandbox {
  created: boolean;
  killed?: boolean;
  /** The probe's server-side timeout, after which the provider kills it. */
  timeoutMs?: number;
  sandboxIdDigest?: string;
  template?: string;
}

interface LabPreflightSpend {
  e2bDesktop: boolean;
  model: false;
}

export interface LabPreflightResult {
  /** The separate budget for a future live run, never spend by preflight itself. */
  analysis?: AutomaticAnalysisBudget;
  schema: typeof LAB_PREFLIGHT_SCHEMA;
  ok: boolean;
  cwd: string;
  lab: string;
  labId?: string;
  origin?: string;
  path?: string;
  route?: LabRoute;
  reachability: LabPreflightReachabilityMode;
  checks: LabPreflightCheck[];
  targets: LabPreflightTarget[];
  sandbox: LabPreflightSandbox;
  spend: LabPreflightSpend;
  warnings: string[];
  error?: {
    code:
      | LabResolveFailure["error"]["code"]
      | "HUMANISH_LAB_PREFLIGHT_INVALID_OPTION"
      | "HUMANISH_LAB_PREFLIGHT_UNSUPPORTED_ROUTE"
      | "HUMANISH_LAB_PREFLIGHT_TARGET_POLICY"
      | "HUMANISH_LAB_PREFLIGHT_ENV_MISSING"
      | "HUMANISH_LAB_PREFLIGHT_E2B_REQUIRED"
      | "HUMANISH_LAB_PREFLIGHT_TARGET_UNREACHABLE"
      | "HUMANISH_LAB_PREFLIGHT_PROVISION_FAILED"
      | "HUMANISH_LAB_PREFLIGHT_TEARDOWN_FAILED";
    message: string;
  };
}

interface LabPreflightHooks {
  loadDesktopModule?: () => Promise<E2BDesktopModule>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunLabPreflightOptions {
  cwd: string;
  lab: string;
  reachability?: LabPreflightReachabilityMode;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  hooks?: LabPreflightHooks;
}

/** A preflight run's state; the probes in preflight-probes.ts read and extend it. */
export interface PreflightContext {
  cwd: string;
  lab: string;
  labId: string;
  origin: string;
  path: string;
  config: LabConfig;
  route: LabRoute;
  reachability: LabPreflightReachabilityMode;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  hooks: LabPreflightHooks;
  checks: LabPreflightCheck[];
  targets: LabPreflightTarget[];
  sandbox: LabPreflightSandbox;
  warnings: string[];
}

export async function runLabPreflight(
  options: RunLabPreflightOptions,
): Promise<LabPreflightResult> {
  const cwd = path.resolve(options.cwd);
  const reachability = options.reachability ?? "metadata";
  const timeoutMs = options.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
  const resolved = await resolveLabManifest(cwd, options.lab);

  if (!resolved.ok) {
    return {
      schema: LAB_PREFLIGHT_SCHEMA,
      ok: false,
      cwd,
      lab: options.lab,
      reachability,
      checks: [
        {
          name: "lab manifest",
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

  const route = routeOf(resolved.config);
  const ctx: PreflightContext = {
    cwd,
    lab: options.lab,
    labId: resolved.config.id,
    origin: resolved.origin,
    path: resolved.path,
    config: resolved.config,
    route,
    reachability,
    timeoutMs,
    env: options.env ?? process.env,
    hooks: options.hooks ?? {},
    checks: [
      { name: "lab manifest", ok: true, message: `resolved ${resolved.origin} lab manifest` },
      { name: "route", ok: true, message: `selected the ${route} route` },
    ],
    targets: collectTargets(resolved.config),
    sandbox: { created: false },
    warnings: resolved.warnings,
  };

  switch (reachability) {
    case "metadata":
      return finalize(ctx, {
        check: {
          name: "reachability",
          ok: true,
          message:
            "metadata-only; no network, sandbox, or model calls. Credentials, local login, dependencies and target reachability were not checked; use humanish doctor --lab <lab> for setup checks.",
        },
      });
    case "public-preview":
      return await runPublicPreviewPreflight(ctx);
    case "sandbox-loopback":
      return await runSandboxLoopbackPreflight(ctx);
    case "prepared-host":
      return fail(
        ctx,
        "HUMANISH_LAB_PREFLIGHT_UNSUPPORTED_ROUTE",
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

function collectTargets(config: LabConfig): LabPreflightTarget[] {
  const targets: LabPreflightTarget[] = [];
  if (config.subject.appUrl) {
    targets.push(makeTarget("subject.appUrl", "subject.appUrl", config.subject.appUrl));
  }
  for (const [index, entry] of (rosterOf(config.actors[0]) ?? []).entries()) {
    if (entry.target) {
      targets.push(
        makeTarget(`actors[0].lanes[${index}].target`, "actors[0].lanes[].target", entry.target),
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
  label: LabPreflightTarget["label"],
  kind: LabPreflightTarget["kind"],
  url: string,
): LabPreflightTarget {
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
