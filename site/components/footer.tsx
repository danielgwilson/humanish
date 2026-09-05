import { Wordmark } from "./wordmark";

const GITHUB = "https://github.com/danielgwilson/humanish";
const DOCS = "/docs";
const CLI_REFERENCE = "/docs/cli";

/**
 * `base` prefixes the homepage section anchors so subpages link back to them
 * ("/#study") instead of hunting for an id they do not have. Empty on the
 * homepage itself, where the plain hashes stay in-page.
 */
export default function Footer({ base = "" }: { base?: string }) {
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
            <a href="/docs#install">Install</a>
            <a href={DOCS}>Docs</a>
            <a href={CLI_REFERENCE}>CLI reference</a>
          </nav>
          <nav className="foot-block" aria-label="Evidence">
            <span className="fl">Evidence</span>
            <a href={`${base}#study`}>Excalidraw study</a>
            <a href="/docs/save-button-study">Save-button study</a>
            <a href="/docs/todomvc-edit-study">TodoMVC keyboard repair</a>
            <a href={`${base}#study`}>Verify checks</a>
            <a href="/failure-modes">Known failure modes</a>
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
