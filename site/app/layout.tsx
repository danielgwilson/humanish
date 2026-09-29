import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Newsreader } from "next/font/google";
import localFont from "next/font/local";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

/**
 * The headline and the wordmark are the largest paint on a phone, and Chrome counts a text
 * element once its web font is in. So the glyphs they use, and only those, ship as tiny
 * self-hosted subsets of the same Newsreader (both axes kept, so the display optical size is
 * identical) and of Geist at 600: about 15 KB. The file names start with "0-" because Next
 * emits font preloads in file-name order and these must sit ahead of the full faces in the
 * HTML, or a slow connection queues them behind 271 KB. Regenerate with
 * scripts/subset-display-fonts.py.
 */
const newsreaderDisplay = localFont({
  src: [
    { path: "./fonts/0-display-newsreader.woff2", style: "normal" },
    { path: "./fonts/0-display-newsreader-italic.woff2", style: "italic" }
  ],
  weight: "300 400",
  display: "swap",
  preload: true,
  adjustFontFallback: "Times New Roman",
  variable: "--font-newsreader-display"
});

const geistDisplay = localFont({
  src: "./fonts/0-display-geist-600.woff2",
  weight: "600",
  display: "swap",
  preload: true,
  adjustFontFallback: "Arial",
  variable: "--font-geist-display"
});

// The full face stays preloaded, after the subsets in document order: discovered from CSS
// instead it fetches at "VeryHigh" and the simulated slow network then holds the stylesheet
// behind 271 KB of font (FCP 1.3 s -> 3.0 s in Lighthouse). Preloaded, it fetches at "High"
// and no longer gates anything the hero paints.
const newsreader = Newsreader({
  subsets: ["latin"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-newsreader"
});

// Only the headline face is preloaded: Chrome counts the largest paint once its web font is in,
// and four preloads (325 KB) shared the first seconds of a phone connection with it.
const geist = Geist({
  subsets: ["latin"],
  display: "swap",
  preload: false,
  variable: "--font-geist"
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  display: "swap",
  preload: false,
  variable: "--font-geist-mono"
});

const SITE = "https://humanish.dev";
// Baked in at build time; lets CI verify production actually serves a given
// commit instead of trusting deploy status alone.
const DEPLOY_SHA = process.env.VERCEL_GIT_COMMIT_SHA ?? "local";
const TITLE = "humanish — instant feedback from real human(ish) users";
// Verbatim hero lede minus its <code> marks. Mirrors: components/hero.tsx
// (.lede) and public/llms.txt (description block). All three move together.
const DESCRIPTION =
  "You can’t run a user study on an app that has no users yet. humanish runs one anyway. One command puts a synthetic participant with a persona and a task in front of your app in a real browser; what comes back is what they did, where they got stuck, and what it cost.";

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfaf7" },
    { media: "(prefers-color-scheme: dark)", color: "#171512" }
  ]
};

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
      className={`${newsreaderDisplay.variable} ${geistDisplay.variable} ${newsreader.variable} ${geist.variable} ${geistMono.variable}`}
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
