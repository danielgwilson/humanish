/**
 * Fails the site build when the prerendered docs code is not colored the same way in both themes.
 *
 * Shiki writes each token's colors as --shiki-light and --shiki-dark custom properties. The docs
 * use github-light and github-dark, which color the same scopes, so every light color pairs with
 * exactly one dark color: a keyword is #D73A49 in light and #F97583 in dark, a string #032F62 and
 * #9ECBFF. A light color that pairs with two dark colors, or the reverse, means one theme's pass
 * tokenized the code differently: a line was cut short, or a block lost its colors. The light
 * theme is the default, so such a build would deploy miscolored code.
 *
 * The build also fails when the docs pages together use fewer than MIN_COLORS colors in either
 * theme, which is what a build with no highlighting looks like.
 *
 * Run after `next build`: node scripts/check-docs-highlighting.mjs [.next directory]
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const MIN_COLORS = 4;
const dist = process.argv[2] ?? ".next";
const app = join(dist, "server", "app");
const routeCache = join(dist, "server", "route-cache", "APP_PAGE");

/**
 * Directories that hold prerendered App Router pages. A plain `next build` writes them under
 * server/app. With a deployment adapter, which Vercel's build sets through NEXT_ADAPTER_PATH,
 * next 16.4 writes each route's pages under server/route-cache/APP_PAGE/<route hash>/$ instead.
 */
function pageRoots() {
  if (!existsSync(routeCache)) return [app];
  return [app, ...readdirSync(routeCache).map((route) => join(routeCache, route, "$"))];
}

/** /docs prerenders to docs.html and every other docs page to docs/<slug>.html. */
function docsPages() {
  return pageRoots().flatMap((root) => {
    const pages = existsSync(join(root, "docs"))
      ? readdirSync(join(root, "docs"), { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
          .map((entry) => join(entry.parentPath, entry.name))
      : [];
    return existsSync(join(root, "docs.html")) ? [join(root, "docs.html"), ...pages] : pages;
  });
}

/** For each color in one theme, the colors it pairs with in the other and the pages they are on. */
const partners = { light: new Map(), dark: new Map() };
function pair(theme, color, other, page) {
  const byColor = partners[theme].get(color) ?? new Map();
  partners[theme].set(color, byColor.set(other, (byColor.get(other) ?? new Set()).add(page)));
}

const files = docsPages();
let tokens = 0;
for (const file of files) {
  const page = relative(dist, file);
  for (const [, light, dark] of readFileSync(file, "utf8").matchAll(
    /--shiki-light:(#[0-9A-Fa-f]{3,8});--shiki-dark:(#[0-9A-Fa-f]{3,8})/g,
  )) {
    tokens++;
    pair("light", light, dark, page);
    pair("dark", dark, light, page);
  }
}

const failures = [];
if (files.length === 0)
  failures.push(`no prerendered docs pages under ${app} or ${routeCache}; run it after next build`);
else if (tokens === 0) failures.push(`no highlighted code in the ${files.length} docs pages`);
for (const theme of ["light", "dark"]) {
  for (const [color, others] of partners[theme]) {
    if (others.size < 2) continue;
    const detail = [...others].map(([other, pages]) => `${other} on ${[...pages].join(", ")}`);
    failures.push(`${theme} ${color} pairs with ${others.size} colors: ${detail.join("; ")}`);
  }
  if (tokens > 0 && partners[theme].size < MIN_COLORS)
    failures.push(
      `the docs use ${partners[theme].size} ${theme} color(s); expected at least ${MIN_COLORS}`,
    );
}

if (failures.length > 0) {
  process.stderr.write("Docs syntax highlighting differs between the light and dark themes:\n");
  for (const failure of failures) process.stderr.write(`  ${failure}\n`);
  process.exit(1);
}
process.stdout.write(
  `docs highlighting: ${tokens} tokens in ${partners.light.size} color pairs on ${files.length} pages\n`,
);
