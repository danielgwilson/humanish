import type { RunIndexEntry } from "../../src/run/run-index.js";
import type { StudyRow } from "../../src/run/projection.js";
import type { TuiOptions } from "../../src/tui/contract.js";
import { projectData, type ProjectData } from "./project.js";

/** How long to wait for a started run to write its first record, and how often to look. */
const LAUNCH_RECORD_TIMEOUT_MS = 5_000;
const LAUNCH_RECORD_POLL_MS = 100;

/**
 * The started run with the project as read when it appeared, so the caller can publish that before
 * opening the run; or the message to show instead.
 */
type StartedStudy = { ok: true; runId: string; data: ProjectData } | { ok: false; message: string };

/** Start a study detached and wait up to five seconds for the run record it writes. */
export async function startStudy(
  { cwd, capabilities }: Pick<TuiOptions, "cwd" | "capabilities">,
  row: StudyRow,
  mode: "dry-run" | "live",
): Promise<StartedStudy> {
  const result = await capabilities.startRun({
    cwd,
    study: row.name,
    ...(row.path ? { manifestPath: row.path } : {}),
    mode,
  });
  if (!result.ok) return { ok: false, message: result.error.message };

  // Find the run this launch produced. A pid alone is not an identity: pids are recycled, and a
  // finished run keeps its pid in status.json forever, so a week-old record can carry the pid
  // the kernel just handed this child. The record must also be newer than the launch.
  const launchedMs = Date.parse(result.run.launchedAt);
  const isOurs = (run: RunIndexEntry): boolean => {
    if (run.pid !== result.run.pid) return false;
    const started = run.startedAt === undefined ? Number.NaN : Date.parse(run.startedAt);
    if (!Number.isFinite(started) || !Number.isFinite(launchedMs)) return false;
    // A second of slack for clock granularity between the two processes.
    return started >= launchedMs - 1_000;
  };

  const deadline = Date.now() + LAUNCH_RECORD_TIMEOUT_MS;
  for (;;) {
    const index = await capabilities.readRunIndex(cwd);
    const started = index.runs.find(isOurs);
    if (started !== undefined) {
      const studies = await capabilities.listStudies(cwd);
      return {
        ok: true,
        runId: started.runId,
        data: projectData(index, studies.studies, studies.retired),
      };
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, LAUNCH_RECORD_POLL_MS));
  }

  // Still nothing. The process may have died before writing anything, and the launch log is the
  // only account of that, so show it rather than leaving a silent gap.
  const log = await capabilities.readLaunchLog(result.run.logPath);
  return {
    ok: false,
    message:
      log === ""
        ? `${row.name} started (pid ${result.run.pid}) but has not reported in. Check ${result.run.logPath}.`
        : `${row.name} did not report in. Its log ends:\n${log.split("\n").slice(-3).join("\n")}`,
  };
}
