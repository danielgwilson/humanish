// A study that names a persona needs its file before it runs. Route tests whose studies name a
// persona only to label their participants write these minimal files into their project.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Writes `humanish/personas/<id>.yaml` under `cwd` for each id, with a schema, the id and the id as
 * its name. Its prompt section starts with the `Persona: <id>.` line a label-only persona gave, then
 * the medium patience and technical confidence directives. It has no background.
 */
export async function writePersonaFiles(cwd: string, ...ids: readonly string[]): Promise<void> {
  const directory = path.join(cwd, "humanish", "personas");
  await mkdir(directory, { recursive: true });
  for (const id of ids)
    await writeFile(
      path.join(directory, `${id}.yaml`),
      `schema: humanish.persona.v1\nid: ${id}\nname: ${id}\n`,
    );
}
