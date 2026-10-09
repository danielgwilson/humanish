#!/usr/bin/env node
/**
 * Refetch the font subsets the Open Graph images draw with (lib/og-image.tsx) into lib/og-fonts/.
 * Google Fonts cuts each file down to the glyphs of its text, and answers a plain Node fetch with
 * TrueType, which satori reads. Run it after an OG line gains a character, check the rendered
 * images, then update the sha256 pins in scripts/public-surface-scan.mjs at the repo root:
 *
 *     node site/scripts/fetch-og-fonts.mjs
 */
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The lines app/opengraph-image.tsx and app/demo/opengraph-image.tsx pass to ogImage().
const LINES = [
  "User testing for the users you can’t recruit",
  "Eight synthetic participants, one app, seven findings",
];
const lineGlyphs = [...new Set(LINES.join(""))].sort().join("");

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "og-fonts");
const SUBSETS = [
  ["geist-600-human.ttf", "Geist:wght@600", "human"],
  ["newsreader-300-parens.ttf", "Newsreader:wght@300", "()"],
  ["newsreader-italic-400-ish.ttf", "Newsreader:ital,wght@1,400", "ish"],
  ["newsreader-italic-300-lines.ttf", "Newsreader:ital,wght@1,300", lineGlyphs],
];

for (const [file, family, text] of SUBSETS) {
  const url = `https://fonts.googleapis.com/css2?family=${family}&text=${encodeURIComponent(text)}`;
  const css = await (await fetch(url)).text();
  const src = /src: url\((.+)\) format\('truetype'\)/.exec(css)?.[1];
  if (!src) throw new Error(`No TrueType source for ${family} in ${url}`);
  const font = await fetch(src);
  if (!font.ok) throw new Error(`${src} answered ${font.status}`);
  const bytes = Buffer.from(await font.arrayBuffer());
  await writeFile(join(OUT, file), bytes);
  process.stdout.write(
    `site/lib/og-fonts/${file}: ${bytes.length} bytes, ${JSON.stringify(text)}\n`,
  );
}
