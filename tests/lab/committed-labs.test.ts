// The plan goldens pin every committed lab, so a developer's local labs must not change which labs
// they read. These fixtures plant local labs that share a committed lab's id, and one whose file
// name is the id of a committed lab stored under another name.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { LAB_CONFIG_SCHEMA } from "../../src/lab/types.js";
import { committedLabs } from "../helpers/committed-labs.js";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function lab(id: string, title: string): string {
  return `schema: ${LAB_CONFIG_SCHEMA}
id: ${id}
title: ${title}
subject:
  source: this-repo
actors:
  - type: synthetic-persona
`;
}

async function plant(root: string, file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), contents);
}

describe("committedLabs", () => {
  it("reads only humanish/labs when local labs share committed ids", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "humanish-committed-labs-"));
    dirs.push(root);
    await plant(root, "humanish/labs/demo.yaml", lab("demo", "committed demo"));
    // A committed lab whose file name is not its id: resolving it by id finds the local file.
    await plant(root, "humanish/labs/second.yaml", lab("second-lab", "committed second"));
    for (const dir of [".humanish/labs", ".humanish/local/labs"]) {
      await plant(root, `${dir}/demo.yaml`, lab("demo", "local demo"));
      await plant(root, `${dir}/second-lab.yaml`, lab("second-lab", "local second"));
      await plant(root, `${dir}/extra.yaml`, lab("extra", "local only"));
    }

    const labs = await committedLabs(root);

    expect(labs.map(([id, config]) => [id, config.title])).toEqual([
      ["demo", "committed demo"],
      ["second-lab", "committed second"],
    ]);
  });
});
