import { applyMdxPreset } from "fumadocs-mdx/config";
import { defineDocs } from "fumadocs-mdx/macro";
import { rehypeCodeDefaultOptions } from "fumadocs-core/mdx-plugins";
import { loader } from "fumadocs-core/source";

// Shiki stops tokenizing a line after 500 ms by default and gives the rest of it the theme's
// foreground color. On a loaded build machine that cut lines short in one theme and not the other,
// so builds of the same tree differed. The docs are a fixed set of pages, so there is no limit.
const docs = defineDocs({
  dir: "content/docs",
  docs: {
    mdxOptions: applyMdxPreset({
      rehypeCodeOptions: { ...rehypeCodeDefaultOptions, tokenizeTimeLimit: 0 },
    }),
  },
});

export const docsSource = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});
