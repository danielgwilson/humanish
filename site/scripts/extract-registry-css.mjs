/**
 * Extract per-item stylesheets for the @humanish component registry from
 * app/globals.css, which stays the single source of truth. Each registry
 * item ships the subset of rules its markup uses, selected by class token;
 * rules keep their document order, and @media blocks are filtered rule by
 * rule. Output lands in registry/css/<item>.css (committed — CI fails if
 * a rebuild produces a diff).
 *
 * Run via `pnpm registry:build`.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(site, "app", "globals.css"), "utf8");

/** Strip comments, then split top-level statements into {header, body}. */
function parseBlocks(css) {
  const out = [];
  let i = 0;
  while (i < css.length) {
    while (i < css.length && /\s/.test(css[i])) i++;
    if (i >= css.length) break;
    const start = i;
    while (i < css.length && css[i] !== "{" && css[i] !== ";") i++;
    if (css[i] === ";") {
      // statement without a block (e.g. @import) — never extracted
      i++;
      continue;
    }
    const header = css.slice(start, i).replace(/\s+/g, " ").trim();
    let depth = 0;
    const bodyStart = i;
    do {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    } while (i < css.length && depth > 0);
    out.push({ header, body: css.slice(bodyStart + 1, i - 1) });
  }
  return out;
}

const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "");
const blocks = parseBlocks(stripped);

const classTokens = (header) => [...header.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]);

const ITEMS = {
  "humanish-tokens": {
    match: (h) => h.startsWith(":root") || h.startsWith("@theme")
  },
  "terminal-cast": {
    include: ["vterm", "vln", "vp", "vok", "vdim", "vsum"],
    exclude: []
  },
  "persona-lane": {
    include: ["panel", "pbar", "pl", "pidx", "pname", "pr", "pmedia", "pcap", "prep", "plab", "chip", "chip-pass", "chip-dot", "chip-mute"],
    exclude: ["panel-dark", "vterm"]
  },
  "pinned-replay": {
    include: [
      "runband", "wt-track", "wt-sticky", "rail", "rail-k", "rtrack", "ritem", "ridx", "rtx",
      "stage", "panel", "panel-dark", "pbar", "pl", "pidx", "pname", "pr", "pbody", "pbody-brief",
      "pcap", "prep", "plab", "brief-facts", "code", "ledger", "lh", "lrow", "ln", "ld", "whint",
      "chip", "chip-pass", "chip-dot", "chip-mute"
    ],
    exclude: ["vterm", "vln", "vp", "vok", "vdim", "vsum", "study-notes", "pmedia", "tile-shot"]
  }
};

function keeps(item, header) {
  const spec = ITEMS[item];
  if (spec.match) return spec.match(header);
  const tokens = classTokens(header);
  if (!tokens.length) return false;
  return tokens.some((t) => spec.include.includes(t)) && !tokens.some((t) => spec.exclude.includes(t));
}

function render(header, body) {
  return `${header} {${body.replace(/\s+$/, "")}\n}`;
}

for (const item of Object.keys(ITEMS)) {
  const parts = [];
  for (const block of blocks) {
    if (block.header.startsWith("@media")) {
      const inner = parseBlocks(block.body).filter((b) => keeps(item, b.header));
      if (inner.length) {
        parts.push(`${block.header} {\n${inner.map((b) => "  " + render(b.header, b.body).replace(/\n/g, "\n  ")).join("\n")}\n}`);
      }
    } else if (keeps(item, block.header)) {
      parts.push(render(block.header, block.body));
    }
  }
  const banner =
    `/* @humanish/${item} — generated from app/globals.css by scripts/extract-registry-css.mjs.\n` +
    `   Do not edit by hand; edit globals.css and run \`pnpm registry:build\`.\n` +
    `   Assumes a border-box reset. Colors come from the humanish token system\n` +
    `   (@humanish/humanish-tokens); fonts fall back to system stacks unless\n` +
    `   --font-newsreader / --font-geist / --font-geist-mono are provided. */\n\n`;
  const outPath = join(site, "registry", "css", `${item}.css`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, banner + parts.join("\n\n") + "\n");
  console.log(`registry/css/${item}.css — ${parts.length} rule blocks`);
}
