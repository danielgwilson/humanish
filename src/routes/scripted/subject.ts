// The provisioned subject of a live clone scripted-browser study: one E2B desktop that clones,
// seeds and serves the app, exposed through a tokenless getHost URL and killed by exact id at
// teardown.

import { commandDigestOf } from "../../subject/state.js";
import type { ScriptedPlan } from "../../study/plan-types.js";
import {
  validatePreparedRunArtifactPaths,
  type PreparedRunArtifactPaths,
} from "../../run/paths.js";
import type { RunSubjectStateStepRecord } from "../../run/bundle.js";
import { provisionCloneSubject } from "../../subject/clone.js";
import type { DetachedTimers } from "../../substrates/detached.js";
import { loadE2BDesktopModule } from "../../substrates/e2b/sdk.js";
import { E2BSubjectSandbox } from "../../substrates/e2b/subject-sandbox.js";
import { e2bShell } from "../../substrates/e2b/shell.js";
import type { StudyDeps } from "../../study/study-deps.js";
import type { RunStudyHomes } from "../../study/run-study-homes.js";
import { e2bRequestTimeoutMs } from "../../substrates/e2b/lifetime.js";

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
  deps: StudyDeps;
  /** Runs after the subject sandbox exists and before provisioning. */
  prepareDesktop?: NonNullable<RunStudyHomes["prepareDesktop"]>;
  env: Readonly<Record<string, string | undefined>>;
  e2bApiKey: string;
  runPaths: PreparedRunArtifactPaths;
  timeoutMs: number;
  subjectEnvNames: string[];
  hasGithubToken: boolean;
  scrubKnownValues: (text: string) => string;
  now: () => number;
  /** The run's warnings. The subject sandbox's release appends to it. */
  warnings: string[];
}

/** The subject sandbox and what provisioning it recorded. */
export class ScriptedSubject {
  readonly sandbox: E2BSubjectSandbox;
  commit: string | undefined;
  hostDigest: string | undefined;
  readonly stateStepRecords: RunSubjectStateStepRecord[] = [];
  private readonly inputs: ScriptedSubjectInputs;

  constructor(inputs: ScriptedSubjectInputs) {
    this.inputs = inputs;
    this.sandbox = new E2BSubjectSandbox({
      warnings: inputs.warnings,
      scrub: inputs.scrubKnownValues,
      now: inputs.now,
    });
  }

  /** Acquires, provisions and serves the subject. Returns the tokenless getHost URL to drive. */
  async provision(): Promise<string> {
    const { plan, clone, deps, prepareDesktop, env, e2bApiKey, runPaths, timeoutMs } = this.inputs;
    const { subjectEnvNames, hasGithubToken, scrubKnownValues } = this.inputs;
    const requestTimeoutMs = e2bRequestTimeoutMs(env);
    const timers: DetachedTimers = deps.detachedTimers ?? {};
    const subjectModule = await (deps.desktopModule ?? loadE2BDesktopModule)();
    await validatePreparedRunArtifactPaths(runPaths);
    const subjectDesktop = await this.sandbox.acquire({
      module: subjectModule,
      apiKey: e2bApiKey,
      requestTimeoutMs,
      sessionTimeoutMs: timeoutMs,
      seed: clone.state?.seed ?? [],
      metadata: {
        mode: "scripted-browser-lab",
        tool: "humanish",
        labId: plan.studyId,
        kind: "subject",
        actor: plan.actor,
      },
      envs: Object.fromEntries(subjectEnvNames.map((name) => [name, env[name] as string])),
      template: plan.residual.execution?.desktop?.template,
      root: runPaths,
    });

    if (prepareDesktop) {
      await prepareDesktop(subjectDesktop, { kind: "subject" });
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
        "the installed @e2b/desktop SDK does not expose getHost(port); clone scripted-browser studies require it to reach the provisioned subject",
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
}
