// doctor names the file that supplied a key when `--dotenv` loaded it, and keeps "process env" for
// a key the environment already had, which the loader never overrides.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { doctor } from "../../src/cli/doctor.js";

const noAgents = { which: async () => undefined };

describe("doctor's key rows after --dotenv", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-doctor-dotenv-"));
    await writeFile(path.join(cwd, ".gitignore"), ".humanish/\n");
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("names the dotenv file for the keys it loaded, and process env for the rest", async () => {
    const env: NodeJS.ProcessEnv = {
      HUMANISH_STRICT_KEYS: "1",
      PATH: "",
      E2B_API_KEY: "synthetic-from-file",
      OPENAI_API_KEY: "synthetic-from-env",
      XDG_CONFIG_HOME: path.join(cwd, "user-config"),
    };
    const result = await doctor(cwd, {
      env,
      localAgents: noAgents,
      dotenv: { path: "provider.env", names: ["E2B_API_KEY"] },
    });
    const row = (name: string) => result.checks.find((check) => check.name === `key ${name}`);
    expect(row("E2B_API_KEY")?.message).toContain("supplied by --dotenv provider.env");
    expect(row("OPENAI_API_KEY")?.message).toContain("supplied by process env");
    expect(JSON.stringify(result)).not.toContain("synthetic-");
  });
});
