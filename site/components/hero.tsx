import CopyButton from "./copy-button";
import CoverCanvas from "./cover-canvas";
import HeroCrowd from "./hero-crowd";
import { Ish } from "./wordmark";

export default function Hero() {
  return (
    <section className="hero">
      <div className="hero-copy">
        <h1 className="rev">Instant feedback from<br />real <span className="wm-h1">human<Ish /></span> users</h1>
        {/* Mirror obligation: this lede is the site description. Any edit here
            moves layout.tsx DESCRIPTION (meta + OG + Twitter + JSON-LD) and the
            llms.txt description block in the same commit. */}
        <p className="lede rev" style={{ "--d": ".06s" } as React.CSSProperties}>Personas drive your app in a real browser on a hosted sandbox desktop. Runs land in your repo under <code>.humanish/</code>: screenshots, action traces, lifecycle events, estimated cost at dated rates. <code>humanish verify</code> grades the bundle fail-closed.</p>
        <div className="cta-row rev" style={{ "--d": ".12s" } as React.CSSProperties}>
          <a className="btn btn-primary" href="/docs">Get started</a>
          <a className="btn btn-ghost" href="/docs/todomvc-edit-study">Read the TodoMVC study</a>
        </div>
        <div className="console rev" id="install" style={{ "--d": ".18s" } as React.CSSProperties}>
          <div className="c-run">
            <code><span className="ps">$</span>npx humanish<span className="caret" aria-hidden="true"></span></code>
            <CopyButton text="npx humanish" />
          </div>
          <div className="c-bar"><span>Keyless evidence preview</span><CopyButton text={"npm i -D humanish\nnpx humanish init --yes\nnpx humanish watch"} label="copy all" /></div>
          <div className="c-lines">
            <code>npm i -D humanish</code>
            <code>npx humanish init --yes</code>
            <code>npx humanish watch</code>
          </div>
          <div className="c-foot">No actors or app interaction · no provider spend<br /><a href="/docs">Run a live study →</a></div>
        </div>
        <p className="agent-line rev" style={{ "--d": ".24s" } as React.CSSProperties}>For coding agents: <code>npx skills add danielgwilson/humanish</code></p>
      </div>
      <div className="hero-art" id="heroArt">
        <HeroCrowd />
        <figure className="hero-tile rev" style={{ "--d": ".3s" } as React.CSSProperties}>
          <div className="tile-bar"><span className="lane-id"><b>Lane 01 ·</b> diagram-login-flow</span><span className="chip chip-pass">Passed</span></div>
          <div className="tile-shot"><img src="/study/excalidraw-lane1.jpg" alt="Lane 01 screenshot: Excalidraw canvas with two rectangles labeled Login and Dashboard connected by an arrow" /><CoverCanvas n="01" resolveAfter={1100} /></div>
          <figcaption className="tile-foot"><span className="fl">Final report</span><span className="fq">{'"Done"'}</span></figcaption>
        </figure>
      </div>
    </section>
  );
}
