import CopyButton from "./copy-button";
import HeroCrowd from "./hero-crowd";
import HeroObserver from "./hero-observer";
import { Ish } from "./wordmark";

export default function Hero() {
  return (
    <section className="hero">
      <div className="hero-copy">
        <h1 className="rev">
          Instant feedback from
          <br />
          real{" "}
          <span className="wm-h1">
            human
            <Ish />
          </span>{" "}
          users
        </h1>
        {/* Mirror obligation: this lede is the site description. Any edit here
            moves layout.tsx DESCRIPTION (meta + OG + Twitter + JSON-LD) and the
            llms.txt description block in the same commit. */}
        <p className="lede rev" style={{ "--d": ".06s" } as React.CSSProperties}>
          You can&rsquo;t run a user study on an app that has no users yet. humanish runs one
          anyway. One command puts a synthetic participant with a persona and a task in front of
          your app in a real browser; what comes back is what they did, where they got stuck, and
          what it cost.
        </p>
        <div className="cta-row rev" style={{ "--d": ".12s" } as React.CSSProperties}>
          <a className="btn btn-primary" href="/docs">
            Get started
          </a>
          <a className="cta-link" href="/docs/todomvc-edit-study">
            Read an example study →
          </a>
        </div>
        <p className="hero-limits rev" style={{ "--d": ".15s" } as React.CSSProperties}>
          It shows you where one participant got stuck, not how many of your users would.{" "}
          <a href="/failure-modes">Known failure modes</a>
        </p>
        <div className="console rev" id="install" style={{ "--d": ".18s" } as React.CSSProperties}>
          <div className="c-run">
            <code>
              <span className="ps">$</span>npx humanish
              <span className="caret" aria-hidden="true"></span>
            </code>
            <CopyButton text="npx humanish" />
          </div>
          <div className="c-bar">
            <span>Preview a sample run, no API keys</span>
            <CopyButton
              text={"npm i -D humanish\nnpx humanish init --yes\nnpx humanish watch"}
              label="copy all"
            />
          </div>
          <div className="c-lines">
            <code>npm i -D humanish</code>
            <code>npx humanish init --yes</code>
            <code>npx humanish watch</code>
          </div>
          <div className="c-foot">
            Plays a bundled sample · does not open your app · no spend
            <br />
            <a href="/docs">Run a live study →</a>
          </div>
        </div>
        <p className="agent-line rev" style={{ "--d": ".24s" } as React.CSSProperties}>
          For coding agents: <code>npx skills add danielgwilson/humanish</code>
        </p>
      </div>
      <div className="hero-art" id="heroArt">
        <HeroCrowd />
        <HeroObserver
          slug="lobby-0927"
          participants={8}
          title="Eight participants in one lobby of a multiplayer movie-guessing game"
          facts="6 reached the goal · 2 blocked · 7 findings · 13 minutes"
          runId="concurrent-shared-world-2026-09-27T20-57-56-664Z-1e8c9646"
        />
      </div>
    </section>
  );
}
