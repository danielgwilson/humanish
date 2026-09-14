import { useState } from "react";
import { traceItems } from "@/lib/artifact-href";
import type { ObserverData, ObserverStream } from "@/lib/observer-data";
import { RecordedEntryLink } from "./recorded-entry-link";

const closingAccount = (value: unknown): value is { summary: string; frictionReports: string[] } => {
  if (!value || typeof value !== "object") return false;
  const report = value as Record<string, unknown>;
  return typeof report.summary === "string" && Array.isArray(report.frictionReports)
    && report.frictionReports.length <= 1000 && report.frictionReports.every((item) => typeof item === "string");
};

/** Original source accounts, not generated analysis or inferred participant truth. */
export function ParticipantFeedback({ data, stream }: { data: ObserverData; stream: ObserverStream }) {
  const rawDebrief: unknown = stream.actor?.debrief?.report;
  const debrief = closingAccount(rawDebrief) ? rawDebrief : null;
  const messageId = typeof stream.actor?.debrief?.messageId === "string" ? stream.actor.debrief.messageId : null;
  const messages = traceItems(stream).filter((item) => item.kind === "message" && item.text?.trim() && !(debrief && item.id === messageId));
  const [page, setPage] = useState(0);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(messages.length / 20) - 1));
  const start = Math.max(0, messages.length - (currentPage + 1) * 20), end = Math.max(0, messages.length - currentPage * 20);
  return <section className="participant-feedback" aria-label="Original participant feedback">
    {debrief ? <div className="blk"><h3 className="o-label">Closing account, verbatim</h3><p className="verbatim">{debrief.summary}</p>{debrief.frictionReports.length ? <ul>{debrief.frictionReports.map((text, index) => <li key={index} className="verbatim">{text}</li>)}</ul> : null}{messageId ? <RecordedEntryLink data={data} streamId={stream.id} eventId={messageId}>Open recorded closing account</RecordedEntryLink> : null}</div> : rawDebrief !== undefined ? <p role="status">The recorded closing account could not be read. Original statements remain below.</p> : null}
    <h3 className="o-label">Participant statements · {messages.length > 20 ? `${start + 1}–${end} of ` : ""}{messages.length}</h3>
    {messages.slice(start, end).map((item) => <div className="blk" key={item.id} data-feedback-entry={item.id}>
      <p className="o-label">{item.title}{item.at ? <> · <time className="statement-time">{item.at}</time></> : null}</p><p className="verbatim">{item.text}</p><RecordedEntryLink data={data} streamId={stream.id} eventId={item.id}>Open recorded statement</RecordedEntryLink>
    </div>)}
    {!messages.length && !debrief ? <p className="verbatim dim">No participant account was retained.</p> : null}
    {messages.length > 20 ? <nav aria-label="Participant account pages"><button type="button" className="review-tool" disabled={!start} onClick={() => setPage(currentPage + 1)}>Earlier accounts</button><button type="button" className="review-tool" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Later accounts</button></nav> : null}
  </section>;
}
