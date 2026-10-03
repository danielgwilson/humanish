#!/usr/bin/env node
// Counts two kinds of drift in the site stylesheet. Each count is held to its cap in
// scripts/caps.json, at `site.<kind>`, by the rules in lib/caps.mjs: a count above or below its cap
// fails, and so does a count with no cap.
//
// - `css-hex-literals`: a hex color written into a rule. Colors are custom properties, defined in
//   the token blocks at the top of the stylesheet, and rules read them with var().
// - `unused-classes`: a class the stylesheet styles that no file under `SOURCES` names. A class
//   built from a template (`chip-${kind}`) is named when its prefix is.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CAPS_FILE, flattenCaps, holdToCaps, readCaps } from "./lib/caps.mjs";

const STYLESHEET = "site/app/globals.css";
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

const { flat, invalid } = flattenCaps(readCaps(values.caps));
if (invalid.length > 0) {
  process.stderr.write(`${values.caps}: not a whole number at ${invalid.join(", ")}.\n`);
  process.exit(2);
}
const { ok, rose } = holdToCaps({
  caps: new Map([...flat].filter(([path]) => path.startsWith("site."))),
  counts: new Map([
    ["site.css-hex-literals", hexLiterals],
    ["site.unused-classes", unusedClasses],
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
