import { readdir } from "node:fs/promises";
import path from "node:path";

import { resolveLabManifest } from "../../src/lab/discover.js";
import type { LabConfig } from "../../src/lab/types.js";

// The labs committed under humanish/labs, each resolved by its file path. Discovery also lists a
// developer's local labs (.humanish/labs, .humanish/local/labs), and resolving a lab by id picks a
// local file whenever no committed file has that id as its name. Reading the directory by path
// names only committed files, whatever local labs a checkout holds.

/** Every committed lab under `root`, as [id, config] pairs sorted by id. */
export async function committedLabs(root: string): Promise<[string, LabConfig][]> {
  const dir = path.join("humanish", "labs");
  const names = (await readdir(path.join(root, dir))).filter((name) => /\.ya?ml$/.test(name));
  const labs: [string, LabConfig][] = [];
  for (const name of names) {
    const resolved = await resolveLabManifest(root, path.join(dir, name));
    if (!resolved.ok) throw new Error(`${name}: ${resolved.error.message}`);
    labs.push([resolved.config.id, resolved.config]);
  }
  return labs.sort(([left], [right]) => left.localeCompare(right));
}
