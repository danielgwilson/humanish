// The two reachability probes `humanish lab preflight` can run: public-preview checks a public
// target from an E2B desktop, and sandbox-loopback serves a clone subject inside one. Each leases one
// sandbox, journals it for `humanish reclaim --preflight`, and tears it down. preflight.ts resolves
// the lab and dispatches here.

import { cloneProvisioningBudgetMs, provisionCloneSubject } from "../subject/clone.js";
import { CUA_ACTOR_LAB_PROVIDER_METADATA } from "../routes/computer-use/e2b-desktop/prepare.js";
import { MAX_SANDBOX_MS } from "../substrates/e2b/lifetime.js";
import {
  abandonPreflightJournal,
  discardPreflightJournal,
  openPreflightJournal,
  type PreflightJournal,
} from "../run/preflight-receipts.js";
import { probeUrl } from "../substrates/detached.js";
import { loadE2BDesktopModule } from "../substrates/e2b/sdk.js";
import { acquireE2BDesktopSandbox, readE2BRelease } from "../substrates/e2b/sandbox.js";
import type { OwnedDesktopAllocation } from "../substrates/desktop-session.js";
import { e2bShell } from "../substrates/e2b/shell.js";
import type { Shell } from "../substrates/shell.js";
import { redactText } from "../evidence/redaction.js";
import type { LabRoute } from "./plan.js";
import type { LabPreflightResult, LabPreflightTarget, PreflightContext } from "./preflight.js";
import { digest, fail, finalize } from "./preflight-result.js";
import type { LabConfig } from "./types.js";
import { rosterOf } from "./parse/actors.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
// Room on the probe's lease for desktop boot and teardown around the work it does.
const PREFLIGHT_LEASE_BUFFER_MS = 5 * 60_000;

export async function runPublicPreviewPreflight(
  ctx: PreflightContext,
): Promise<LabPreflightResult> {
  const routeError = publicPreviewRouteError(ctx.config, ctx.route);
  if (routeError) {
    return fail(ctx, "HUMANISH_LAB_PREFLIGHT_UNSUPPORTED_ROUTE", routeError, [
      { name: "route", ok: false, message: routeError },
    ]);
  }

  const rosterTargets = ctx.targets.filter((target) => target.kind === "actors[0].lanes[].target");
  const publicTargets =
    rosterTargets.length > 0
      ? rosterTargets
      : ctx.targets.filter((target) => target.kind === "subject.appUrl");
  if (publicTargets.length === 0) {
    return fail(
      ctx,
      "HUMANISH_LAB_PREFLIGHT_TARGET_POLICY",
      "public-preview preflight needs at least one declared app-url target.",
      [{ name: "targets", ok: false, message: "no app-url targets were declared" }],
    );
  }

  const loopbackTarget = publicTargets.find((target) => target.loopback);
  if (loopbackTarget) {
    blockTarget(
      loopbackTarget,
      "public-preview requires externally reachable non-loopback targets.",
    );
    return fail(
      ctx,
      "HUMANISH_LAB_PREFLIGHT_TARGET_POLICY",
      "public-preview reachability cannot prove loopback targets from a hosted desktop; use sandbox-loopback or a prepared public target.",
      [
        {
          name: "target policy",
          ok: false,
          message: "loopback target blocked before sandbox launch",
        },
      ],
    );
  }

  const e2bApiKey = ctx.env.E2B_API_KEY?.trim();
  if (!e2bApiKey) {
    return fail(
      ctx,
      "HUMANISH_LAB_PREFLIGHT_E2B_REQUIRED",
      "public-preview preflight creates one E2B desktop to probe target reachability; E2B_API_KEY is required.",
      [{ name: "e2b api key", ok: false, message: "missing E2B_API_KEY" }],
    );
  }

  // Each target gets at most one readiness budget.
  const leaseMs = publicTargets.length * ctx.timeoutMs + PREFLIGHT_LEASE_BUFFER_MS;
  const probe = await withPreflightSandbox(ctx, { e2bApiKey, leaseMs }, async (shell) => {
    for (const target of publicTargets) {
      const reachable = await probeUrl(shell, targetUrlFor(ctx.config, target), {
        timeoutMs: ctx.timeoutMs,
        requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        ...(ctx.hooks.now === undefined ? {} : { now: ctx.hooks.now }),
        ...(ctx.hooks.sleep === undefined ? {} : { sleep: ctx.hooks.sleep }),
      });
      markTargetReachability(target, reachable);
    }
  });

  if (!probe.ok) {
    return probe.result;
  }

  const failed = publicTargets.find((target) => target.reachable === false);
  if (failed) {
    return fail(
      ctx,
      "HUMANISH_LAB_PREFLIGHT_TARGET_UNREACHABLE",
      "one or more declared public-preview targets were not reachable from the hosted desktop.",
      [
        {
          name: "target reachability",
          ok: false,
          message: `${publicTargets.filter((target) => target.reachable).length}/${publicTargets.length} targets reachable`,
        },
      ],
    );
  }

  return finalize(ctx, {
    check: {
      name: "target reachability",
      ok: true,
      message: `${publicTargets.length}/${publicTargets.length} targets reachable from hosted desktop`,
    },
  });
}

export async function runSandboxLoopbackPreflight(
  ctx: PreflightContext,
): Promise<LabPreflightResult> {
  const routeError = sandboxLoopbackRouteError(ctx.config, ctx.route);
  if (routeError) {
    return fail(ctx, "HUMANISH_LAB_PREFLIGHT_UNSUPPORTED_ROUTE", routeError, [
      { name: "route", ok: false, message: routeError },
    ]);
  }

  const missingEnv = (ctx.config.subject.env ?? []).filter((name) => !ctx.env[name]?.trim());
  if (missingEnv.length > 0) {
    return fail(
      ctx,
      "HUMANISH_LAB_PREFLIGHT_ENV_MISSING",
      `sandbox-loopback preflight needs declared env values: ${missingEnv.join(", ")}`,
      [
        {
          name: "subject env",
          ok: false,
          message: `${missingEnv.length} declared env var value(s) missing`,
        },
      ],
    );
  }

  const e2bApiKey = ctx.env.E2B_API_KEY?.trim();
  if (!e2bApiKey) {
    return fail(
      ctx,
      "HUMANISH_LAB_PREFLIGHT_E2B_REQUIRED",
      "sandbox-loopback preflight creates one E2B desktop to clone, serve, and probe the subject; E2B_API_KEY is required.",
      [{ name: "e2b api key", ok: false, message: "missing E2B_API_KEY" }],
    );
  }

  const repo = ctx.config.subject.repos?.[0];
  const serve = ctx.config.subject.serve;
  if (!repo || !serve) {
    return fail(
      ctx,
      "HUMANISH_LAB_PREFLIGHT_UNSUPPORTED_ROUTE",
      "sandbox-loopback preflight requires one clone repo and subject.serve.",
      [{ name: "clone subject", ok: false, message: "missing repo or serve block" }],
    );
  }

  let subjectCommitDigest: string | undefined;
  // The longest the clone and serve steps can take with the lab's own budgets, so the probe is
  // never cut off where the run's provisioning would still be allowed to finish.
  const leaseMs =
    cloneProvisioningBudgetMs(serve, ctx.config.subject.state) + PREFLIGHT_LEASE_BUFFER_MS;
  const probe = await withPreflightSandbox(ctx, { e2bApiKey, leaseMs }, async (shell) => {
    const subjectEnvNames = ctx.config.subject.env ?? [];
    await provisionCloneSubject(shell, {
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
      ...(ctx.hooks.sleep === undefined ? {} : { sleep: ctx.hooks.sleep }),
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
      message: `clone subject served and answered readiness${subjectCommitDigest ? ` (commit digest ${subjectCommitDigest})` : ""}`,
    },
  });
}

async function withPreflightSandbox(
  ctx: PreflightContext,
  args: { e2bApiKey: string; leaseMs: number },
  callback: (shell: Shell) => Promise<void>,
): Promise<{ ok: true } | { ok: false; result: LabPreflightResult }> {
  let allocation: OwnedDesktopAllocation | undefined;
  let failureMessage: string | undefined;
  // The lease is sized to the probe's work, never longer than a declared sandbox timeout (the run
  // gets no more than that either) or E2B's maximum.
  const timeoutMs = Math.min(
    args.leaseMs,
    ctx.config.execution?.desktop?.sandboxTimeoutMs ?? MAX_SANDBOX_MS,
  );
  // The receipt goes to a journal under .humanish/preflight, so `humanish reclaim --preflight`
  // can kill the probe if this process dies before the finally block does.
  let journal: PreflightJournal | undefined;
  try {
    journal = await openPreflightJournal(ctx.cwd, timeoutMs);
  } catch (error: unknown) {
    ctx.warnings.push(
      `Preflight receipt journal could not be created (${compactError(error)}); if this process dies, only the probe's ${timeoutMs} ms timeout ends its sandbox.`,
    );
  }
  let acquired = false;
  try {
    const module = await (ctx.hooks.loadDesktopModule ?? loadE2BDesktopModule)();
    const probe = await acquireE2BDesktopSandbox({
      module,
      options: {
        apiKey: args.e2bApiKey,
        requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        timeoutMs,
        lifecycle: { onTimeout: "kill" },
        metadata: {
          ...CUA_ACTOR_LAB_PROVIDER_METADATA,
          mode: "lab-preflight",
          labId: ctx.config.id,
          reachability: ctx.reachability,
        },
        ...(ctx.config.subject.env?.length
          ? {
              envs: Object.fromEntries(
                ctx.config.subject.env.map((name) => [name, ctx.env[name] as string]),
              ),
            }
          : {}),
        ...(ctx.config.execution?.desktop?.resolution
          ? { resolution: ctx.config.execution.desktop.resolution }
          : {}),
        dpi: 96,
      },
      template: ctx.config.execution?.desktop?.template,
      receipt: journal === undefined ? null : { root: journal.root, participantId: journal.id },
    });
    acquired = true;
    allocation = probe.allocation;
    const sandboxId = probe.allocation.resourceId;
    ctx.sandbox = {
      created: true,
      timeoutMs,
      sandboxIdDigest: digest(sandboxId),
      ...(ctx.config.execution?.desktop?.template
        ? { template: ctx.config.execution.desktop.template }
        : {}),
    };

    await callback(e2bShell(probe.sandbox));
  } catch (error: unknown) {
    failureMessage = compactError(error);
  } finally {
    if (allocation !== undefined) {
      const reading = readE2BRelease(await allocation.close(), {
        label: "Sandbox",
        scrub: (text) => text,
      });
      ctx.sandbox = { ...ctx.sandbox, killed: reading.released };
      if (reading.warning) ctx.warnings.push(reading.warning);
    }
    await settlePreflightJournal(ctx, journal, !acquired || ctx.sandbox.killed === true);
  }

  if (failureMessage) {
    return {
      ok: false,
      result: fail(ctx, "HUMANISH_LAB_PREFLIGHT_PROVISION_FAILED", failureMessage, [
        { name: "sandbox preflight", ok: false, message: failureMessage },
      ]),
    };
  }

  if (ctx.sandbox.created && ctx.sandbox.killed !== true) {
    return {
      ok: false,
      result: fail(
        ctx,
        "HUMANISH_LAB_PREFLIGHT_TEARDOWN_FAILED",
        "preflight sandbox was created but teardown could not be proven.",
        [{ name: "sandbox teardown", ok: false, message: "sandbox kill was not proven" }],
      ),
    };
  }

  return { ok: true };
}

/**
 * Remove the journal once no sandbox can be left: acquisition failed before a handle came back
 * (the sandbox module releases what it created), or the kill was confirmed. Otherwise keep it
 * for `humanish reclaim --preflight`.
 */
async function settlePreflightJournal(
  ctx: PreflightContext,
  journal: PreflightJournal | undefined,
  gone: boolean,
): Promise<void> {
  if (journal === undefined) return;
  if (!gone) {
    await abandonPreflightJournal(journal).catch(() => undefined);
    ctx.warnings.push(
      `The preflight sandbox's receipt stays in .humanish/preflight/${journal.id}; run \`humanish reclaim --preflight\` to kill it by id.`,
    );
    return;
  }
  await discardPreflightJournal(journal).catch((error: unknown) => {
    ctx.warnings.push(
      `Preflight receipt journal ${journal.id} could not be removed: ${compactError(error)}`,
    );
  });
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
    const rosterTarget = rosterOf(config.actors[0])?.find(
      (entry) => entry.target && digest(entry.target) === target.targetDigest,
    )?.target;
    if (rosterTarget) return rosterTarget;
  }
  if (target.kind === "subject.serve.url" && config.subject.serve?.url) {
    return config.subject.serve.url;
  }
  throw new Error(`Internal preflight target lookup failed for ${target.label}.`);
}

function publicPreviewRouteError(config: LabConfig, route: LabRoute): string | null {
  if (
    route !== "computer-use" ||
    config.subject.source !== "app-url" ||
    config.execution?.target !== "e2b-desktop"
  ) {
    return "public-preview preflight supports app-url × e2b-desktop computer-use labs.";
  }
  if (config.policies?.allowPublicTargets !== true) {
    return "public-preview preflight requires policies.allowPublicTargets: true so the owner explicitly declares the public/preview target.";
  }
  return null;
}

function sandboxLoopbackRouteError(config: LabConfig, route: LabRoute): string | null {
  if (
    route !== "computer-use" ||
    config.subject.source !== "clone" ||
    config.execution?.target !== "e2b-desktop"
  ) {
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
  return (text) =>
    values.reduce((current, value) => current.replaceAll(value, "[REDACTED_SECRET]"), text);
}

function compactError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactText(raw).replace(/\s+/g, " ").trim().slice(0, 500);
}
