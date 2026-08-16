import type { ObserverData, ObserverStream } from "@/lib/observer-data";

import { ParticipantCard } from "./participant-card";

// One Frame.io-style tally line above the grid — context without banners (#426).
// Every number renders with its denominator or not at all; the pre-formatted
// participantsLine/tasksLine from the contract already guarantee that.
export function buildTally(data: ObserverData): string {
  const parts: string[] = [
    data.run.participantsLine ??
      `${data.summary.streams} participant${data.summary.streams === 1 ? "" : "s"}`,
  ];
  if (data.run.tasksLine !== undefined) parts.push(data.run.tasksLine);
  if (data.summary.active > 0) parts.push(`${data.summary.active} active`);
  if (data.summary.blocked > 0) parts.push(`${data.summary.blocked} blocked`);
  if (data.summary.warnings > 0) parts.push(`${data.summary.warnings} warnings`);
  parts.push(data.run.mode);
  if (data.cost && typeof data.cost.estimatedTotalUsd === "number") {
    parts.push(
      `est. ~$${data.cost.estimatedTotalUsd.toFixed(2)} (rates as of ${data.cost.ratesAsOf}${
        data.cost.placeholder ? ", placeholder" : ""
      })`
    );
  }
  return parts.join(" · ");
}

export function StudyGrid({
  data,
  streams,
  onOpen
}: {
  data: ObserverData;
  streams: ObserverStream[];
  onOpen: (id: string) => void;
}) {
  return (
    <section aria-label="Study grid">
      <p className="countline">{buildTally(data)}</p>
      {streams.length === 0 ? (
        <p className="countline">No participants match the current filters.</p>
      ) : (
        <div className="gallery">
          {streams.map((stream) => (
            <ParticipantCard key={stream.id} stream={stream} onOpen={onOpen} />
          ))}
        </div>
      )}
    </section>
  );
}
