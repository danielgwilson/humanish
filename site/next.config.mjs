import { createMDX } from "fumadocs-mdx/next";

/** @type {import("next").NextConfig} */
const nextConfig = {
  async headers() {
    return [
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
