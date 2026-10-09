// The first half of an E2B desktop participant's preparation: acquire the sandbox, verify its screen, and
// provision the subject. Each step fills the participant's state; a step that cannot proceed throws.

import { redactText } from "../../../evidence/redaction.js";
import { validatePreparedRunArtifactPaths } from "../../../run/paths.js";
import { provisionCloneSubject } from "../../../subject/clone.js";
import { provisionDesktopCli } from "../../../subject/desktop-cli.js";
import { provisionLocalTreeSubject } from "../../../subject/local-tree.js";
import { SubjectBuildError } from "../../../subject/serve.js";
import { inspectDesktopScreenGeometry } from "../../../substrates/e2b/desktop-geometry.js";
import { observeDesktopResources } from "../../../substrates/e2b/desktop-resources.js";
import { acquireE2BDesktopSandbox, e2bDesktopTemplate } from "../../../substrates/e2b/sandbox.js";
import { loadE2BDesktopModule, type E2BDesktopSandbox } from "../../../substrates/e2b/sdk.js";
import { e2bShell } from "../../../substrates/e2b/shell.js";
import { attachReceivingInbox, participantCommsEnv, startCommsCatch } from "./comms.js";
import type { E2BParticipantContext, E2BParticipantState } from "./state.js";
import { participantSubjectEnv } from "../types.js";

export const CUA_ACTOR_STUDY_PROVIDER_METADATA = {
  mode: "cua-actor-lab",
  tool: "humanish",
} as const;

/**
 * Create the participant's sandbox, record its resources, run the adopter's prepare hook, and attach the
 * participant's inbox and comms catch. Returns the sandbox, which the later steps drive.
 */
export async function acquireParticipantDesktop(
  ctx: E2BParticipantContext,
  state: E2BParticipantState,
): Promise<E2BDesktopSandbox> {
  const { spec, deps, warnings } = ctx;
  const { residual, env } = deps;
  const subjectEnvNames = participantSubjectEnv(deps.subject);
  const subjectEnvValues = residual.subject.envValues ?? {};
  // Off-app comms: the base-URL env is injected at sandbox create, so the app reads it at
  // boot; the catch starts right after create.
  const commsEnv = participantCommsEnv(ctx.comms);
  const desktopModule = await (deps.desktopModule ?? loadE2BDesktopModule)();
  // An explicit template wins. Speech gets the versioned media image; ordinary
  // browser studies retain the SDK default desktop.
  const acquired = await acquireE2BDesktopSandbox({
    module: desktopModule,
    options: {
      apiKey: deps.e2bApiKey,
      requestTimeoutMs: deps.requestTimeoutMs,
      timeoutMs: deps.sandboxMs,
      metadata: {
        ...CUA_ACTOR_STUDY_PROVIDER_METADATA,
        labId: deps.studyId,
        recordId: spec.recordId,
        participantId: spec.planned.id,
        participantIndex: String(spec.planned.index),
        participantCount: String(deps.participantCount),
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
    template: e2bDesktopTemplate(residual),
    retry: {
      // The default loader reclaims an acquired handle before retrying failed desktop startup.
      // Its error names the cleanup outcome; pre-construction allocation failures remain unowned.
      onRetry: (reason) => {
        const named = redactText(deps.scrubKnownValues(reason));
        warnings.push(
          `Sandbox create for participant ${spec.planned.id} retried once after a transient provider error (${named}).`,
        );
        ctx.onSubjectPhase({
          at: new Date(deps.now()).toISOString(),
          type: "cua-lab.sandbox.create.retry",
          message: `sandbox create retried once (${named})`,
        });
      },
    },
    // The receipt is on disk before any work, so `humanish reclaim` can kill this participant's
    // sandbox by exact id after an interrupt.
    receipt: { root: deps.artifactRoot, participantId: spec.planned.id, now: deps.now },
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

  if (deps.prepareDesktop) {
    await deps.prepareDesktop(desktop, {
      kind: "participant",
      participant: { id: spec.planned.id, index: spec.planned.index, count: deps.participantCount },
    });
    // The caller's hook runs with this process's file access, so the run directory is checked
    // again before more evidence goes into it.
    if ("physicalRunRoot" in deps.artifactRoot)
      await validatePreparedRunArtifactPaths(deps.artifactRoot);
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
 * Verify the participant's screen in the sandbox. A mismatch fails the participant closed unless the run records
 * requested and verified geometry side by side.
 */
export async function verifyParticipantScreen(
  ctx: E2BParticipantContext,
  state: E2BParticipantState,
  desktop: E2BDesktopSandbox,
): Promise<void> {
  const { spec, deps, warnings } = ctx;
  const screenGeometry = await inspectDesktopScreenGeometry({
    desktop,
    participantId: spec.planned.id,
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
    state.failureCode = "HUMANISH_COMPUTER_USE_DEVICE_GEOMETRY";
    throw new Error(screenGeometry.error);
  }
  if (screenGeometry.error && screenGeometry.verified) {
    // record-evidence policy: the bundle keeps requested vs verified as separate facts and
    // discloses the divergence instead of failing this participant's world mid-flight.
    const mismatchWarning = deps.scrubKnownValues(
      `Participant ${spec.planned.id} requested a ${spec.planned.device.resolution[0]}x${spec.planned.device.resolution[1]} screen but xdpyinfo reports ${screenGeometry.verified.width}x${screenGeometry.verified.height}; recording requested vs verified separately instead of failing the participant closed.`,
    );
    warnings.push(mismatchWarning);
    state.desktopGeometry = {
      ...state.desktopGeometry,
      warnings: [...(state.desktopGeometry.warnings ?? []), mismatchWarning],
    };
  }
}

/** Install a desktop CLI, or clone or unpack the subject and serve it, in the sandbox. */
export async function provisionParticipantSubject(
  ctx: E2BParticipantContext,
  state: E2BParticipantState,
  desktop: E2BDesktopSandbox,
): Promise<void> {
  const { deps } = ctx;
  const { residual, subject } = deps;
  const shell = e2bShell(desktop);
  if (subject.kind === "desktop-cli") {
    // Prepare the runtime and any declared product install, with no keys. With install omitted,
    // the participant discovers and installs the product from its public surfaces.
    await provisionDesktopCli(shell, {
      product: subject.product.name,
      ...(subject.product.install === undefined ? {} : { install: subject.product.install }),
      requestTimeoutMs: deps.requestTimeoutMs,
      scrub: deps.scrubKnownValues,
      onPhase: ctx.onSubjectPhase,
    });
  }
  try {
    if (subject.kind === "clone") {
      state.subjectCommit = await provisionCloneSubject(shell, {
        repo: subject.repo,
        depth: residual.subject.clone?.depth ?? 1,
        serve: subject.serve,
        ...(subject.state === undefined ? {} : { state: subject.state }),
        hasGithubToken: subject.env.includes("GITHUB_TOKEN"),
        requestTimeoutMs: deps.requestTimeoutMs,
        scrub: deps.scrubKnownValues,
        onCommit: (commit) => {
          state.subjectCommit = commit;
        },
        onStateStep: (record) => {
          state.stateStepRecords.push(record);
        },
        onPhase: ctx.onSubjectPhase,
        ...deps.detachedTimers,
      });
    } else if (subject.kind === "local-tree" && deps.localTreeArchiveBuffer) {
      await provisionLocalTreeSubject(shell, {
        archiveBuffer: deps.localTreeArchiveBuffer,
        serve: subject.serve,
        ...(subject.state === undefined ? {} : { state: subject.state }),
        requestTimeoutMs: deps.requestTimeoutMs,
        scrub: deps.scrubKnownValues,
        onStateStep: (record) => {
          state.stateStepRecords.push(record);
        },
        onPhase: ctx.onSubjectPhase,
        ...deps.detachedTimers,
      });
    }
  } catch (error) {
    // A failed serve.build gets its own code, so the run names the step the author has to fix.
    if (error instanceof SubjectBuildError)
      state.failureCode = "HUMANISH_COMPUTER_USE_SUBJECT_BUILD_FAILED";
    throw error;
  }
}
