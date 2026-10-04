import RepairStudy from "./repair-study";
import ReplayPlayer from "./tour/replay-player";
import { RECEIPTS } from "@/lib/site-data";
import type { TourData } from "@/lib/tour-types";
import tryLiveJson from "@/lib/tour/try-live.json";

const tryLive = tryLiveJson as unknown as TourData;

/**
 * The study band: the drawDB starter run in the replay player, then the persona-axis result and
 * the TodoMVC repair as two-column studies. The run's frames and facts come from
 * lib/tour/try-live.json, which `pnpm site:tour` builds from the kept bundle; every number here is
 * read from it or from a linked receipt.
 */
export default function StudyV3() {
  const lane = tryLive.lanes[0]!;
  const facts = tryLive.facts;
  if (!facts)
    throw new Error("lib/tour/try-live.json has no facts; rebuild it with pnpm site:tour");
  return (
    <section id="study" className="band band-mineral">
      <div className="study-block">
        <p className="repair-kicker rev">
          Example 1 of 3 · drawDB · {facts.date} · one participant
        </p>
        <h2 className="rev" style={{ "--d": ".05s" } as React.CSSProperties}>
          Watch one study, <em>start to finish</em>
        </h2>
        <p className="sec-sub rev" style={{ "--d": ".1s" } as React.CSSProperties}>
          You&rsquo;ve built something, nobody outside the team has used it, and you&rsquo;d still
          like to know where a first-time user gets stuck. That is the situation humanish is for. So
          we did what you would do: pointed it at an app we don&rsquo;t maintain, drawDB, an
          open-source database diagram editor, gave one participant a persona and a single task (add
          two tables and name them), and ran it. Below is that run: every screen, every click, what
          the participant was thinking, and what came back.
        </p>

        <dl className="manifest rev" style={{ "--d": ".15s" } as React.CSSProperties}>
          <div>
            <dt>Source</dt>
            <dd>.humanish/runs/{tryLive.runId}</dd>
            <dd className="dd-sub">gitignored · the same directory your own runs write to</dd>
          </div>
          <div>
            <dt>Date</dt>
            <dd>{facts.date}</dd>
          </div>
          <div>
            <dt>Subject</dt>
            <dd>{facts.subject}</dd>
          </div>
          <div>
            <dt>Participant</dt>
            <dd>{facts.participants}</dd>
          </div>
          <div>
            <dt>Verify</dt>
            <dd>{facts.verifyChecks}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>
              <span className="chip chip-dot chip-mute">{facts.status}</span>
            </dd>
          </div>
          <div>
            <dt>Wall-clock</dt>
            <dd>{facts.wallClock}</dd>
          </div>
          <div>
            <dt>Est. cost</dt>
            <dd>{facts.cost}</dd>
          </div>
        </dl>

        <div className="study-stage rev">
          <ReplayPlayer
            slug="try-live"
            lane={lane}
            frameSize={facts.frameSize}
            label={`Participant 01 · drawDB · ${lane.counts?.screenshots ?? 8} captures · ${lane.counts?.actions ?? 14} actions`}
          />
          <p className="study-open">
            <a
              href="/runs/try-live/observer/index.html#/lane/stream-001/f/1"
              target="_blank"
              rel="noopener"
            >
              Open this run in Observer ↗
            </a>
            <span>The full replay, its findings, and a link to every frame.</span>
          </p>
        </div>
      </div>

      <div className="study-block">
        <section className="repair-study study-axis" aria-labelledby="axis-title">
          <div>
            <p className="repair-kicker">
              Example 2 of 3 · drawDB, TodoMVC, Excalidraw · September 1 to 4, 2026
            </p>
            <h2 id="axis-title">
              Find out which kind of user <em>your app blocks</em>
            </h2>
            <blockquote className="repair-quote">
              <p>
                &ldquo;no keyboard-accessible database options &hellip; Confirm remains
                disabled&rdquo;
              </p>
              <footer>
                drawDB · keyboard-first participant · run cua-2026-09-03T21-17-11-267Z-bde2251d
              </footer>
            </blockquote>
            <p className="repair-copy">
              One run tells you what one person hit. The useful question is who gets stuck. So we
              gave the same task to two different people: a power user who lives on the keyboard,
              and a newcomer who has never seen the app and reaches for the mouse. Three apps, four
              to six runs each. The persona is what you declare; whether a run really stayed on the
              keyboard is what the trace records, action by action.
            </p>
          </div>
          <div className="repair-results">
            <table>
              <caption>Reported the problem, by participant kind</caption>
              <thead>
                <tr>
                  <th scope="col">App · mission</th>
                  <th scope="col">Keyboard-first</th>
                  <th scope="col">Mouse newcomer</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">drawDB · two related tables</th>
                  <td>
                    5<span> / 5</span>
                  </td>
                  <td>
                    0<span> / 5</span>
                  </td>
                </tr>
                <tr>
                  <th scope="row">TodoMVC · add, rename, filter</th>
                  <td>
                    6<span> / 6</span>
                  </td>
                  <td>
                    0<span> / 6</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="axis-note">
              <b>The control:</b> Excalidraw, two boxes and an arrow. 12 of 12 participants of every
              kind reached the goal.
            </p>
            <p className="repair-copy">
              Keyboard-first participants reported drawDB&rsquo;s database modal 5 of 5 times and
              TodoMVC&rsquo;s double-click rename 6 of 6 times; no mouse newcomer reported either.
              Three of the five drawDB participants and two of the six TodoMVC participants were
              blocked there; the others switched to the mouse, finished, and said so. Five or six
              runs per cell. A blocked synthetic participant identifies a place in the app to check;
              it does not estimate how many people would be blocked.
            </p>
            <div className="repair-links">
              <a href={`${RECEIPTS}/persona-contrast-live-2026-09-01.md`} rel="noopener">
                drawDB study notes →
              </a>
              <a href={`${RECEIPTS}/persona-contrast-todomvc-2026-09-01.md`} rel="noopener">
                TodoMVC receipt →
              </a>
              <a href={`${RECEIPTS}/persona-axis-phone-2026-09-03.md`} rel="noopener">
                Excalidraw control →
              </a>
            </div>
          </div>
        </section>
      </div>

      <div className="study-block">
        <RepairStudy />
      </div>

      <div className="study-notes rev">
        <p>
          Verify passed 16/16 on the drawDB run, and the bundle still grades <code>local_only</code>
          : it holds full-fidelity screenshots, which the share-safety gate never marks share-ready
          as-is. These captures were reviewed by hand before publication.
        </p>
        <p>
          drawDB, TodoMVC and Excalidraw are the applications studied; none is a humanish adopter or
          endorser. The lobby game is the maintainer&rsquo;s own.
        </p>
      </div>
    </section>
  );
}
