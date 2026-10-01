// The first half of an E2B desktop lane's preparation: acquire the sandbox, verify its screen, and
// provision the subject. Each step fills the lane's state; a step that cannot proceed throws.

import { redactText } from "../../evidence/redaction.js";
import { provisionCloneSubject } from "../../subject/clone.js";
import { provisionDesktopCli } from "../../subject/desktop-cli.js";
import { provisionLocalTreeSubject } from "../../subject/local-tree.js";
import { inspectDesktopScreenGeometry } from "../../substrates/e2b/desktop-geometry.js";
import { observeDesktopResources } from "../../substrates/e2b/desktop-resources.js";
import { acquireE2BDesktopSandbox, e2bDesktopTemplate } from "../../substrates/e2b/sandbox.js";
import { loadE2BDesktopModule, type E2BDesktopSandbox } from "../../substrates/e2b/sdk.js";
import { e2bShell } from "../../substrates/e2b/shell.js";
import { attachReceivingInbox, laneCommsEnv, startCommsCatch } from "./e2b-desktop-comms.js";
import type { E2BLaneContext, E2BLaneState } from "./e2b-desktop-state.js";

export const CUA_ACTOR_LAB_PROVIDER_METADATA = {
  mode: "cua-actor-lab",
  tool: "humanish",
} as const;

/**
 * Create the lane's sandbox, record its resources, run the adopter's prepare hook, and attach the
 * lane's inbox and comms catch. Returns the sandbox, which the later steps drive.
 */
export async function acquireLaneDesktop(
  ctx: E2BLaneContext,
  state: E2BLaneState,
): Promise<E2BDesktopSandbox> {
  const { spec, deps, warnings } = ctx;
  const { config, subjectEnvNames, env } = deps;
  const subjectEnvValues = config.subject.envValues ?? {};
  // Off-app comms (#297): the base-URL env is injected at sandbox create, so the app reads it at
  // boot; the catch starts right after create.
  const commsEnv = laneCommsEnv(ctx.comms);
  const desktopModule = await (deps.hooks.loadDesktopModule ?? loadE2BDesktopModule)();
  // An explicit template wins. Speech gets the versioned media image; ordinary
  // browser studies retain the SDK default desktop.
  const acquired = await acquireE2BDesktopSandbox({
    module: desktopModule,
    options: {
      apiKey: deps.e2bApiKey,
      requestTimeoutMs: deps.requestTimeoutMs,
      timeoutMs: deps.sandboxMs,
      metadata: {
        ...CUA_ACTOR_LAB_PROVIDER_METADATA,
        labId: config.id,
        simId: spec.simId,
        laneId: spec.planned.id,
        laneIndex: String(spec.planned.index),
        laneCount: String(deps.participantCount),
      },
      // The participant's model key never enters the sandbox (the model drives from outside).
      // The subject's declared env names are provisioned here on the clone route.
      // Three sources, in precedence order: committed non-secret config (subject.envValues), then
      // secret values forwarded from the caller's environment (subject.env), then the harness's own
      // comms wiring, which must win because only it knows the catch's address.
      ...(subjectEnvNames.length > 0 ||
      Object.keys(subjectEnvValues).length > 0 ||
      Object.keys(commsEnv).length > 0
        ? {
            envs: {
              ...subjectEnvValues,
              ...Object.fromEntries(subjectEnvNames.map((name) => [name, env[name] as string])),
              ...commsEnv,
            },
          }
        : {}),
      resolution: spec.planned.device.resolution,
      dpi: 96,
      lifecycle: { onTimeout: "kill" },
    },
    template: e2bDesktopTemplate(config),
    retry: {
      // The default loader reclaims an acquired handle before retrying failed desktop startup.
      // Its error names the cleanup outcome; pre-construction allocation failures remain unowned.
      onRetry: (reason) => {
        const named = redactText(deps.scrubKnownValues(reason));
        warnings.push(
          `Sandbox create for lane ${spec.planned.id} retried once after a transient provider error (${named}).`,
        );
        ctx.onSubjectPhase({
          at: new Date(deps.now()).toISOString(),
          type: "cua-lab.sandbox.create.retry",
          message: `sandbox create retried once (${named})`,
        });
      },
    },
    // The receipt is on disk before any work, so `humanish reclaim` can kill this lane's
    // sandbox by exact id after an interrupt.
    receipt: { root: deps.artifactRoot, laneId: spec.planned.id, now: deps.now },
  });
  const desktop = acquired.sandbox;
  state.desktop = desktop;
  const shell = e2bShell(desktop);
  state.allocation = acquired.allocation;
  state.sandboxId = acquired.allocation.resourceId;
  // The billed span starts the instant the sandbox exists.
  state.sandboxCreatedAtMs = deps.now();
  const desktopResources = await observeDesktopResources(desktop);
  state.desktopResources = desktopResources;
  if ("reason" in desktopResources) {
    warnings.push(
      `Desktop resource size unavailable (${desktopResources.reason}); compute cost remains unpriced.`,
    );
  }

  if (deps.hooks.prepareDesktop) {
    await deps.hooks.prepareDesktop(desktop, {
      laneId: spec.planned.id,
      laneIndex: spec.planned.index,
      laneCount: deps.participantCount,
    });
  }

  if (deps.receiving) {
    state.receivingInboxUrl = await attachReceivingInbox(
      shell,
      spec,
      { ...deps, receiving: deps.receiving },
      ctx.targetUrl,
    );
    state.commsArtifactPath = "comms/receiving.json";
  }
  if (ctx.comms) state.commsCatch = await startCommsCatch(shell, ctx.comms, deps.requestTimeoutMs);
  return desktop;
}

/**
 * Verify the lane's screen in the sandbox. A mismatch fails the lane closed unless the run records
 * requested and verified geometry side by side.
 */
export async function verifyLaneScreen(
  ctx: E2BLaneContext,
  state: E2BLaneState,
  desktop: E2BDesktopSandbox,
): Promise<void> {
  const { spec, deps, warnings } = ctx;
  const screenGeometry = await inspectDesktopScreenGeometry({
    desktop,
    laneId: spec.planned.id,
    requestedScreen: spec.planned.device.resolution,
    requestTimeoutMs: deps.requestTimeoutMs,
  });
  if (screenGeometry.verified) {
    state.desktopGeometry = {
      ...state.desktopGeometry,
      screen: { ...state.desktopGeometry.screen, verified: screenGeometry.verified },
    };
  }
  if (screenGeometry.warning) {
    warnings.push(screenGeometry.warning);
    state.desktopGeometry = { ...state.desktopGeometry, warnings: [screenGeometry.warning] };
  }
  if (screenGeometry.error && deps.screenMismatchPolicy !== "record-evidence") {
    state.failureCode = "HUMANISH_CUA_LAB_DEVICE_GEOMETRY";
    throw new Error(screenGeometry.error);
  }
  if (screenGeometry.error && screenGeometry.verified) {
    // record-evidence policy: the bundle keeps requested vs verified as separate facts and
    // discloses the divergence instead of failing this lane's world mid-flight.
    const mismatchWarning = deps.scrubKnownValues(
      `Lane ${spec.planned.id} requested a ${spec.planned.device.resolution[0]}x${spec.planned.device.resolution[1]} screen but xdpyinfo reports ${screenGeometry.verified.width}x${screenGeometry.verified.height}; recording requested vs verified separately instead of failing the lane closed.`,
    );
    warnings.push(mismatchWarning);
    state.desktopGeometry = {
      ...state.desktopGeometry,
      warnings: [...(state.desktopGeometry.warnings ?? []), mismatchWarning],
    };
  }
}

/** Install a desktop CLI, or clone or unpack the subject and serve it, in the sandbox. */
export async function provisionLaneSubject(
  ctx: E2BLaneContext,
  state: E2BLaneState,
  desktop: E2BDesktopSandbox,
): Promise<void> {
  const { deps } = ctx;
  const { config, cloneRoute, localTreeRoute, serve, subjectRepo } = deps;
  const shell = e2bShell(desktop);
  if (ctx.desktopCliRoute) {
    // Prepare the runtime and any declared product install, UNKEYED. With install omitted,
    // the participant discovers and installs the product from its public surfaces.
    await provisionDesktopCli(shell, {
      product: config.subject.product?.name ?? "",
      ...(config.subject.product?.install === undefined
        ? {}
        : { install: config.subject.product.install }),
      requestTimeoutMs: deps.requestTimeoutMs,
      scrub: deps.scrubKnownValues,
      onPhase: ctx.onSubjectPhase,
    });
  }
  if (cloneRoute && serve && subjectRepo) {
    state.subjectCommit = await provisionCloneSubject(shell, {
      repo: subjectRepo,
      depth: config.subject.clone?.depth ?? 1,
      serve,
      ...(config.subject.state === undefined ? {} : { state: config.subject.state }),
      hasGithubToken: deps.hasGithubToken,
      requestTimeoutMs: deps.requestTimeoutMs,
      scrub: deps.scrubKnownValues,
      onCommit: (commit) => {
        state.subjectCommit = commit;
      },
      onStateStep: (record) => {
        state.stateStepRecords.push(record);
      },
      onPhase: ctx.onSubjectPhase,
      ...deps.hooks.detachedTimers,
    });
  } else if (localTreeRoute && serve && deps.localTreeArchiveBuffer) {
    await provisionLocalTreeSubject(shell, {
      archiveBuffer: deps.localTreeArchiveBuffer,
      serve,
      ...(config.subject.state === undefined ? {} : { state: config.subject.state }),
      requestTimeoutMs: deps.requestTimeoutMs,
      scrub: deps.scrubKnownValues,
      onStateStep: (record) => {
        state.stateStepRecords.push(record);
      },
      onPhase: ctx.onSubjectPhase,
      ...deps.hooks.detachedTimers,
    });
  }
}
