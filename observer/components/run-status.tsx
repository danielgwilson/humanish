import type { ReactNode } from "react";
import { ageLabel, isActiveStream, sourceUpdatedAt } from "@/lib/live";
import type { ObserverData } from "@/lib/observer-data";
import type { ObserverConnection } from "@/lib/use-observer-feed";

export function RunStatus({
  data,
  connection,
  now,
  onRetry,
  actions,
  compact = false,
}: {
  data: ObserverData;
  connection: ObserverConnection;
  now: number;
  onRetry: () => void;
  actions?: ReactNode;
  compact?: boolean;
}) {
  const runtime = data.runtime;
  const active = data.streams.filter(isActiveStream).length;
  // A participant queued for a later start keeps the run going without counting as active.
  const going = active > 0 || data.streams.some((stream) => stream.status === "queued");
  const interrupted = runtime?.state === "interrupted";
  const staleProcess = runtime?.state === "unknown" || interrupted;
  const ended = runtime?.state === "finished";
  const offline = connection.state === "offline";
  const failed = connection.state === "retrying";
  // The participants ended and the run's process is writing the findings.
  const analysisStarted =
    ended && !offline && runtime?.analysis ? Date.parse(runtime.analysis.startedAt) : null;
  const updated = sourceUpdatedAt(data);
  const date = Date.parse(data.run.createdAt);
  const recordedDate = Number.isFinite(date)
    ? new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : "date unavailable";
  const status = offline
    ? "Saved recording"
    : failed && going
      ? "Last seen running"
      : interrupted
        ? "Run interrupted"
        : staleProcess
          ? "Run status unconfirmed"
          : analysisStarted !== null
            ? "Writing findings"
            : ended
              ? "Run ended"
              : going
                ? "Running"
                : "Finished";
  return (
    <div
      className={`run-status${compact ? " run-status-compact" : ""}${failed || staleProcess ? " needs-attention" : ""}`}
    >
      <div className="run-status-main">
        <span
          className={
            (going && !offline && !staleProcess && !ended && !failed) || analysisStarted !== null
              ? "status-dot active"
              : "status-dot"
          }
          aria-hidden="true"
        />
        <strong>{status}</strong>
        <span>
          {analysisStarted !== null
            ? `Participants finished · analysis started ${ageLabel(analysisStarted, now)}`
            : going && !offline && !ended && !staleProcess && !failed
              ? `${active} of ${data.streams.length} participants active`
              : `Recorded ${recordedDate}${offline ? " · no updates" : ""}`}
        </span>
        {data.run.mode === "dry-run" ? <span className="chip chip-mute">Dry run</span> : null}
      </div>
      {actions}
      {!offline ? (
        <div className="run-status-update" role="status" aria-live="off">
          {failed ? (
            <>
              {connection.serverStopped ? "Server stopped" : "Updates unavailable"} · last received{" "}
              {ageLabel(connection.lastReceivedAt, now)}{" "}
              <button type="button" onClick={onRetry}>
                Retry
              </button>
            </>
          ) : connection.state === "connecting" ? (
            "Checking for updates…"
          ) : (
            <>
              Evidence updated {ageLabel(updated, now)}
              {staleProcess && !interrupted ? " · process status is not current" : ""}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
