import CopyButton from "./copy-button";
import CoverCanvas from "./cover-canvas";
import HeroCrowd from "./hero-crowd";
import { Ish } from "./wordmark";

const GITHUB = "https://github.com/danielgwilson/humanish";

export default function Hero() {
  return (
    <section className="hero">
      <div className="hero-copy">
        <h1 className="rev">Instant feedback from<br />real human<Ish /> users</h1>
        <p className="lede rev" style={{ "--d": ".06s" } as React.CSSProperties}>Personas drive your app in a real browser on a hosted sandbox desktop. Runs land as evidence: screenshots, action traces, lifecycle events, estimated cost, a fail-closed verdict.</p>
        <div className="cta-row rev" style={{ "--d": ".12s" } as React.CSSProperties}>
          <a className="btn btn-primary" href={GITHUB}>Get started</a>
          <a className="btn btn-ghost" href={GITHUB}>View on GitHub</a>
        </div>
        <div className="console rev" id="install" style={{ "--d": ".18s" } as React.CSSProperties}>
          <div className="c-run">
            <code><span className="ps">$</span>npx humanish<span className="caret" aria-hidden="true"></span></code>
            <CopyButton text="npx humanish" />
          </div>
          <div className="c-bar"><span>First run, in order</span><CopyButton text={"npm i -D humanish\nnpx humanish init --yes\nnpx humanish watch"} label="copy all" /></div>
          <div className="c-lines">
            <code>npm i -D humanish</code>
            <code>npx humanish init --yes</code>
            <code>npx humanish watch</code>
          </div>
          <div className="c-foot">npx humanish prints the commands · MIT licensed</div>
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
