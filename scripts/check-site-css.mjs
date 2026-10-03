#!/usr/bin/env node
// Counts kinds of drift in the site and Observer stylesheets. Each count is held to its cap in
// scripts/caps.json, at `site.<kind>` or `observer.<kind>`, by the rules in lib/caps.mjs: a count
// above or below its cap fails, and so does a count with no cap.
//
// - `site.css-hex-literals`: a hex color written into a rule. Colors are custom properties, defined
//   in the token blocks at the top of the stylesheet, and rules read them with var().
// - `site.unused-classes`: a class the stylesheet styles that no file under `SOURCES` names. A class
//   built from a template (`chip-${kind}`) is named when its prefix is.
// - `site.literal-sizes`, `observer.literal-sizes`: a px font size, gap, padding, margin or radius
//   written into a rule instead of read from the scale's --text-*, --space-* and --radius-* tokens.
//   0, a 1px hairline and terms inside calc(), clamp(), min() and max() are not counted.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CAPS_FILE, flattenCaps, holdToCaps, readCaps } from "./lib/caps.mjs";

const STYLESHEET = "site/app/globals.css";
const SITE_STYLESHEETS = [STYLESHEET, "site/app/docs/docs.css"];
// styles/humanish/ is vendored from the component registry, which site/app/globals.css generates.
const OBSERVER_STYLES = "observer/styles";
const SOURCES = ["site/app", "site/components", "site/lib", "site/content"];
// Shiki puts this class on the docs' highlighted code blocks.
const LIBRARY_CLASSES = new Set(["shiki"]);

const { values } = parseArgs({
  options: {
    list: { type: "boolean", default: false },
    caps: { type: "string", default: CAPS_FILE },
    root: { type: "string", default: "." },
  },
});

// Comments are blanked, keeping their line breaks so line numbers still match the file.
const css = readFileSync(join(values.root, STYLESHEET), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  (comment) => comment.replace(/[^\n]/g, " "),
);
const lineOf = (index) => css.slice(0, index).split("\n").length;

const hexLiterals = [];
const styled = new Map();
// Text before `{` is a selector or an at-rule prelude; text before `;` or `}` is a declaration.
for (const match of css.matchAll(/([^;{}]*)([;{}])/g)) {
  const [, text, end] = match;
  if (end === "{") {
    if (/^\s*@/.test(text)) continue;
    for (const name of text.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
      if (!styled.has(name[1])) styled.set(name[1], lineOf(match.index + name.index));
    }
  } else if (!/^\s*--/.test(text)) {
    for (const hex of text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      hexLiterals.push(`${STYLESHEET}:${lineOf(match.index + hex.index)} ${hex[0]}`);
    }
  }
}

const words = new Set();
const prefixes = [];
for (const entry of SOURCES.flatMap((dir) =>
  readdirSync(join(values.root, dir), { recursive: true, withFileTypes: true }),
)) {
  // A route folder can be named like a file (app/llms.md/).
  if (!entry.isFile() || !/\.(?:tsx?|mdx?|mjs|json)$/.test(entry.name)) continue;
  const text = readFileSync(join(entry.parentPath, entry.name), "utf8");
  for (const word of text.matchAll(/[_a-zA-Z][\w-]*/g)) words.add(word[0]);
  for (const prefix of text.matchAll(/([_a-zA-Z][\w-]*-)\$\{/g)) prefixes.push(prefix[1]);
}
const unusedClasses = [...styled]
  .filter(
    ([name]) =>
      !LIBRARY_CLASSES.has(name) &&
      !words.has(name) &&
      !prefixes.some((prefix) => name.startsWith(prefix)),
  )
  .map(([name, line]) => `${STYLESHEET}:${line} .${name}`);

const SIZE_PROPERTY =
  /^(font-size|gap|row-gap|column-gap|padding(-[a-z]+)*|margin(-[a-z]+)*|border(-[a-z]+)*-radius)$/;

/** Every px size written into a rule of `file`, as "file:line value". */
function literalSizes(file) {
  const text = readFileSync(join(values.root, file), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    (comment) => comment.replace(/[^\n]/g, " "),
  );
  const hits = [];
  for (const match of text.matchAll(/([^;{}]*)([;{}])/g)) {
    if (match[2] === "{") continue;
    const declaration = /^\s*([a-z-]+)\s*:\s*([\s\S]*)$/.exec(match[1]);
    if (!declaration || !SIZE_PROPERTY.test(declaration[1])) continue;
    if (/\b(calc|clamp|min|max)\(/.test(declaration[2])) continue;
    for (const px of declaration[2].matchAll(/(?<![\w.-])-?(\d+(?:\.\d+)?)px\b/g)) {
      if (Number(px[1]) <= 1) continue;
      const line =
        text.slice(0, match.index).split("\n").length + (match[1].match(/^\s*\n/g)?.length ?? 0);
      hits.push(`${file}:${line} ${declaration[1]}: ${px[0]}`);
    }
  }
  return hits;
}
const observerStylesheets = readdirSync(join(values.root, OBSERVER_STYLES))
  .filter((name) => name.endsWith(".css"))
  .map((name) => join(OBSERVER_STYLES, name));

const { flat, invalid } = flattenCaps(readCaps(values.caps));
if (invalid.length > 0) {
  process.stderr.write(`${values.caps}: not a whole number at ${invalid.join(", ")}.\n`);
  process.exit(2);
}
const { ok, rose } = holdToCaps({
  caps: new Map([...flat].filter(([path]) => /^(site|observer)\./.test(path))),
  counts: new Map([
    ["site.css-hex-literals", hexLiterals],
    ["site.unused-classes", unusedClasses],
    ["site.literal-sizes", SITE_STYLESHEETS.flatMap(literalSizes)],
    ["observer.literal-sizes", observerStylesheets.flatMap(literalSizes)],
  ]),
  list: values.list,
  file: values.caps,
  write: (text) => process.stdout.write(text),
});
if (rose.length > 0) {
  process.stdout.write(
    "A count rose. `node scripts/check-site-css.mjs --list` prints every hit with its line. Read\n" +
      "a color from a token in the blocks at the top of the stylesheet, and delete a rule no\n" +
      "component uses.\n",
  );
}
if (!ok) process.exitCode = 1;
