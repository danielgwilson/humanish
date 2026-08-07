import type { Metadata } from "next";
import { Geist, Geist_Mono, Newsreader } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

const newsreader = Newsreader({
  subsets: ["latin"],
  style: ["normal", "italic"],
  axes: ["opsz"],
  display: "swap",
  variable: "--font-newsreader"
});

const geist = Geist({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-geist"
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-geist-mono"
});

const SITE = "https://humanish.dev";
// Baked in at build time; lets CI verify production actually serves a given
// commit instead of trusting deploy status alone.
const DEPLOY_SHA = process.env.VERCEL_GIT_COMMIT_SHA ?? "local";
const TITLE = "humanish — instant feedback from real human(ish) users";
const DESCRIPTION =
  "Personas drive your app in a real browser on a hosted sandbox desktop. Runs land as evidence: screenshots, action traces, lifecycle events, estimated cost, a fail-closed verdict.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: SITE,
    siteName: "humanish",
    type: "website"
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION
  }
};

/**
 * Runs before paint: mark JS availability (the POC's `.js` gate for
 * progressive enhancement) and restore a persisted explicit theme choice
 * so there is no flash of the wrong theme. System preference needs no JS —
 * the token system handles it via prefers-color-scheme.
 *
 * The `.js` gate hides `.rev` content until Reveals hydrates, so the same
 * script arms a safety timer: if hydration has not cancelled it within
 * 1.5s (slow network, failed chunk), `rev-all` unhides everything. Content
 * must never depend on ~140KB of async chunks to reach first paint.
 */
const THEME_INIT = `(function(){var d=document.documentElement;d.classList.add('js');window.__revFallback=setTimeout(function(){d.classList.add('rev-all')},1500);try{var t=localStorage.getItem('humanish-theme');if(t==='dark'||t==='light')d.setAttribute('data-theme',t)}catch(e){}})();`;

const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "humanish",
  description: DESCRIPTION,
  url: SITE,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "macOS, Linux, Windows",
  license: "https://spdx.org/licenses/MIT.html",
  codeRepository: "https://github.com/danielgwilson/humanish",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD"
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${newsreader.variable} ${geist.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <meta name="color-scheme" content="light dark" />
        <meta name="humanish-deploy-sha" content={DEPLOY_SHA} />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
        />
      </head>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
