import { useState } from "react";
import type { ObserverStream } from "@/lib/observer-data";

const PAGE_SIZE = 40;

/** Run events have no capture reference; their timestamps must not create one. */
export function PlayerRunNotices({ notices }: { notices: ObserverStream["timeline"] }) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(notices.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const start = currentPage * PAGE_SIZE;
  return <section className="player-run-notices" aria-label="Run and setup notices">
    <h3>Run and setup notices ({notices.length})</h3>
    <p>Recorded run events, separate from participant trace findings. These notices have no linked capture.</p>
    <ol start={start + 1}>{notices.slice(start, start + PAGE_SIZE).map((notice) => {
      const at = Date.parse(notice.at);
      return <li key={notice.id}>
        <div className="run-notice-heading"><strong>{notice.level === "error" ? "Error" : "Warning"}</strong>
          {Number.isFinite(at) ? <time dateTime={notice.at}>{new Date(at).toLocaleString()}</time> : <span>Time unavailable</span>}
        </div>
        <p className="run-notice-message">{notice.message}</p>
      </li>;
    })}</ol>
    {pageCount > 1 ? <nav className="run-notices-pages" aria-label="Run notice pages">
      <button type="button" className="tbtn" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous notices</button>
      <span>{start + 1}–{Math.min(start + PAGE_SIZE, notices.length)} of {notices.length}</span>
      <button type="button" className="tbtn" disabled={currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)}>Next notices</button>
    </nav> : null}
  </section>;
}
