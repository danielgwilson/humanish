import type { ObserverData } from "@/lib/observer-data";
import type { ObserverConnection } from "@/lib/use-observer-feed";
import { RunStatus } from "./run-status";
import { ServerStoppedNotice } from "./server-stopped";

/**
 * The run's state above the evidence, when it needs one: the stopped-server notice, or the full run
 * status while the feed is retrying, the run is interrupted or unconfirmed, or the grid is in
 * monitor mode (with the way out of it). The top bar always carries the compact status.
 */
export function StudyNotices({
  data,
  connection,
  now,
  onRetry,
  monitoring,
  onExitMonitor,
}: {
  data: ObserverData;
  connection: ObserverConnection;
  now: number;
  onRetry: () => void;
  monitoring: boolean;
  onExitMonitor: () => void;
}) {
  const needsAttention =
    connection.state === "retrying" ||
    data.runtime?.state === "unknown" ||
    data.runtime?.state === "interrupted";
  return (
    <>
      {connection.serverStopped ? (
        <ServerStoppedNotice data={data} connection={connection} now={now} onRetry={onRetry} />
      ) : null}
      {(needsAttention && !connection.serverStopped) || monitoring ? (
        <RunStatus
          data={data}
          connection={connection}
          now={now}
          onRetry={onRetry}
          actions={
            monitoring ? (
              <button type="button" className="review-tool" onClick={onExitMonitor}>
                Exit monitor
              </button>
            ) : null
          }
        />
      ) : null}
    </>
  );
}
