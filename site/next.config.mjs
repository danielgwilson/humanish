import { createRequire } from "node:module";
import { createMDX } from "fumadocs-mdx/next";

const require = createRequire(import.meta.url);
/** The CLI's version, shown in the nav; the site builds from the monorepo so the root package.json is present. */
const { version: HUMANISH_VERSION } = require("../package.json");

const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  // The Observer artifact is framed by the homepage itself; nothing else may frame the site.
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'" }
];

/** @type {import("next").NextConfig} */
const nextConfig = {
  env: { NEXT_PUBLIC_HUMANISH_VERSION: HUMANISH_VERSION },
  images: { formats: ["image/avif", "image/webp"], qualities: [60, 70, 75] },
  async redirects() {
    // The homepage sections are anchors; the natural paths lead to them instead of a 404.
    return ["study", "commands", "trust", "faq"].map((section) => ({ source: `/${section}`, destination: `/#${section}`, permanent: false }));
  },
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      {
        // Run bundles are pinned by content in ASSETS.sha256.json and a new run gets a new slug.
        source: "/runs/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }]
      },
      {
        // The homepage negotiates on Accept (see proxy.ts) and advertises its markdown twin.
        source: "/",
        headers: [
          { key: "Vary", value: "Accept" },
          { key: "Link", value: '<https://humanish.dev/llms.md>; rel="alternate"; type="text/markdown"' }
        ]
      }
    ];
  }
};

export default createMDX()(nextConfig);
