import ThemeToggle from "./theme-toggle";
import { Wordmark } from "./wordmark";

const GITHUB = "https://github.com/danielgwilson/humanish";

export default function Nav() {
  return (
    <header className="nav">
      <div className="nav-in">
        <Wordmark label="humanish home" />
        <nav className="nav-links" aria-label="Primary">
          <a href="#study">Study</a>
          <a href="#commands">Commands</a>
          <a href="#trust">Trust</a>
          <a href={GITHUB}>GitHub</a>
        </nav>
        <ThemeToggle />
        <a className="btn btn-primary" href={GITHUB}>Get started</a>
      </div>
    </header>
  );
}
