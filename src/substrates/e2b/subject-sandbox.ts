// The subject sandbox of a provisioned clone: the one E2B desktop that serves the app, on the
// scripted clone route and the shared-world provisioned plane. Both routes create, measure and
// release it through this class, so a change to its request, its size check or its release
// reading is one edit. What runs inside the sandbox (the caller's prepare hook, provisioning,
// getHost) stays with each route.

import { redactText } from "../../evidence/redaction.js";
import { DEFAULT_STATE_STEP_TIMEOUT_MS } from "../../subject/state.js";
import type { PreparedOutputRoot } from "../../run/contained-output.js";
import type { OwnedDesktopAllocation } from "../desktop-session.js";
import { observeDesktopResources, type DesktopResourceObservation } from "./desktop-resources.js";
import { SANDBOX_TIMEOUT_BUFFER_MS, SUBJECT_PROVISION_BUDGET_MS } from "./lifetime.js";
import { acquireE2BDesktopSandbox, readE2BRelease } from "./sandbox.js";
import type { E2BDesktopModule, E2BDesktopSandbox } from "./sdk.js";

/** The subject desktop's billed span and size, for the run's cost estimate. */
export interface SubjectDesktopUsage {
  durationMs: number | undefined;
  observation: DesktopResourceObservation | undefined;
  killed: boolean;
}

/** The run the subject sandbox reports to. */
export interface SubjectSandboxRun {
  /** The run's warnings. Acquisition and release append to it. */
  warnings: string[];
  scrub: (text: string) => string;
  now: () => number;
}

/** How to create the subject sandbox. */
export interface SubjectSandboxRequest {
  module: E2BDesktopModule;
  apiKey: string;
  requestTimeoutMs: number;
  /**
   * The participants' session budget. The sandbox outlives it by the provision budget, each seed
   * step's budget and the reclamation buffer, so E2B kills it only after the run is done with it.
   */
  sessionTimeoutMs: number;
  seed: readonly { readonly timeoutMs?: number | undefined }[];
  /** The route's labels. Acquisition adds the run's owner tags. */
  metadata: Record<string, string>;
  /** The subject's environment at create; an empty record sets none. */
  envs: Record<string, string>;
  template: string | undefined;
  /** Where the receipt goes, under the participant label `subject`. */
  root: PreparedOutputRoot;
}

export class E2BSubjectSandbox {
  sandboxId: string | undefined;
  killed = false;
  /** The scrubbed release warning when the release is unconfirmed. */
  releaseWarning: string | undefined;
  private readonly run: SubjectSandboxRun;
  private allocation: OwnedDesktopAllocation | undefined;
  private createdAtMs: number | undefined;
  private tornDownAtMs: number | undefined;
  private resources: DesktopResourceObservation | undefined;

  constructor(run: SubjectSandboxRun) {
    this.run = run;
  }

  /**
   * Creates the sandbox and reads its size. The receipt is on disk before this returns, so
   * `humanish reclaim` can kill the sandbox by exact id if the process dies during provisioning.
   */
  async acquire(request: SubjectSandboxRequest): Promise<E2BDesktopSandbox> {
    const { envs } = request;
    const { warnings, scrub } = this.run;
    const timeoutMs =
      request.sessionTimeoutMs +
      SUBJECT_PROVISION_BUDGET_MS +
      request.seed.reduce(
        (sum, step) => sum + (step.timeoutMs ?? DEFAULT_STATE_STEP_TIMEOUT_MS),
        0,
      ) +
      SANDBOX_TIMEOUT_BUFFER_MS;
    const subject = await acquireE2BDesktopSandbox({
      module: request.module,
      options: {
        apiKey: request.apiKey,
        requestTimeoutMs: request.requestTimeoutMs,
        timeoutMs,
        metadata: request.metadata,
        ...(Object.keys(envs).length > 0 ? { envs } : {}),
        dpi: 96,
        lifecycle: { onTimeout: "kill" },
      },
      template: request.template,
      retry: {
        // A failed first attempt may have allocated a sandbox whose id never reached this run;
        // its own kill-on-timeout reclaims it.
        onRetry: (reason) => {
          warnings.push(
            `Subject sandbox create retried once after a transient provider error (${redactText(scrub(reason))}). A sandbox the failed attempt may have allocated is reclaimed by its ${timeoutMs} ms timeout.`,
          );
        },
      },
      receipt: { root: request.root, participantId: "subject" },
    });
    this.allocation = subject.allocation;
    this.sandboxId = subject.allocation.resourceId;
    this.createdAtMs = this.run.now();
    const resources = await observeDesktopResources(subject.sandbox);
    this.resources = resources;
    if ("reason" in resources)
      warnings.push(
        `Subject sandbox resource size unavailable (${resources.reason}); its compute cost remains unpriced.`,
      );
    return subject.sandbox;
  }

  /** Releases the sandbox by exact id, when one was acquired. An unconfirmed release is reported. */
  async release(): Promise<void> {
    const { warnings, scrub, now } = this.run;
    if (this.allocation === undefined) return;
    const released = await this.allocation.close();
    const reading = readE2BRelease(released, { label: "Subject sandbox", scrub, costSpan: true });
    this.killed = reading.released;
    if (reading.warning) warnings.push(reading.warning);
    if (!reading.released)
      this.releaseWarning = reading.warning ?? "Subject sandbox release is unconfirmed.";
    // Without a kill method, or in E2B debug mode, no kill reached E2B, so there is no teardown
    // time to record.
    if (released.status !== "unconfirmed" || released.reason !== "release_unavailable")
      this.tornDownAtMs = now();
  }

  /** The billed span and size, when a sandbox was acquired. */
  desktopUsage(): SubjectDesktopUsage | undefined {
    if (this.sandboxId === undefined) return undefined;
    return {
      durationMs:
        this.createdAtMs === undefined || this.tornDownAtMs === undefined
          ? undefined
          : Math.max(0, this.tornDownAtMs - this.createdAtMs),
      observation: this.resources,
      killed: this.killed,
    };
  }
}
