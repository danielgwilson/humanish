import { createRequire } from "node:module";
import { createMDX } from "fumadocs-mdx/next";

const require = createRequire(import.meta.url);
/** The CLI's version, shown in the nav; the site builds from the monorepo so the root package.json is present. */
const { version: HUMANISH_VERSION, engines } = require("../package.json");
/** The CLI's minimum Node version, "22.19" from engines.node ">=22.19.0". */
const nodeFloor = /^>=(\d+)\.(\d+)\.\d+$/.exec(engines.node);
if (!nodeFloor) throw new Error(`Unexpected engines.node ${engines.node}; update next.config.mjs`);
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** A short hash of the hero's Observer artifact, so its URL changes when the file does. */
const OBSERVER_ARTIFACT_V = createHash("sha256")
  .update(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "public/runs/lobby-0927/observer/index.html"),
    ),
  )
  .digest("hex")
  .slice(0, 8);

const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  // The Observer artifact is framed by the homepage itself; nothing else may frame the site.
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
];

/** @type {import("next").NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_HUMANISH_VERSION: HUMANISH_VERSION,
    NEXT_PUBLIC_HUMANISH_NODE: `${nodeFloor[1]}.${nodeFloor[2]}`,
    NEXT_PUBLIC_OBSERVER_ARTIFACT_V: OBSERVER_ARTIFACT_V,
  },
  images: { formats: ["image/avif", "image/webp"], qualities: [60, 70, 75] },
  async redirects() {
    // The homepage sections are anchors; the natural paths lead to them instead of a 404.
    return [
      ...["study", "commands", "trust", "faq"].map((section) => ({
        source: `/${section}`,
        destination: `/#${section}`,
        permanent: false,
      })),
      // The docs sidebar calls the failure-modes page "Known limits"; a participant guessed this path.
      { source: "/docs/known-limits", destination: "/failure-modes", permanent: false },
      // A study file was called a lab manifest before 0.108.0.
      { source: "/docs/lab-manifests", destination: "/docs/study-files", permanent: true },
      // The 2026-09-16 run was published here before the 2026-09-27 run replaced it on /demo.
      { source: "/runs/lobby-0916-full/:path*", destination: "/demo", permanent: true },
      // The 2026-09-14 homepage was kept here for review until the homepage experiment ended.
      { source: "/legacy", destination: "/", permanent: true },
    ];
  },
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      {
        // `ASSETS.sha256.json` pins captures and posters by content; a new run gets a new slug.
        source: "/runs/:slug/screenshots/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        source: "/runs/:slug/poster.jpg",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        // The Observer artifact and its JSON change when the Observer or the analysis does, at the
        // same path. A year of "immutable" here kept browsers on the old artifact after a fix.
        source: "/runs/:slug/observer/:file*",
        headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
      },
      {
        // The homepage negotiates on Accept (see proxy.ts) and advertises its markdown twin.
        source: "/",
        headers: [
          { key: "Vary", value: "Accept" },
          {
            key: "Link",
            value: '<https://humanish.dev/llms.md>; rel="alternate"; type="text/markdown"',
          },
        ],
      },
    ];
  },
};

export default createMDX()(nextConfig);
