import { failureTail } from "../evidence/redaction.js";
import type { LabSubjectServe, LabSubjectState } from "../lab/types.js";
import type { RunSubjectStateStepRecord } from "../run/bundle.js";
import { runDetachedStep, type DetachedTimers } from "../substrates/detached.js";
import { runOrThrow, type Shell } from "../substrates/shell.js";
import { runSubjectServePipeline, serveProvisioningBudgetMs } from "./serve.js";
import {
  CLONE_TIMEOUT_MS,
  emitPhaseCompleted,
  emitPhaseStarted,
  SUBJECT_DIR,
  type SubjectPhaseEvent,
} from "./steps.js";

/**
 * Provision a clone subject inside the sandbox: clone → the shared serve pipeline
 * (install → state(before-build) → build → state(before-start) → start → readiness
 * probe → state(after-ready)). Returns the latest subject HEAD after successful
 * provisioning. Throws (with a capped log tail for the caller to redact) on any failing step:
 * the lab persists that as a failed-evidence bundle.
 *
 * Auth: when GITHUB_TOKEN is among the declared subject env names, the clone authenticates
 * via an Authorization header computed IN-SANDBOX from the provisioned env: the token never
 * appears in the script text, the process argv beyond the transient git call, the clone URL,
 * or .git/config.
 */
/** The longest provisionCloneSubject can take with the lab's budgets: the clone, then serving. */
export function cloneProvisioningBudgetMs(
  serve: LabSubjectServe,
  state: LabSubjectState | undefined,
): number {
  return CLONE_TIMEOUT_MS + serveProvisioningBudgetMs(serve, state);
}

export async function provisionCloneSubject(
  shell: Shell,
  args: {
    repo: string;
    depth: number;
    serve: LabSubjectServe;
    /** Declared subject state (seed steps; external declaration is provenance-only). */
    state?: LabSubjectState;
    hasGithubToken: boolean;
    requestTimeoutMs: number;
    /** Literal scrubber for known provisioned values, applied to log tails PRE-truncation. */
    scrub: (text: string) => string;
    /** Called the moment the cloned commit resolves, so provenance survives later failures. */
    onCommit?: (commit: string) => void;
    /** Called the moment each state step finishes (mirrors onCommit), success or failure. */
    onStateStep?: (record: RunSubjectStateStepRecord) => void;
    /** Called at each phase boundary (started/completed): clone, install, build, serve start,
     *  ready, and each subject.state seed-step group. */
    onPhase?: (event: SubjectPhaseEvent) => void;
  } & DetachedTimers,
): Promise<string | undefined> {
  const timers: DetachedTimers = {
    ...(args.now === undefined ? {} : { now: args.now }),
    ...(args.sleep === undefined ? {} : { sleep: args.sleep }),
  };
  const now = args.now ?? Date.now;
  let latestCommit: string | undefined;
  const refreshCommit = async (): Promise<void> => {
    const head = await runOrThrow(
      shell,
      `git -C ${SUBJECT_DIR} rev-parse HEAD 2>/dev/null || true`,
      { requestTimeoutMs: args.requestTimeoutMs },
    );
    const commit = head.stdout.trim() || undefined;
    if (commit) {
      latestCommit = commit;
      args.onCommit?.(commit);
    }
  };

  const cloneCommand = args.hasGithubToken
    ? `auth=$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0) && git -c http.extraHeader="Authorization: Basic $auth" clone --depth ${args.depth} https://github.com/${args.repo}.git ${SUBJECT_DIR}`
    : `git clone --depth ${args.depth} https://github.com/${args.repo}.git ${SUBJECT_DIR}`;

  const cloneStartedAt = now();
  emitPhaseStarted(args.onPhase, now, "clone", "cloning subject repository");
  const clone = await runDetachedStep(shell, {
    name: "subject-clone",
    command: cloneCommand,
    timeoutMs: CLONE_TIMEOUT_MS,
    requestTimeoutMs: args.requestTimeoutMs,
    ...timers,
  });
  emitPhaseCompleted(
    args.onPhase,
    now,
    cloneStartedAt,
    "clone",
    clone.ok,
    clone.ok ? "subject repository cloned" : "subject clone failed",
  );
  if (!clone.ok) {
    throw new Error(
      `subject clone ${clone.timedOut ? "timed out" : `failed (exit ${clone.exitCode})`}: ${failureTail(args.scrub(clone.logTail))}`,
    );
  }

  await refreshCommit();

  await runSubjectServePipeline(shell, {
    serve: args.serve,
    ...(args.state === undefined ? {} : { state: args.state }),
    requestTimeoutMs: args.requestTimeoutMs,
    scrub: args.scrub,
    ...(args.onStateStep === undefined ? {} : { onStateStep: args.onStateStep }),
    ...(args.onPhase === undefined ? {} : { onPhase: args.onPhase }),
    onPhaseComplete: refreshCommit,
    ...timers,
  });

  return latestCommit;
}
