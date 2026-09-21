import { Wordmark } from "./wordmark";
import { BENCH, GITHUB, RECEIPTS, VERSION } from "@/lib/site-data";

/**
 * `base` prefixes the homepage section anchors so subpages link back to them
 * ("/#studies") instead of hunting for an id they do not have.
 */
export default function Footer({ base = "" }: { base?: string }) {
  return (
    <footer className="site-foot">
      <div className="foot-grid">
        <div className="foot-brand">
          <Wordmark />
          <p>Open-source TypeScript CLI, MIT-licensed. Version {VERSION}.</p>
        </div>
        <div className="foot-cols">
          <nav className="foot-block" aria-label="Product">
            <span className="fl">Product</span>
            <a href="/docs#install">Install</a>
            <a href="/docs">Docs</a>
            <a href="/docs/cli">CLI reference</a>
            <a href={`${GITHUB}/releases`}>Releases</a>
            <a href="/llms.txt">llms.txt</a>
          </nav>
          <nav className="foot-block" aria-label="Evidence">
            <span className="fl">Evidence</span>
            <a href="/docs/todomvc-edit-study">TodoMVC keyboard repair</a>
            <a href="/docs/save-button-study">Save-button study</a>
            <a href={`${RECEIPTS}/persona-axis-phone-2026-09-03.md`}>Persona axis receipts</a>
            <a href={`${BENCH}/RESULTS-2026-09-04-0.76.0.md`}>Planted-defect benchmark</a>
            <a href={`${base}#study`}>drawDB and the lobby game runs</a>
            <a href="/failure-modes">Known failure modes</a>
          </nav>
          <nav className="foot-block" aria-label="Source">
            <span className="fl">Source</span>
            <a href={GITHUB}>GitHub</a>
            <a href="https://www.npmjs.com/package/humanish">npm</a>
            <a href={`${GITHUB}/blob/main/LICENSE`}>MIT license</a>
            <a href={`${GITHUB}/blob/main/TELEMETRY.md`}>Telemetry</a>
          </nav>
        </div>
      </div>
      <div className="provenance">
        <p>Every number on this page is read from a kept run bundle; the run ids are in the linked receipts and in the embedded recordings. drawDB, TodoMVC and Excalidraw are applications studied; none is a humanish adopter or endorser. The lobby game is the maintainer&rsquo;s own. Cost lines are estimates at the dated rates each bundle records.</p>
        <span className="lic">MIT © humanish</span>
      </div>
    </footer>
  );
}
