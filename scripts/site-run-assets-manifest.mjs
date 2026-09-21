#!/usr/bin/env node
// Regenerates site/public/runs/ASSETS.sha256.json: one sha256 per capture the site publishes
// from a kept run bundle. scripts/public-surface-scan.mjs reads it as the allowlist for those
// binaries. Run after adding or replacing captures, then review the diff before committing.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = "site/public/runs";
const manifestPath = join(root, "ASSETS.sha256.json");
const previous = JSON.parse(readFileSync(manifestPath, "utf8"));
const assets = {};
function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(jpe?g|png)$/i.test(name)) assets[p] = createHash("sha256").update(readFileSync(p)).digest("hex");
  }
}
walk(root);
writeFileSync(manifestPath, `${JSON.stringify({ note: previous.note, assets }, null, 1)}\n`);
console.log(`${Object.keys(assets).length} run captures pinned in ${manifestPath}`);
