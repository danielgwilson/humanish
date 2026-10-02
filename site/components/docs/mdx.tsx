import defaultComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import type { AnchorHTMLAttributes } from "react";
import { VERSION } from "@/lib/site-data";

const REPOSITORY = "https://github.com/danielgwilson/humanish";

/**
 * A docs page names a repository file as `repo:<path>` (a folder ends in `/`). The site documents
 * the published package, so the link opens that file at the release tag of the version the site
 * was built from, where a later move on main cannot break it.
 */
function repoHref(href: string | undefined, version: string = VERSION): string | undefined {
  if (!href?.startsWith("repo:")) return href;
  const [path = "", fragment] = href.slice("repo:".length).split("#", 2);
  const view = path.endsWith("/") ? "tree" : "blob";
  return `${REPOSITORY}/${view}/v${version}/${path}${fragment === undefined ? "" : `#${fragment}`}`;
}

export function getMDXComponents(): MDXComponents {
  const Anchor = defaultComponents.a;
  return {
    ...defaultComponents,
    a: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => (
      <Anchor {...props} href={repoHref(props.href)} />
    ),
  };
}
