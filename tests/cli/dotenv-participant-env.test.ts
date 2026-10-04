// A name a `--dotenv` file sets reaches the run but never the Claude Code participant on the host.
// Its own file: the record of names `--dotenv` set lives for the module's lifetime.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { claudeParticipantEnv } from "../../src/actors/local-agent/claude-participant.js";
import { applyEnvFileOption, type CliIo } from "../../src/cli/io.js";

describe("--dotenv and the Claude Code participant", () => {
  it("loads a name for the run and leaves it out of the participant's environment", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "humanish-dotenv-participant-"));
    try {
      await writeFile(
        path.join(directory, ".env"),
        "HTTPS_PROXY=http://proxy.example:1\nSYNTHETIC_APP_SECRET=synthetic\n",
      );
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: directory };
      const io: CliIo = { writeOut: () => {}, writeErr: () => {}, setExitCode: () => {} };
      const applied = await applyEnvFileOption({
        command: new Command(),
        cwd: directory,
        envFile: ".env",
        io,
        env,
        discoverKeys: false,
      });
      expect(applied).toBe(true);
      expect(env.HTTPS_PROXY).toBe("http://proxy.example:1");
      expect(claudeParticipantEnv(env)).toEqual({
        PATH: "/usr/bin",
        HOME: directory,
        CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
