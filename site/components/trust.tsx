const GITHUB = "https://github.com/danielgwilson/humanish";

export default function Trust() {
  return (
    <section id="trust" className="band band-dark">
      <h2 className="rev">Four things humanish <em>cannot</em> do</h2>

      <div className="trust-grid">
        <div className="tcard rev">
          <span className="tidx">01</span>
          <h3>Keys never enter the sandbox</h3>
          <p>The actor&rsquo;s API key stays on your machine; the sandbox desktop never holds it.</p>
        </div>
        <div className="tcard rev" style={{ "--d": ".06s" } as React.CSSProperties}>
          <span className="tidx">02</span>
          <h3>Bundles stay local</h3>
          <p>Evidence lands in gitignored <code>.humanish/</code>; no command publishes it.</p>
        </div>
        <div className="tcard rev" style={{ "--d": ".12s" } as React.CSSProperties}>
          <span className="tidx">03</span>
          <h3>Feedback can&rsquo;t touch GitHub</h3>
          <p><code>feedback issue</code> renders a draft; no GitHub API call exists on that path.</p>
        </div>
        <div className="tcard rev" style={{ "--d": ".18s" } as React.CSSProperties}>
          <span className="tidx">04</span>
          <h3>Verify fails closed</h3>
          <p>A bundle that can&rsquo;t pass every gate grades <code>local_only</code> or <code>blocked</code>, never <code>share_ready</code>.</p>
        </div>
      </div>

      <div className="origin">
        <h2 className="rev">Started on a <em>patient intake</em></h2>
        <p className="origin-body rev" style={{ "--d": ".08s" } as React.CSSProperties}>humanish started on a chat-based patient intake. Testing one long flow meant recruiting five ADHD patients: pay a panel and wait days for thin feedback on one slice of a build. A later product&rsquo;s users are AI agents; there&rsquo;s no panel for that. <b>When you can recruit real users, do that. humanish covers the runs that otherwise never happen.</b></p>
      </div>

      <div className="closer">
        <h2 className="rev">Test the build you have <em>open.</em></h2>
        <div className="cta-row rev" style={{ "--d": ".08s" } as React.CSSProperties}>
          <a className="btn btn-primary" href="/docs">Get started</a>
          <a className="btn btn-ghost" href={GITHUB}>View on GitHub</a>
        </div>
        <p className="cmdline rev" style={{ "--d": ".14s" } as React.CSSProperties}><code>npm i -D humanish</code> · <code>npx humanish init --yes</code> · <code>npx humanish watch</code> — open a keyless evidence preview in Observer. No actors run.</p>
      </div>
    </section>
  );
}
