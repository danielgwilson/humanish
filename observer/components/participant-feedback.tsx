import { useState } from "react";
import { CLOSING_REPORT_LIMITS } from "../../src/actors/closing-report-limits.js";
import { traceItems } from "../../src/run/run-clock.js";
import type { ObserverData, ObserverStream } from "@/lib/observer-data";
import { RecordedEntryLink } from "./recorded-entry-link";

const closingAccount = (
  value: unknown,
): value is { summary: string; frictionReports: string[] } => {
  if (!value || typeof value !== "object") return false;
  const report = value as Record<string, unknown>;
  return (
    typeof report.summary === "string" &&
    Array.isArray(report.frictionReports) &&
    report.frictionReports.length <= CLOSING_REPORT_LIMITS.frictionReports &&
    report.frictionReports.every((item) => typeof item === "string")
  );
};

/** The impression kinds in the order the Observer lists them, each with its plain heading. */
const IMPRESSION_GROUPS = [
  { kind: "unclear", label: "Confusing or hard to read" },
  { kind: "unfinished", label: "Looked broken or unfinished" },
  { kind: "untrustworthy", label: "Made them hesitate to trust it" },
  { kind: "liked", label: "Worked well" },
  { kind: "missing", label: "Expected and not found" },
  { kind: "unlike_my_work", label: "Different from how they do it" },
] as const;

type Impressions = NonNullable<NonNullable<ObserverStream["actor"]>["impressions"]>;

const readImpressions = (value: unknown): Impressions | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.status === "not_collected")
    return typeof record.reason === "string" ? (record as Impressions) : null;
  return record.status === "collected" &&
    Array.isArray(record.items) &&
    record.items.length <= CLOSING_REPORT_LIMITS.impressions &&
    record.items.every((item: unknown) => {
      const entry = item as Record<string, unknown> | null;
      return (
        typeof entry?.text === "string" &&
        typeof entry.messageId === "string" &&
        IMPRESSION_GROUPS.some((group) => group.kind === entry.kind)
      );
    })
    ? (record as Impressions)
    : null;
};

/** What the participant said about the product at the end, grouped by kind. */
function ImpressionsAtEnd({
  data,
  streamId,
  value,
}: {
  data: ObserverData;
  streamId: string;
  value: unknown;
}) {
  const impressions = readImpressions(value);
  return (
    <section className="impressions blk" aria-label="What they said at the end">
      <h3 className="o-label">What they said at the end</h3>
      {impressions === null ? (
        <p className="verbatim dim">The recorded impressions could not be read.</p>
      ) : impressions.status === "not_collected" ? (
        <p className="verbatim dim">Not collected: {impressions.reason}.</p>
      ) : impressions.items.length === 0 ? (
        <p className="verbatim dim">They named none.</p>
      ) : (
        IMPRESSION_GROUPS.map(({ kind, label }) => {
          const items = impressions.items.filter((item) => item.kind === kind);
          return items.length === 0 ? null : (
            <section key={kind} className="impression-group" aria-label={label}>
              <h4>{label}</h4>
              <ul>
                {items.map((item) => (
                  <li key={item.messageId}>
                    <p className="verbatim">{item.text}</p>
                    <RecordedEntryLink data={data} streamId={streamId} eventId={item.messageId}>
                      Open recorded impression
                    </RecordedEntryLink>
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
    </section>
  );
}

/** Original source accounts, not generated analysis or inferred participant truth. */
export function ParticipantFeedback({
  data,
  stream,
}: {
  data: ObserverData;
  stream: ObserverStream;
}) {
  const rawDebrief: unknown = stream.actor?.debrief?.report;
  const debrief = closingAccount(rawDebrief) ? rawDebrief : null;
  const messageId =
    typeof stream.actor?.debrief?.messageId === "string" ? stream.actor.debrief.messageId : null;
  const rawImpressions: unknown = stream.actor?.impressions;
  const impressions = readImpressions(rawImpressions);
  const impressionIds = new Set(
    impressions?.status === "collected" ? impressions.items.map((item) => item.messageId) : [],
  );
  const messages = traceItems(stream).filter(
    (item) =>
      item.kind === "message" &&
      item.text?.trim() &&
      !(debrief && item.id === messageId) &&
      !impressionIds.has(item.id),
  );
  const [page, setPage] = useState(0);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(messages.length / 20) - 1));
  const start = Math.max(0, messages.length - (currentPage + 1) * 20),
    end = Math.max(0, messages.length - currentPage * 20);
  return (
    <section className="participant-feedback" aria-label="Original participant feedback">
      {debrief ? (
        <div className="blk">
          <h3 className="o-label">Closing account, verbatim</h3>
          <p className="verbatim">{debrief.summary}</p>
          {debrief.frictionReports.length ? (
            <ul>
              {debrief.frictionReports.map((text, index) => (
                <li key={index} className="verbatim">
                  {text}
                </li>
              ))}
            </ul>
          ) : null}
          {messageId ? (
            <RecordedEntryLink data={data} streamId={stream.id} eventId={messageId}>
              Open recorded closing account
            </RecordedEntryLink>
          ) : null}
        </div>
      ) : rawDebrief !== undefined ? (
        <p role="status">
          The recorded closing account could not be read. Original statements remain below.
        </p>
      ) : null}
      {rawImpressions === undefined ? null : (
        <ImpressionsAtEnd data={data} streamId={stream.id} value={rawImpressions} />
      )}
      <h3 className="o-label">
        Participant statements · {messages.length > 20 ? `${start + 1}–${end} of ` : ""}
        {messages.length}
      </h3>
      {messages.slice(start, end).map((item) => (
        <div className="blk" key={item.id} data-feedback-entry={item.id}>
          <p className="o-label">
            {item.title}
            {item.at ? (
              <>
                {" "}
                · <time className="statement-time">{item.at}</time>
              </>
            ) : null}
          </p>
          <p className="verbatim">{item.text}</p>
          <RecordedEntryLink data={data} streamId={stream.id} eventId={item.id}>
            Open recorded statement
          </RecordedEntryLink>
        </div>
      ))}
      {!messages.length && !debrief ? (
        <p className="verbatim dim">No participant account was retained.</p>
      ) : null}
      {messages.length > 20 ? (
        <nav aria-label="Participant account pages">
          <button
            type="button"
            className="review-tool"
            disabled={!start}
            onClick={() => setPage(currentPage + 1)}
          >
            Earlier accounts
          </button>
          <button
            type="button"
            className="review-tool"
            disabled={!currentPage}
            onClick={() => setPage(currentPage - 1)}
          >
            Later accounts
          </button>
        </nav>
      ) : null}
    </section>
  );
}
