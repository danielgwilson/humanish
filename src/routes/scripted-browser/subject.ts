// The provisioned subject of a live clone scripted-browser lab: one E2B desktop that clones,
// seeds and serves the app, exposed through a tokenless getHost URL and killed by exact id at
// teardown.

import { commandDigestOf } from "../../subject/state.js";
import type { ScriptedPlan } from "../../lab/plan-types.js";
import {
  validatePreparedRunArtifactPaths,
  type PreparedRunArtifactPaths,
} from "../../run/paths.js";
import type { RunSubjectStateStepRecord } from "../../run/bundle.js";
import { provisionCloneSubject } from "../../subject/clone.js";
import type { DetachedTimers } from "../../substrates/detached.js";
import { loadE2BDesktopModule, type E2BDesktopModule } from "../../substrates/e2b/sdk.js";
import {
  observeDesktopResources,
  type DesktopResourceObservation,
} from "../../substrates/e2b/desktop-resources.js";
import { acquireE2BDesktopSandbox } from "../../substrates/e2b/sandbox.js";
import { e2bShell } from "../../substrates/e2b/shell.js";
import { redactText, toErrorMessage } from "../../evidence/redaction.js";
import type { ScriptedBrowserLabHooks } from "./types.js";

const SANDBOX_TIMEOUT_BUFFER_MS = 10 * 60_000;

const SUBJECT_PROVISION_BUDGET_MS = 30 * 60_000;

const DEFAULT_STATE_STEP_TIMEOUT_MS = 5 * 60_000;

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function servePort(serveUrl: string): number {
  const url = new URL(serveUrl);
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function isTokenlessHost(value: string): boolean {
  try {
    const url = new URL(value);
    return url.username === "" && url.password === "" && url.search === "";
  } catch {
    return false;
  }
}

function hostOriginDigest(url: string): string {
  try {
    return commandDigestOf(new URL(url).origin);
  } catch {
    return commandDigestOf(url);
  }
}

type ScriptedCloneSubject = Extract<ScriptedPlan["subject"], { readonly kind: "clone" }>;

/** What the subject needs from the run. */
export interface ScriptedSubjectInputs {
  plan: ScriptedPlan;
  clone: ScriptedCloneSubject;
  hooks: ScriptedBrowserLabHooks;
  env: Record<string, string | undefined>;
  e2bApiKey: string;
  runPaths: PreparedRunArtifactPaths;
  timeoutMs: number;
  subjectEnvNames: string[];
  hasGithubToken: boolean;
  scrubKnownValues: (text: string) => string;
  now: () => number;
  /** The run's warnings. Teardown appends to it. */
  warnings: string[];
}

/** The subject sandbox and what provisioning it recorded. */
export class ScriptedSubject {
  sandboxId: string | undefined;
  killed = false;
  commit: string | undefined;
  hostDigest: string | undefined;
  readonly stateStepRecords: RunSubjectStateStepRecord[] = [];
  private readonly inputs: ScriptedSubjectInputs;
  private module: E2BDesktopModule | undefined;
  private createdAtMs: number | undefined;
  private tornDownAtMs: number | undefined;
  private resources: DesktopResourceObservation | undefined;

  constructor(inputs: ScriptedSubjectInputs) {
    this.inputs = inputs;
  }

  /** Acquires, provisions and serves the subject. Returns the tokenless getHost URL to drive. */
  async provision(): Promise<string> {
    const { plan, clone, hooks, env, e2bApiKey, runPaths, timeoutMs } = this.inputs;
    const { subjectEnvNames, hasGithubToken, scrubKnownValues, now } = this.inputs;
    const requestTimeoutMs = readPositiveInt(env.HUMANISH_E2B_REQUEST_TIMEOUT_MS, 60_000);
    const timers: DetachedTimers = hooks.detachedTimers ?? {};
    const subjectSandboxTimeoutMs =
      timeoutMs +
      SUBJECT_PROVISION_BUDGET_MS +
      (clone.state?.seed ?? []).reduce(
        (sum, step) => sum + (step.timeoutMs ?? DEFAULT_STATE_STEP_TIMEOUT_MS),
        0,
      ) +
      SANDBOX_TIMEOUT_BUFFER_MS;
    const subjectModule = await (hooks.loadDesktopModule ?? loadE2BDesktopModule)();
    this.module = subjectModule;
    await validatePreparedRunArtifactPaths(runPaths);
    // The receipt is on disk before any work on the sandbox, so `humanish reclaim` can kill
    // it by exact id when this process dies mid-run; the finally block below only runs while
    // the process is alive.
    const subject = await acquireE2BDesktopSandbox({
      module: subjectModule,
      options: {
        apiKey: e2bApiKey,
        requestTimeoutMs,
        timeoutMs: subjectSandboxTimeoutMs,
        metadata: {
          mode: "scripted-browser-lab",
          tool: "humanish",
          labId: plan.labId,
          role: "subject",
          actor: plan.actor,
        },
        ...(subjectEnvNames.length > 0
          ? {
              envs: Object.fromEntries(subjectEnvNames.map((name) => [name, env[name] as string])),
            }
          : {}),
        dpi: 96,
        lifecycle: { onTimeout: "kill" },
      },
      template: plan.residual.execution?.desktop?.template,
      receipt: { root: runPaths, laneId: "subject" },
    });
    const subjectDesktop = subject.sandbox;
    this.sandboxId = subject.allocation.resourceId;
    this.createdAtMs = now();
    this.resources = await observeDesktopResources(subjectDesktop);

    if (hooks.prepareDesktop) {
      await hooks.prepareDesktop(subjectDesktop);
      await validatePreparedRunArtifactPaths(runPaths);
    }

    this.commit = await provisionCloneSubject(e2bShell(subjectDesktop), {
      repo: clone.repo,
      depth: plan.residual.subject.clone?.depth ?? 1,
      serve: clone.serve,
      ...(clone.state === undefined ? {} : { state: clone.state }),
      hasGithubToken,
      requestTimeoutMs,
      scrub: scrubKnownValues,
      onCommit: (commit) => {
        this.commit = commit;
      },
      onStateStep: (record) => {
        this.stateStepRecords.push(record);
      },
      ...timers,
    });

    if (typeof subjectDesktop.getHost !== "function") {
      throw new Error(
        "the installed @e2b/desktop SDK does not expose getHost(port); clone scripted-browser labs require it to reach the provisioned subject",
      );
    }
    const rawHost = subjectDesktop.getHost(servePort(clone.serve.url));
    const hostUrl = /^https?:\/\//i.test(rawHost) ? rawHost : `https://${rawHost}`;
    if (!isTokenlessHost(hostUrl)) {
      throw new Error(
        "getHost returned a non-tokenless URL; refusing to persist or drive a host URL that may carry a credential",
      );
    }
    this.hostDigest = hostOriginDigest(hostUrl);
    return hostUrl;
  }

  /** Kills the subject by exact id, when one was acquired. */
  async teardown(): Promise<void> {
    const { warnings, scrubKnownValues, now } = this.inputs;
    if (this.sandboxId !== undefined && this.module) {
      if (typeof this.module.Sandbox.kill === "function") {
        try {
          await this.module.Sandbox.kill(this.sandboxId, {
            requestTimeoutMs: 60_000,
          });
          this.killed = true;
        } catch (error) {
          warnings.push(
            `Subject sandbox teardown failed (server-side kill-on-timeout will reclaim it): ${redactText(scrubKnownValues(toErrorMessage(error)))}`,
          );
        }
        this.tornDownAtMs = now();
      } else {
        warnings.push(
          "Installed @e2b/desktop SDK does not expose Sandbox.kill; server-side kill-on-timeout will reclaim the subject sandbox.",
        );
      }
    }
  }

  /** The subject desktop's billed span and size, when one was acquired. */
  desktopUsage():
    | {
        durationMs: number | undefined;
        observation: DesktopResourceObservation | undefined;
        killed: boolean;
      }
    | undefined {
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
