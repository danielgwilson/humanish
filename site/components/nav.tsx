import ThemeToggle from "./theme-toggle";
import { Wordmark } from "./wordmark";

/**
 * `base` prefixes the homepage section anchors so subpages link back to them
 * ("/#study") instead of hunting for an id they do not have. Empty on the
 * homepage itself, where the plain hashes stay in-page.
 */
export default function Nav({ base = "" }: { base?: string }) {
  return (
    <header className="nav">
      <div className="nav-in">
        <Wordmark href={base || "#"} label="humanish home" />
        <nav className="nav-links" aria-label="Primary">
          <a href={`${base}#study`}>Study</a>
          <a href={`${base}#commands`}>Commands</a>
          <a href={`${base}#trust`}>Trust</a>
          <a href="/docs">Docs</a>
        </nav>
        <ThemeToggle />
        <a className="btn btn-primary" href="/docs">Get started</a>
      </div>
    </header>
  );
}
