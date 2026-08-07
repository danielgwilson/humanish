import type { MetadataRoute } from "next";

/**
 * Everyone is welcome, and the AI crawlers are welcome by name — the site's
 * own audience is coding agents (SPEC §5 agent parity).
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/" },
      {
        userAgent: [
          "GPTBot",
          "OAI-SearchBot",
          "ChatGPT-User",
          "ClaudeBot",
          "Claude-Web",
          "Claude-SearchBot",
          "anthropic-ai",
          "Google-Extended",
          "PerplexityBot",
          "Perplexity-User",
          "CCBot",
          "Applebot-Extended",
          "meta-externalagent"
        ],
        allow: "/"
      }
    ],
    sitemap: "https://humanish.dev/sitemap.xml"
  };
}
