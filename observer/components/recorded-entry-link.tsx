import type { ReactNode } from "react";
import type { ObserverData } from "@/lib/observer-data";
import { formatHash, pushHash } from "@/lib/route";
import { resolveReportMoment } from "@/lib/study-report";

/** Keep the current recording origin for an in-recording citation; copied links
 * retain an ordinary participant address without borrowing that local origin. */
export function RecordedEntryLink({ data, streamId, eventId, children }: { data: ObserverData; streamId: string; eventId: string; children: ReactNode }) {
  const moment = resolveReportMoment(data, streamId, eventId);
  if (!moment) return <span>Evidence unavailable</span>;
  const href = formatHash(streamId, moment.frameIndex, null, moment.eventId);
  return <a href={href} onClick={(event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); pushHash(href, window.history.state); window.dispatchEvent(new HashChangeEvent("hashchange"));
  }}>{children}</a>;
}
