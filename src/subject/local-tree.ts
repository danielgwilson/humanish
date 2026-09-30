import { failureTail } from "../evidence/redaction.js";
import type { LabSubjectServe, LabSubjectState } from "../lab/types.js";
import type { RunSubjectStateStepRecord } from "../run/bundle.js";
import { toErrorMessage } from "../substrates/command-failure.js";
import { runDetachedStep, type DetachedTimers } from "../substrates/detached.js";
import type { Shell } from "../substrates/shell.js";
import { runSubjectServePipeline } from "./serve.js";
import {
  CLONE_TIMEOUT_MS,
  emitPhaseCompleted,
  emitPhaseStarted,
  SUBJECT_DIR,
  type SubjectPhaseEvent,
} from "./steps.js";

// Remote path for the once-per-run packed local-tree archive; removed by the extract step
// after it unpacks into SUBJECT_DIR.
const LOCAL_TREE_REMOTE_ARCHIVE_PATH = "/home/user/.humanish-source.tar.gz";

/**
 * Provision a local-tree subject inside the sandbox: upload the once-per-run packed archive
 * (identical bytes across every fan-out lane) → extract it into SUBJECT_DIR → the
 * same shared serve pipeline provisionCloneSubject uses. Unlike the clone route there is no
 * in-sandbox git refresh: the archive excludes .git entirely (see source-archive.ts), so
 * subject identity is the host-side LocalTreeArchive captured at pack time, never anything
 * resolved in-sandbox.
 */
export async function provisionLocalTreeSubject(
  shell: Shell,
  args: {
    /** The once-per-run packed archive bytes (shared byte-identically across every lane). */
    archiveBuffer: ArrayBuffer;
    serve: LabSubjectServe;
    /** Declared subject state (seed steps; external declaration is provenance-only). */
    state?: LabSubjectState;
    requestTimeoutMs: number;
    /** Literal scrubber for known provisioned values, applied to log tails PRE-truncation. */
    scrub: (text: string) => string;
    /** Called the moment each state step finishes, success or failure. */
    onStateStep?: (record: RunSubjectStateStepRecord) => void;
    /** Called at each phase boundary (started/completed): upload, extract, install, build,
     *  serve start, ready, and each subject.state seed-step group. */
    onPhase?: (event: SubjectPhaseEvent) => void;
  } & DetachedTimers,
): Promise<void> {
  const timers: DetachedTimers = {
    ...(args.now === undefined ? {} : { now: args.now }),
    ...(args.sleep === undefined ? {} : { sleep: args.sleep }),
  };
  const now = args.now ?? Date.now;

  const uploadStartedAt = now();
  emitPhaseStarted(args.onPhase, now, "upload", "uploading packed local-tree archive");
  try {
    await shell.writeFile(LOCAL_TREE_REMOTE_ARCHIVE_PATH, args.archiveBuffer, {
      requestTimeoutMs: args.requestTimeoutMs,
      retryOnce: {
        onRetry: (reason) =>
          emitPhaseStarted(
            args.onPhase,
            now,
            "upload-retry",
            `local-tree archive upload retried once (${failureTail(args.scrub(reason))})`,
          ),
        ...(args.sleep === undefined ? {} : { sleep: args.sleep }),
      },
    });
  } catch (error) {
    emitPhaseCompleted(
      args.onPhase,
      now,
      uploadStartedAt,
      "upload",
      false,
      "local-tree archive upload failed",
    );
    throw new Error(`subject-upload failed: ${failureTail(args.scrub(toErrorMessage(error)))}`);
  }
  emitPhaseCompleted(
    args.onPhase,
    now,
    uploadStartedAt,
    "upload",
    true,
    "local-tree archive uploaded",
  );

  const extractCommand = `rm -rf ${SUBJECT_DIR} && mkdir -p ${SUBJECT_DIR} && tar -xzf ${LOCAL_TREE_REMOTE_ARCHIVE_PATH} -C ${SUBJECT_DIR} && rm -f ${LOCAL_TREE_REMOTE_ARCHIVE_PATH}`;
  const extractStartedAt = now();
  emitPhaseStarted(args.onPhase, now, "extract", "extracting local-tree archive");
  const extract = await runDetachedStep(shell, {
    name: "subject-extract",
    command: extractCommand,
    timeoutMs: CLONE_TIMEOUT_MS,
    requestTimeoutMs: args.requestTimeoutMs,
    ...timers,
  });
  emitPhaseCompleted(
    args.onPhase,
    now,
    extractStartedAt,
    "extract",
    extract.ok,
    extract.ok ? "local-tree archive extracted" : "local-tree archive extraction failed",
  );
  if (!extract.ok) {
    throw new Error(
      `subject extract ${extract.timedOut ? "timed out" : `failed (exit ${extract.exitCode})`}: ${failureTail(args.scrub(extract.logTail))}`,
    );
  }

  await runSubjectServePipeline(shell, {
    serve: args.serve,
    ...(args.state === undefined ? {} : { state: args.state }),
    requestTimeoutMs: args.requestTimeoutMs,
    scrub: args.scrub,
    ...(args.onStateStep === undefined ? {} : { onStateStep: args.onStateStep }),
    ...(args.onPhase === undefined ? {} : { onPhase: args.onPhase }),
    ...timers,
  });
}
