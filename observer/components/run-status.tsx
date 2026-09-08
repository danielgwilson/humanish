import { ageLabel, isActiveStream, sourceUpdatedAt } from "@/lib/live";
import type { ObserverData } from "@/lib/observer-data";
import type { ObserverConnection } from "@/lib/use-observer-feed";

export function RunStatus({ data, connection, now, onRetry }: { data: ObserverData; connection: ObserverConnection; now: number; onRetry: () => void }) {
  const runtime = data.runtime;
  const active = data.streams.filter(isActiveStream).length;
  const staleProcess = runtime?.state === "unknown" || runtime?.state === "interrupted";
  const ended = runtime?.state === "finished";
  const offline = connection.state === "offline";
  const failed = connection.state === "retrying";
  const updated = sourceUpdatedAt(data);
  const date = Date.parse(data.run.createdAt);
  const recordedDate = Number.isFinite(date) ? new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "date unavailable";
  const status = offline ? "Offline recording" : failed && active > 0 ? "Last seen running" : staleProcess ? "Run status unconfirmed" : ended ? "Run ended" : active > 0 ? "Running" : "Finished";
  return <div className={`run-status${failed || staleProcess ? " needs-attention" : ""}`}>
    <div className="run-status-main"><span className={active > 0 && !offline && !staleProcess && !ended && !failed ? "status-dot active" : "status-dot"} aria-hidden="true" />
      <strong>{status}</strong><span>{active > 0 && !offline && !ended && !staleProcess && !failed ? `${active} of ${data.streams.length} participants active` : `Recorded ${recordedDate}`}</span>
      {data.run.mode === "dry-run" ? <span className="chip chip-mute">Dry run</span> : null}
    </div>
    <div className="run-status-update" role="status" aria-live="off">
      {offline ? "Saved evidence · no updates" : failed ? <>Updates unavailable · last received {ageLabel(connection.lastReceivedAt, now)} <button type="button" onClick={onRetry}>Retry</button></>
        : connection.state === "connecting" ? "Checking for updates…"
          : <>Evidence updated {ageLabel(updated, now)}{staleProcess ? " · process status is not current" : ""}</>}
    </div>
  </div>;
}
