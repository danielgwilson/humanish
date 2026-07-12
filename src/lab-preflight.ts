import path from "node:path";

import { CUA_ACTOR_LAB_PROVIDER_METADATA, provisionCloneSubject } from "./cua-actor-lab.js";
import { probeUrl } from "./e2b-detached.js";
import {
  createDesktopSandbox,
  loadE2BDesktopModule,
  type E2BDesktopModule,
  type E2BDesktopSandbox
} from "./e2b-desktop-launch.js";
import {
  isLoopbackUrl,
  type LabConfig
} from "./lab-config.js";
import { selectLabBackend, type LabBackend } from "./lab-engine.js";
import { resolveLabManifest, type LabResolveFailure } from "./labs.js";
import { digestText, redactText } from "./redaction.js";

export const LAB_PREFLIGHT_SCHEMA = "humanish.lab-preflight-result.v1";

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 30_000;
const DEFAULT_SANDBOX_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

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

export interface LabPreflightSandbox {
  created: boolean;
  killed?: boolean;
  sandboxIdDigest?: string;
  template?: string;
}

export interface LabPreflightSpend {
  e2bDesktop: boolean;
  model: false;
}

export interface LabPreflightResult {
  schema: typeof LAB_PREFLIGHT_SCHEMA;
  ok: boolean;
  cwd: string;
  lab: string;
  labId?: string;
  origin?: string;
  path?: string;
  backend?: LabBackend;
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

export interface LabPreflightHooks {
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

interface PreflightContext {
  cwd: string;
  lab: string;
  labId: string;
  origin: string;
  path: string;
  config: LabConfig;
  backend: LabBackend;
  reachability: LabPreflightReachabilityMode;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  hooks: LabPreflightHooks;
  checks: LabPreflightCheck[];
  targets: LabPreflightTarget[];
  sandbox: LabPreflightSandbox;
  warnings: string[];
}

export async function runLabPreflight(options: RunLabPreflightOptions): Promise<LabPreflightResult> {
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
      checks: [{
        name: "lab manifest",
        ok: false,
        message: resolved.error.message
      }],
      targets: [],
      sandbox: { created: false },
      spend: { e2bDesktop: false, model: false },
      warnings: resolved.warnings,
      error: resolved.error
    };
  }

  const backend = selectLabBackend(resolved.config);
  const ctx: PreflightContext = {
    cwd,
    lab: options.lab,
    labId: resolved.config.id,
    origin: resolved.origin,
    path: resolved.path,
    config: resolved.config,
    backend,
    reachability,
    timeoutMs,
    env: options.env ?? process.env,
    hooks: options.hooks ?? {},
    checks: [
      { name: "lab manifest", ok: true, message: `resolved ${resolved.origin} lab manifest` },
      { name: "backend", ok: true, message: `selected ${backend}` }
    ],
    targets: collectTargets(resolved.config),
    sandbox: { created: false },
    warnings: resolved.warnings
  };

  switch (reachability) {
    case "metadata":
      return finalize(ctx, {
        check: { name: "reachability", ok: true, message: "metadata-only; no network, sandbox, or model calls" }
      });
    case "public-preview":
      return await runPublicPreviewPreflight(ctx);
    case "sandbox-loopback":
      return await runSandboxLoopbackPreflight(ctx);
    case "prepared-host":
      return fail(ctx, "HUMANISH_LAB_PREFLIGHT_UNSUPPORTED_ROUTE", "prepared-host preflight requires a library adapter hook; the plain CLI can validate metadata only for this mode.", [
        { name: "prepared-host", ok: false, message: "no generic CLI hook exists for adopter-prepared hosts yet" }
      ]);
  }
}

async function runPublicPreviewPreflight(ctx: PreflightContext): Promise<LabPreflightResult> {
  const routeError = publicPreviewRouteError(ctx.config, ctx.backend);
  if (routeError) {
    return fail(ctx, "HUMANISH_LAB_PREFLIGHT_UNSUPPORTED_ROUTE", routeError, [
      { name: "route", ok: false, message: routeError }
    ]);
  }

  const laneTargets = ctx.targets.filter((target) => target.kind === "actors[0].lanes[].target");
  const publicTargets = laneTargets.length > 0
    ? laneTargets
    : ctx.targets.filter((target) => target.kind === "subject.appUrl");
  if (publicTargets.length === 0) {
    return fail(ctx, "HUMANISH_LAB_PREFLIGHT_TARGET_POLICY", "public-preview preflight needs at least one declared app-url target.", [
      { name: "targets", ok: false, message: "no app-url targets were declared" }
    ]);
  }

  const loopbackTarget = publicTargets.find((target) => target.loopback);
  if (loopbackTarget) {
    blockTarget(loopbackTarget, "public-preview requires externally reachable non-loopback targets.");
    return fail(ctx, "HUMANISH_LAB_PREFLIGHT_TARGET_POLICY", "public-preview reachability cannot prove loopback targets from a hosted desktop; use sandbox-loopback or a prepared public target.", [
      { name: "target policy", ok: false, message: "loopback target blocked before sandbox launch" }
    ]);
  }

  const e2bApiKey = ctx.env.E2B_API_KEY?.trim();
  if (!e2bApiKey) {
    return fail(ctx, "HUMANISH_LAB_PREFLIGHT_E2B_REQUIRED", "public-preview preflight creates one E2B desktop to probe target reachability; E2B_API_KEY is required.", [
      { name: "e2b api key", ok: false, message: "missing E2B_API_KEY" }
    ]);
  }

  const probe = await withPreflightSandbox(ctx, { e2bApiKey }, async (desktop) => {
    for (const target of publicTargets) {
      const reachable = await probeUrl(desktop, targetUrlFor(ctx.config, target), {
        timeoutMs: ctx.timeoutMs,
        requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        ...(ctx.hooks.now === undefined ? {} : { now: ctx.hooks.now }),
        ...(ctx.hooks.sleep === undefined ? {} : { sleep: ctx.hooks.sleep })
      });
      markTargetReachability(target, reachable);
    }
  });

  if (!probe.ok) {
    return probe.result;
  }

  const failed = publicTargets.find((target) => target.reachable === false);
  if (failed) {
    return fail(ctx, "HUMANISH_LAB_PREFLIGHT_TARGET_UNREACHABLE", "one or more declared public-preview targets were not reachable from the hosted desktop.", [
      { name: "target reachability", ok: false, message: `${publicTargets.filter((target) => target.reachable).length}/${publicTargets.length} targets reachable` }
    ]);
  }

  return finalize(ctx, {
    check: { name: "target reachability", ok: true, message: `${publicTargets.length}/${publicTargets.length} targets reachable from hosted desktop` }
  });
}

async function runSandboxLoopbackPreflight(ctx: PreflightContext): Promise<LabPreflightResult> {
  const routeError = sandboxLoopbackRouteError(ctx.config, ctx.backend);
  if (routeError) {
    return fail(ctx, "HUMANISH_LAB_PREFLIGHT_UNSUPPORTED_ROUTE", routeError, [
      { name: "route", ok: false, message: routeError }
    ]);
  }

  const missingEnv = (ctx.config.subject.env ?? []).filter((name) => !ctx.env[name]?.trim());
  if (missingEnv.length > 0) {
    return fail(ctx, "HUMANISH_LAB_PREFLIGHT_ENV_MISSING", `sandbox-loopback preflight needs declared env values: ${missingEnv.join(", ")}`, [
      { name: "subject env", ok: false, message: `${missingEnv.length} declared env var value(s) missing` }
    ]);
  }

  const e2bApiKey = ctx.env.E2B_API_KEY?.trim();
  if (!e2bApiKey) {
    return fail(ctx, "HUMANISH_LAB_PREFLIGHT_E2B_REQUIRED", "sandbox-loopback preflight creates one E2B desktop to clone, serve, and probe the subject; E2B_API_KEY is required.", [
      { name: "e2b api key", ok: false, message: "missing E2B_API_KEY" }
    ]);
  }

  const repo = ctx.config.subject.repos?.[0];
  const serve = ctx.config.subject.serve;
  if (!repo || !serve) {
    return fail(ctx, "HUMANISH_LAB_PREFLIGHT_UNSUPPORTED_ROUTE", "sandbox-loopback preflight requires one clone repo and subject.serve.", [
      { name: "clone subject", ok: false, message: "missing repo or serve block" }
    ]);
  }

  let subjectCommitDigest: string | undefined;
  const probe = await withPreflightSandbox(ctx, { e2bApiKey }, async (desktop) => {
    const subjectEnvNames = ctx.config.subject.env ?? [];
    await provisionCloneSubject(desktop, {
      repo,
      depth: ctx.config.subject.clone?.depth ?? 1,
      serve,
      ...(ctx.config.subject.state === undefined ? {} : { state: ctx.config.subject.state }),
      hasGithubToken: subjectEnvNames.includes("GITHUB_TOKEN"),
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      scrub: makeEnvScrubber(ctx.env, subjectEnvNames),
      onCommit: (commit) => {
        subjectCommitDigest = digest(commit);
      },
      ...(ctx.hooks.now === undefined ? {} : { now: ctx.hooks.now }),
      ...(ctx.hooks.sleep === undefined ? {} : { sleep: ctx.hooks.sleep })
    });
    const serveTarget = ctx.targets.find((target) => target.kind === "subject.serve.url");
    if (serveTarget) {
      markTargetReachability(serveTarget, true);
    }
  });

  if (!probe.ok) {
    return probe.result;
  }

  return finalize(ctx, {
    check: {
      name: "subject provisioning",
      ok: true,
      message: `clone subject served and answered readiness${subjectCommitDigest ? ` (commit digest ${subjectCommitDigest})` : ""}`
    }
  });
}

async function withPreflightSandbox(
  ctx: PreflightContext,
  args: { e2bApiKey: string },
  callback: (desktop: E2BDesktopSandbox) => Promise<void>
): Promise<{ ok: true } | { ok: false; result: LabPreflightResult }> {
  let module: E2BDesktopModule | undefined;
  let desktop: E2BDesktopSandbox | undefined;
  let failureMessage: string | undefined;
  try {
    module = await (ctx.hooks.loadDesktopModule ?? loadE2BDesktopModule)();
    desktop = await createDesktopSandbox(module, {
      apiKey: args.e2bApiKey,
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      timeoutMs: ctx.config.execution?.desktop?.sandboxTimeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
      lifecycle: { onTimeout: "kill" },
      metadata: {
        ...CUA_ACTOR_LAB_PROVIDER_METADATA,
        mode: "lab-preflight",
        labId: ctx.config.id,
        reachability: ctx.reachability
      },
      ...(ctx.config.subject.env?.length
        ? { envs: Object.fromEntries(ctx.config.subject.env.map((name) => [name, ctx.env[name] as string])) }
        : {}),
      ...(ctx.config.execution?.desktop?.resolution ? { resolution: ctx.config.execution.desktop.resolution } : {}),
      dpi: 96
    }, ctx.config.execution?.desktop?.template);
    ctx.sandbox = {
      created: true,
      sandboxIdDigest: digest(desktop.sandboxId),
      ...(ctx.config.execution?.desktop?.template ? { template: ctx.config.execution.desktop.template } : {})
    };

    await callback(desktop);
  } catch (error: unknown) {
    failureMessage = compactError(error);
  } finally {
    if (module && desktop) {
      if (typeof module.Sandbox.kill === "function") {
        try {
          await module.Sandbox.kill(desktop.sandboxId, { requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS });
          ctx.sandbox = { ...ctx.sandbox, killed: true };
        } catch (error: unknown) {
          ctx.sandbox = { ...ctx.sandbox, killed: false };
          ctx.warnings.push(`Sandbox teardown failed; server-side timeout should reclaim it: ${compactError(error)}`);
        }
      } else {
        ctx.sandbox = { ...ctx.sandbox, killed: false };
        ctx.warnings.push("Installed @e2b/desktop SDK does not expose Sandbox.kill; server-side timeout should reclaim the sandbox.");
      }
    }
  }

  if (failureMessage) {
    return {
      ok: false,
      result: fail(ctx, "HUMANISH_LAB_PREFLIGHT_PROVISION_FAILED", failureMessage, [
        { name: "sandbox preflight", ok: false, message: failureMessage }
      ])
    };
  }

  if (ctx.sandbox.created && ctx.sandbox.killed !== true) {
    return {
      ok: false,
      result: fail(ctx, "HUMANISH_LAB_PREFLIGHT_TEARDOWN_FAILED", "preflight sandbox was created but teardown could not be proven.", [
        { name: "sandbox teardown", ok: false, message: "sandbox kill was not proven" }
      ])
    };
  }

  return { ok: true };
}

function finalize(ctx: PreflightContext, args?: { check?: LabPreflightCheck }): LabPreflightResult {
  const checks = args?.check ? [...ctx.checks, args.check] : ctx.checks;
  return {
    schema: LAB_PREFLIGHT_SCHEMA,
    ok: checks.every((check) => check.ok) && ctx.targets.every((target) => target.status !== "failed" && target.status !== "blocked"),
    cwd: ctx.cwd,
    lab: ctx.lab,
    labId: ctx.labId,
    origin: ctx.origin,
    path: ctx.path,
    backend: ctx.backend,
    reachability: ctx.reachability,
    checks,
    targets: ctx.targets,
    sandbox: ctx.sandbox,
    spend: {
      e2bDesktop: ctx.sandbox.created,
      model: false
    },
    warnings: ctx.warnings
  };
}

function fail(
  ctx: PreflightContext,
  code: NonNullable<LabPreflightResult["error"]>["code"],
  message: string,
  checks: LabPreflightCheck[]
): LabPreflightResult {
  return {
    ...finalize(ctx),
    ok: false,
    checks: [...ctx.checks, ...checks],
    error: { code, message }
  };
}

function collectTargets(config: LabConfig): LabPreflightTarget[] {
  const targets: LabPreflightTarget[] = [];
  if (config.subject.appUrl) {
    targets.push(makeTarget("subject.appUrl", "subject.appUrl", config.subject.appUrl));
  }
  for (const [index, lane] of (config.actors[0]?.lanes ?? []).entries()) {
    if (lane.target) {
      targets.push(makeTarget(`actors[0].lanes[${index}].target`, "actors[0].lanes[].target", lane.target));
    }
  }
  if (config.subject.serve?.url) {
    targets.push(makeTarget("subject.serve.url", "subject.serve.url", config.subject.serve.url));
  }
  for (const [index, surface] of (config.subject.product?.publicSurfaces ?? []).entries()) {
    targets.push(makeTarget(`subject.product.publicSurfaces[${index}]`, "subject.product.publicSurface", surface));
  }
  return targets;
}

function makeTarget(label: LabPreflightTarget["label"], kind: LabPreflightTarget["kind"], url: string): LabPreflightTarget {
  return {
    label,
    kind,
    targetDigest: digest(url),
    ...originDigest(url),
    loopback: isLoopbackUrl(url),
    checked: false,
    status: "not_checked",
    message: "target declared; reachability not checked"
  };
}

function markTargetReachability(target: LabPreflightTarget, reachable: boolean): void {
  target.checked = true;
  target.reachable = reachable;
  target.status = reachable ? "passed" : "failed";
  if (reachable) {
    target.message = "target reachable from preflight substrate";
    return;
  }
  target.errorCode = "HUMANISH_PREFLIGHT_TARGET_UNREACHABLE";
  target.message = "target did not answer from preflight substrate within the timeout";
}

function blockTarget(target: LabPreflightTarget, message: string): void {
  target.checked = false;
  target.reachable = false;
  target.status = "blocked";
  target.errorCode = "HUMANISH_PREFLIGHT_TARGET_BLOCKED";
  target.message = message;
}

function targetUrlFor(config: LabConfig, target: LabPreflightTarget): string {
  if (target.kind === "subject.appUrl" && config.subject.appUrl) {
    return config.subject.appUrl;
  }
  if (target.kind === "actors[0].lanes[].target") {
    const laneTarget = config.actors[0]?.lanes?.find((lane) => lane.target && digest(lane.target) === target.targetDigest)?.target;
    if (laneTarget) return laneTarget;
  }
  if (target.kind === "subject.serve.url" && config.subject.serve?.url) {
    return config.subject.serve.url;
  }
  throw new Error(`Internal preflight target lookup failed for ${target.label}.`);
}

function publicPreviewRouteError(config: LabConfig, backend: LabBackend): string | null {
  if (backend !== "cua" || config.subject.source !== "app-url" || config.execution?.target !== "e2b-desktop") {
    return "public-preview preflight supports app-url × e2b-desktop computer-use labs.";
  }
  if (config.policies?.allowPublicTargets !== true) {
    return "public-preview preflight requires policies.allowPublicTargets: true so the owner explicitly declares the public/preview target.";
  }
  return null;
}

function sandboxLoopbackRouteError(config: LabConfig, backend: LabBackend): string | null {
  if (backend !== "cua" || config.subject.source !== "clone" || config.execution?.target !== "e2b-desktop") {
    return "sandbox-loopback preflight supports clone × e2b-desktop computer-use labs. (local-tree labs are not preflightable yet: see the local-tree goal doc's out-of-scope list; a dry run of the lab is the current no-spend check.)";
  }
  if (!config.subject.serve) {
    return "sandbox-loopback preflight requires subject.serve.";
  }
  return null;
}

function makeEnvScrubber(env: NodeJS.ProcessEnv, names: string[]): (text: string) => string {
  const values = names
    .map((name) => env[name])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return (text) => values.reduce((current, value) => current.replaceAll(value, "[REDACTED_SECRET]"), text);
}

function compactError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactText(raw).replace(/\s+/g, " ").trim().slice(0, 500);
}

function originDigest(value: string): { originDigest?: string } {
  try {
    return { originDigest: digest(new URL(value).origin) };
  } catch {
    return {};
  }
}

function digest(value: string): string {
  return digestText(value, 16);
}
