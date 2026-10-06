import { ageLabel, isActiveStream } from "@/lib/live";
import type { ObserverData } from "@/lib/observer-data";
import type { ObserverConnection } from "@/lib/use-observer-feed";

/** One notice for a served page whose server went away, in place of a failure on every tile. */
export function ServerStoppedNotice({
  data,
  connection,
  now,
  onRetry,
}: {
  data: ObserverData;
  connection: ObserverConnection;
  now: number;
  onRetry: () => void;
}) {
  const runId = data.run.runId;
  const running = data.runtime?.state !== "finished" && data.streams.some(isActiveStream);
  return (
    <section className="server-stopped" role="alert" aria-labelledby="server-stopped-title">
      <h2 id="server-stopped-title">The Observer server stopped answering</h2>
      <p>
        {running
          ? `At the last update, ${ageLabel(connection.lastReceivedAt, now)}, the run was still running. Whatever it recorded is in its folder on disk.`
          : "The run had ended, so its recording on disk is complete."}{" "}
        This page loads captures from that server, so it cannot show them until a server answers
        again.
      </p>
      <p>
        To review run <code>{runId}</code>, run <code>humanish observe --run {runId}</code> in the
        project folder, or open <code>.humanish/runs/{runId}/observer/index.html</code> from disk.
      </p>
      <button type="button" className="review-tool" onClick={onRetry}>
        Retry
      </button>
    </section>
  );
}
