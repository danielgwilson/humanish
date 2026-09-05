import type { MetadataRoute } from "next";
import { docsSource } from "@/lib/docs-source";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    ...docsSource.getPages().map((page) => ({
      url: `https://humanish.dev${page.url}`,
      changeFrequency: "weekly" as const,
      priority: 0.8
    })),
    {
      url: "https://humanish.dev",
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1
    },
    {
      url: "https://humanish.dev/failure-modes",
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.7
    }
  ];
}
