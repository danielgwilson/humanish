import RepairStudy from "./repair-study";
import ReplayPlayer from "./tour/replay-player";
import { RECEIPTS } from "@/lib/site-data";
import type { TourData } from "@/lib/tour-types";
import tryLiveJson from "@/lib/tour/try-live.json";

const tryLive = tryLiveJson as unknown as TourData;

/**
 * The study band, refreshed: the TodoMVC repair stays as shipped; the 2026-08-07
 * Excalidraw replay is replaced by two runs from 2026-09-16 rendered from their own
 * traces (the drawDB starter run in the replay player, the maintainer's lobby game as a
 * three-seat grid; the game is the maintainer's own and is not named in this repo), and
 * the persona-axis result joins the repair as a second two-column study. Every number is read from a kept bundle or a linked receipt.
 */
export default function StudyV3() {
  const lane = tryLive.lanes[0]!;
  return (
    <section id="study" className="band band-mineral">
      <div className="study-block">
      <p className="repair-kicker rev">One run, start to finish · drawDB · 2026-09-16 · starter study</p>
      <h2 className="rev" style={{ "--d": ".05s" } as React.CSSProperties}>See what a first-time user did, <em>click by click</em></h2>
      <p className="sec-sub rev" style={{ "--d": ".1s" } as React.CSSProperties}>The starter study from a fresh install. One participant, driven by Codex signed in on the operator&rsquo;s machine, got a hosted desktop, a commit-pinned clone of drawDB and one task: add two tables and name them. Every frame below comes from that run&rsquo;s bundle.</p>

      <dl className="manifest rev" style={{ "--d": ".15s" } as React.CSSProperties}>
        <div><dt>Source</dt><dd>.humanish/runs/{tryLive.runId}</dd><dd className="dd-sub">gitignored · the same directory your own runs write to</dd></div>
        <div><dt>Date</dt><dd>2026-09-16</dd></div>
        <div><dt>Subject</dt><dd>drawdb-io/drawdb · commit-pinned</dd></div>
        <div><dt>Participant</dt><dd>1/1 reached the goal</dd></div>
        <div><dt>Verify</dt><dd>16/16 checks</dd></div>
        <div><dt>Status</dt><dd><span className="chip chip-dot chip-mute">local_only</span></dd></div>
        <div><dt>Wall-clock</dt><dd>4m 25s incl. analysis</dd></div>
        <div><dt>Est. cost</dt><dd>~$0.02 desktop · model unpriced (local agent)</dd></div>
      </dl>

      <div className="study-stage rev">
        <ReplayPlayer slug="try-live" lane={lane} frameSize={{ w: 1440, h: 950 }} label={`Participant 01 · drawDB · ${lane.counts?.screenshots ?? 8} captures · ${lane.counts?.actions ?? 14} actions`} />
        <p className="study-open"><a href="/runs/try-live/observer/index.html#/lane/stream-001/f/1" target="_blank" rel="noopener">Open this run in Observer ↗</a><span>Participants, the three findings from <code>humanish analyze</code>, every frame addressable.</span></p>
      </div>

      </div>

      <div className="study-block">
      <section className="repair-study study-axis" aria-labelledby="axis-title">
        <div>
          <p className="repair-kicker">The finding · drawDB · TodoMVC · Excalidraw · September 1 to 4, 2026</p>
          <h2 id="axis-title">Find out which kind of user <em>your app blocks</em></h2>
          <blockquote className="repair-quote">
            <p>&ldquo;no keyboard-accessible database options &hellip; Confirm remains disabled&rdquo;</p>
            <footer>drawDB · keyboard-first participant · run cua-2026-09-03T21-17-11-267Z-bde2251d</footer>
          </blockquote>
          <p className="repair-copy">The same mission went to a keyboard-first power user and a mouse-driving newcomer. The persona is a declared trait; the trace records which actions used the keyboard and which used the pointer.</p>
        </div>
        <div className="repair-results">
          <table>
            <caption>Blocked or stopped, by participant kind</caption>
            <thead><tr><th scope="col">App · mission</th><th scope="col">Keyboard-first</th><th scope="col">Mouse newcomer</th></tr></thead>
            <tbody>
              <tr><th scope="row">drawDB · two related tables</th><td>5<span> / 5</span></td><td>0<span> / 5</span></td></tr>
              <tr><th scope="row">TodoMVC · add, rename, filter</th><td>6<span> / 6</span></td><td>0<span> / 6</span></td></tr>
            </tbody>
          </table>
          <p className="axis-note"><b>The control:</b> Excalidraw, two boxes and an arrow. 12 of 12 participants of every kind reached the goal.</p>
          <p className="repair-copy">Keyboard-first participants reported drawDB&rsquo;s database modal 5 of 5 times and were blocked at TodoMVC&rsquo;s double-click rename 6 of 6 times; no mouse newcomer was. Two to six runs per cell. A blocked synthetic participant identifies a place in the app to check; it does not estimate how many people would be blocked.</p>
          <div className="repair-links">
            <a href={`${RECEIPTS}/persona-contrast-live-2026-09-01.md`} rel="noopener">drawDB receipt →</a>
            <a href={`${RECEIPTS}/persona-contrast-todomvc-2026-09-01.md`} rel="noopener">TodoMVC receipt →</a>
            <a href={`${RECEIPTS}/persona-axis-phone-2026-09-03.md`} rel="noopener">Excalidraw control →</a>
          </div>
        </div>
      </section>
      </div>

      <div className="study-block">
      <RepairStudy />
      </div>

      <div className="study-notes rev">
        <p>Verify passed 16/16 on the drawDB run, and the bundle still grades <code>local_only</code>: it holds full-fidelity screenshots, which the share-safety gate never marks share-ready as-is. These captures were reviewed by hand before publication.</p>
        <p>drawDB, TodoMVC and Excalidraw are the applications studied; none is a Humanish adopter or endorser. The lobby game is the maintainer&rsquo;s own.</p>
      </div>
    </section>
  );
}
