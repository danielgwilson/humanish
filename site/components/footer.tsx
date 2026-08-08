import { Wordmark } from "./wordmark";

const GITHUB = "https://github.com/danielgwilson/humanish";
// The README's "## Docs" section — a curated index; unique heading, slug #docs.
const DOCS = `${GITHUB}#docs`;
// The README's "## Commands" heading — GitHub slugs it to #commands.
const CLI_REFERENCE = `${GITHUB}#commands`;

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
            <a href={DOCS}>Docs</a>
            <a href={CLI_REFERENCE}>CLI reference</a>
          </nav>
          <nav className="foot-block" aria-label="Evidence">
            <span className="fl">Evidence</span>
            <a href="#study">Excalidraw study</a>
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
        <p>Run <code>cua-2026-08-07T17-44-48-760Z-87389419</code> · 2026-08-07 · 3/4 lanes passed · verify 16/16 checks. Excalidraw is the application studied; it is not a Humanish adopter or endorser.</p>
        <span className="lic">MIT © humanish</span>
      </div>
    </footer>
  );
}
