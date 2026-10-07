import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatKeyStatus, keyStatus } from "../../src/keys/key-status.js";

describe("humanish keys status", () => {
  let cwd: string;
  let home: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-key-status-cwd-"));
    home = await mkdtemp(path.join(tmpdir(), "humanish-key-status-home-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  const deps = (ghToken: string | null = null) => ({
    homeDir: home,
    execText: async () => ghToken,
  });

  it("names the source of each set key and the command that adds each missing one", async () => {
    await mkdir(path.join(home, ".e2b"), { recursive: true });
    await writeFile(
      path.join(home, ".e2b", "config.json"),
      JSON.stringify({ teamApiKey: "synthetic-e2b-value" }),
    );
    await mkdir(path.join(home, ".config", "humanish"), { recursive: true });
    await writeFile(
      path.join(home, ".config", "humanish", "keys.env"),
      "OPENAI_API_KEY=synthetic-openai-value\n",
    );

    const rows = await keyStatus({ cwd, env: {}, deps: deps() });
    const text = formatKeyStatus(rows);

    expect(rows.map((row) => [row.name, row.source])).toEqual([
      ["E2B_API_KEY", "~/.e2b/config.json (e2b auth login)"],
      ["OPENAI_API_KEY", "~/.config/humanish/keys.env"],
      ["GH_TOKEN", null],
      ["AGENTMAIL_API_KEY", null],
    ]);
    expect(text).toContain("~/.e2b/config.json (e2b auth login)");
    expect(text).toContain("~/.config/humanish/keys.env");
    expect(text).toContain("humanish keys set github");
    expect(text).toContain("humanish keys set agentmail");
    expect(text).not.toContain("synthetic-");
  });

  it("reports keys from the environment, the project file and gh auth token", async () => {
    await mkdir(path.join(cwd, ".humanish", "local"), { recursive: true });
    await writeFile(
      path.join(cwd, ".humanish", "local", "provider.env"),
      "AGENTMAIL_API_KEY=synthetic-agentmail-value\n",
    );

    const rows = await keyStatus({
      cwd,
      env: { OPENAI_API_KEY: "synthetic-env-value" },
      deps: deps("synthetic-gh-value"),
    });

    expect(rows.map((row) => [row.name, row.source])).toEqual([
      ["E2B_API_KEY", null],
      ["OPENAI_API_KEY", "process env"],
      ["GH_TOKEN", "gh auth token"],
      ["AGENTMAIL_API_KEY", ".humanish/local/provider.env"],
    ]);
    expect(formatKeyStatus(rows)).not.toContain("synthetic-");
  });
});
