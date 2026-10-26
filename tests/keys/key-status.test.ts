import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  askForMissingKeys,
  formatKeyStatus,
  keyStatus,
  otherStoredKeys,
} from "../../src/keys/key-status.js";

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
      ["GEMINI_API_KEY", null],
      ["ANTHROPIC_API_KEY", null],
    ]);
    expect(text).toContain("~/.e2b/config.json (e2b auth login)");
    expect(text).toContain("~/.config/humanish/keys.env");
    expect(text).toContain("humanish keys set github");
    expect(text).toContain("humanish keys set agentmail");
    expect(text).not.toContain("synthetic-");
  });

  it("prints each key with its use and fill command, in the order the status lists them", async () => {
    const text = formatKeyStatus(await keyStatus({ cwd, env: {}, deps: deps() }));
    expect(text).toBe(
      [
        "E2B_API_KEY (hosted desktops): missing; run `e2b auth login`, or `humanish keys set e2b`",
        "OPENAI_API_KEY (participant model and analysis): missing; run `humanish keys set openai`",
        "GH_TOKEN (private repository subjects): missing; run `gh auth login`, or `humanish keys set github`",
        "AGENTMAIL_API_KEY (email in studies): missing; run `humanish keys set agentmail`",
        "GEMINI_API_KEY (analysis on Gemini): missing; run `humanish keys set gemini`",
        "ANTHROPIC_API_KEY (participant model on Anthropic): missing; run `humanish keys set anthropic`",
        "",
        "Values are never printed. `humanish keys set` asks for each missing key in turn.",
        "",
      ].join("\n"),
    );
  });

  it("names a stored key humanish does not use, so it does not look lost", async () => {
    await mkdir(path.join(home, ".config", "humanish"), { recursive: true });
    await writeFile(
      path.join(home, ".config", "humanish", "keys.env"),
      "OPENAI_API_KEY=synthetic-openai-value\nCODEX_API_KEY=synthetic-codex-value\n",
    );
    const others = otherStoredKeys({}, deps());
    expect(others).toEqual(["CODEX_API_KEY"]);
    const text = formatKeyStatus(await keyStatus({ cwd, env: {}, deps: deps() }), others);
    expect(text).toContain(
      "Also in the user store: CODEX_API_KEY. humanish does not use it today.",
    );
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
      ["GEMINI_API_KEY", null],
      ["ANTHROPIC_API_KEY", null],
    ]);
    expect(formatKeyStatus(rows)).not.toContain("synthetic-");
  });

  it("asks for each missing key in turn, stores the answers and skips a key on Enter", async () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "synthetic-env-value" };
    const answers: Record<string, string | null> = {
      E2B_API_KEY: "synthetic-e2b-entered",
      GH_TOKEN: "",
      AGENTMAIL_API_KEY: "synthetic-agentmail-entered",
      GEMINI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
    };
    const asked: string[] = [];

    const outcome = await askForMissingKeys({
      rows: await keyStatus({ cwd, env, deps: deps() }),
      env,
      deps: deps(),
      prompt: async (label) => {
        const name = label.split(" ")[0]!;
        asked.push(name);
        return answers[name] ?? null;
      },
    });

    expect(asked).toEqual([
      "E2B_API_KEY",
      "GH_TOKEN",
      "AGENTMAIL_API_KEY",
      "GEMINI_API_KEY",
      "ANTHROPIC_API_KEY",
    ]);
    expect(outcome).toEqual({
      stored: ["E2B_API_KEY", "AGENTMAIL_API_KEY"],
      skipped: ["GH_TOKEN", "GEMINI_API_KEY", "ANTHROPIC_API_KEY"],
    });
    const after = await keyStatus({ cwd, env, deps: deps() });
    expect(after.map((row) => [row.name, row.source])).toEqual([
      ["E2B_API_KEY", "~/.config/humanish/keys.env"],
      ["OPENAI_API_KEY", "process env"],
      ["GH_TOKEN", null],
      ["AGENTMAIL_API_KEY", "~/.config/humanish/keys.env"],
      ["GEMINI_API_KEY", null],
      ["ANTHROPIC_API_KEY", null],
    ]);
  });

  it("stops at a cancelled prompt and keeps the keys stored before it", async () => {
    const env: NodeJS.ProcessEnv = {};
    const asked: string[] = [];

    const outcome = await askForMissingKeys({
      rows: await keyStatus({ cwd, env, deps: deps() }),
      env,
      deps: deps(),
      prompt: async (label) => {
        asked.push(label.split(" ")[0]!);
        return asked.length === 1 ? "synthetic-e2b-entered" : null;
      },
    });

    expect(asked).toEqual(["E2B_API_KEY", "OPENAI_API_KEY"]);
    expect(outcome).toEqual({ stored: ["E2B_API_KEY"], skipped: [], stoppedAt: "OPENAI_API_KEY" });
  });
});
