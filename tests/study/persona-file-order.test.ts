// A persona file humanish cannot use stops a live run before the route checks its keys, on both
// routes whose participants have personas, so a broken study file is reported before the machine.
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";

import { runStudy } from "../../src/run-study.js";
import { parseStudy } from "../../src/study/config.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";
import { lab } from "../admission/fixtures.js";

it.each(["cuAppUrl", "sharedExternal"] as const)(
  "reports a persona with an invalid background before missing keys on %s",
  async (base) => {
    const cwd = await makeTestTempDir("humanish-persona-order-");
    await mkdir(path.join(cwd, "humanish/personas"), { recursive: true });
    await writeFile(
      path.join(cwd, "humanish/personas/first-time-visitor.yaml"),
      "background: 123\n",
    );
    const parsed = parseStudy(lab(base, { mode: "live" }));
    if (!parsed.ok) throw new Error(parsed.error.message);
    await expect(runStudy(parsed.config, { cwd, env: {} })).rejects.toThrow("background");
    expect(await readdir(cwd)).toEqual(["humanish"]);
  },
);
