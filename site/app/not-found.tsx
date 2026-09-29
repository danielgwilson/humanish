import type { Metadata } from "next";
import Footer from "@/components/footer";
import Nav from "@/components/nav";

export const metadata: Metadata = {
  title: "humanish — page not found",
  robots: { index: false, follow: false },
};

/** A 404 that still has the site on it: a skeptical participant typed /trust and got a bare error page. */
export default function NotFound() {
  return (
    <>
      <Nav base="/" />
      <main id="main" className="band notfound">
        <p className="kicker">404</p>
        <h1>There is no page at this address.</h1>
        <p className="lede">The homepage sections are anchors, and the docs live under /docs.</p>
        <ul className="notfound-links">
          <li>
            <a href="/">Homepage</a>
          </li>
          <li>
            <a href="/#study">Study</a>
          </li>
          <li>
            <a href="/#commands">Commands</a>
          </li>
          <li>
            <a href="/#trust">Trust</a>
          </li>
          <li>
            <a href="/#faq">FAQ</a>
          </li>
          <li>
            <a href="/docs">Docs</a>
          </li>
          <li>
            <a href="/failure-modes">Known limits</a>
          </li>
        </ul>
      </main>
      <Footer />
    </>
  );
}
