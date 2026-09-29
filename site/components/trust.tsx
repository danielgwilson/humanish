export default function Trust() {
  return (
    <section id="trust" className="band band-dark">
      <h2 className="rev">
        Your keys and evidence <em>stay local</em> by default
      </h2>

      <div className="trust-grid">
        <div className="tcard rev">
          <span className="tidx">01</span>
          <h3>Browser runs keep your model key on your machine</h3>
          <p>
            Computer-use participants call the model from your machine; the desktop receives
            actions. Terminal participants receive a runtime key by default.{" "}
            <a href="/docs/budgets-and-privacy#store-credentials">See credential options.</a>
          </p>
        </div>
        <div className="tcard rev" style={{ "--d": ".06s" } as React.CSSProperties}>
          <span className="tidx">02</span>
          <h3>Evidence stays in your repo until you share it</h3>
          <p>
            Evidence lands in gitignored <code>.humanish/</code>. Exposing Observer or sharing an
            export makes it accessible to others. The recordings on this page were published by
            hand, after review.
          </p>
        </div>
        <div className="tcard rev" style={{ "--d": ".12s" } as React.CSSProperties}>
          <span className="tidx">03</span>
          <h3>Issue drafts never post to GitHub</h3>
          <p>
            <code>feedback issue</code> renders a draft; no GitHub API call exists on that path.
          </p>
        </div>
        <div className="tcard rev" style={{ "--d": ".18s" } as React.CSSProperties}>
          <span className="tidx">04</span>
          <h3>Anything verify can&rsquo;t clear stays local</h3>
          <p>
            A bundle that can&rsquo;t pass every gate grades <code>local_only</code> or{" "}
            <code>blocked</code>, never <code>share_ready</code>. The gate catches secret and path
            shapes; it does not certify that names or personal data are absent from pixels.{" "}
            <a href="/failure-modes">Known failure modes.</a>
          </p>
        </div>
      </div>
    </section>
  );
}
