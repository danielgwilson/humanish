import { liveEmbedUrl } from "@/lib/live";
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
  } else if (data.cost && data.cost.estimatedTotalUsd === null) {
    // Declared-absent cost stays visible (legacy intent, migrated at cutover):
    // a missing line reads as free; "not estimated" reads as what it is.
    parts.push("cost not estimated");
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
  // Live thumbs autoconnect for the first few live lanes only (#331): every live
  // thumb is a real socket to a real desktop, so a wide fan-out must not open one
  // per card. Deeper lanes keep the placeholder and their Live chip; the player
  // always streams on open.
  const liveThumbIds = new Set(
    streams.filter((stream) => liveEmbedUrl(stream) !== null).slice(0, 4).map((stream) => stream.id)
  );
  return (
    <section aria-label="Study grid">
      <p className="countline">{buildTally(data)}</p>
      {streams.length === 0 ? (
        <p className="countline">No participants match the current filters.</p>
      ) : (
        <div className="gallery">
          {streams.map((stream) => (
            <ParticipantCard
              key={stream.id}
              stream={stream}
              onOpen={onOpen}
              liveThumb={liveThumbIds.has(stream.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
