import { verifyRun } from "../../src/run/verify.js";

/** One run's verify result as a golden holds it: the verdict and each failing check, in report order. */
export interface PinnedVerifyResult {
  ok: boolean;
  failing: Array<{ name: string; message: string }>;
}

/**
 * Run verify and keep the failing checks with their full messages. A findings check joins every
 * finding in order, so the message pins both the text and the order. The run id and project path
 * are replaced, because both differ per run.
 */
export async function pinnedVerifyResult(cwd: string, runId: string): Promise<PinnedVerifyResult> {
  const verify = await verifyRun(cwd, runId);
  const scrub = (text: string) => text.split(runId).join("[run]").split(cwd).join("[cwd]");
  return {
    ok: verify.ok,
    failing: verify.checks
      .filter((check) => !check.ok)
      .map((check) => ({ name: check.name, message: scrub(check.message) })),
  };
}

/** The golden file body for a list of named variants. */
export function verifyGolden(
  entries: ReadonlyArray<readonly [string, PinnedVerifyResult]>,
): string {
  return `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`;
}

/**
 * Concurrent bundle mutations for the verify goldens. No overclaim test reaches the lane-window or
 * role-coverage checks, so these make each of them report at least one finding.
 */
export const LANE_SHAPE_VARIANTS: ReadonlyArray<
  readonly [string, (bundle: Record<string, unknown>) => void]
> = [
  [
    "the second laneWindow ends before it starts",
    (bundle) => {
      const w = (bundle.sharedWorld as { laneWindows: Array<Record<string, number>> })
        .laneWindows[1]!;
      w.endedAt = w.startedAt! - 1;
    },
  ],
  [
    "the second laneWindow records a malformed routeHostDigest",
    (bundle) => {
      (
        bundle.sharedWorld as { laneWindows: Array<Record<string, unknown>> }
      ).laneWindows[1]!.routeHostDigest = "not-a-digest";
    },
  ],
  [
    "the third laneWindow names an unknown simulation and stream",
    (bundle) => {
      const w = (bundle.sharedWorld as { laneWindows: Array<Record<string, unknown>> })
        .laneWindows[2]!;
      w.simId = "sim-999";
      w.streamId = "stream-999";
    },
  ],
  [
    "one outcome is dropped",
    (bundle) => {
      (bundle.sharedWorld as { outcomes: unknown[] }).outcomes.pop();
    },
  ],
];
