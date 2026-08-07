import { Wordmark } from "./wordmark";

const GITHUB = "https://github.com/danielgwilson/humanish";

export default function Footer() {
  return (
    <footer className="site-foot">
      <div className="foot-grid">
        <div className="foot-brand">
          <Wordmark />
          <p>Open-source TypeScript CLI, MIT-licensed.</p>
        </div>
        <div className="foot-cols">
          <nav className="foot-block" aria-label="Product">
            <span className="fl">Product</span>
            <a href="#install">Install</a>
            <a href={GITHUB}>Docs</a>
            <a href={GITHUB}>CLI reference</a>
          </nav>
          <nav className="foot-block" aria-label="Evidence">
            <span className="fl">Evidence</span>
            <a href="#study">drawDB study</a>
            <a href="#study">Verify checks</a>
          </nav>
          <nav className="foot-block" aria-label="Source">
            <span className="fl">Source</span>
            <a href={GITHUB}>GitHub</a>
            <a href="https://www.npmjs.com/package/humanish">npm</a>
            <a href={`${GITHUB}/blob/main/LICENSE`}>MIT license</a>
          </nav>
        </div>
      </div>
      <div className="provenance">
        <p>Run <code>drawdb-study-20260801-wide-05</code> · 2026-08-01 · 4/4 lanes passed · verify 15/15 checks. drawDB is the application studied; it is not a Humanish adopter or endorser.</p>
        <span className="lic">MIT © humanish</span>
      </div>
    </footer>
  );
}
