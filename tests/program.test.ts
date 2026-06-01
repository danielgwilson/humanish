import { CommanderError } from "commander";
import { describe, expect, it } from "vitest";

import { CLI_RESPONSE_SCHEMA, createProgram } from "../src/program.js";

interface CliResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

async function runCli(args: string[]): Promise<CliResult> {
  let exitCode = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: (text) => stderr.push(text),
    setExitCode: (code) => {
      exitCode = code;
    }
  });

  program.exitOverride();

  try {
    await program.parseAsync(["node", "mimetic", ...args], { from: "node" });
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") {
      return {
        exitCode: 0,
        stderr: stderr.join(""),
        stdout: stdout.join("")
      };
    }

    throw error;
  }

  return {
    exitCode,
    stderr: stderr.join(""),
    stdout: stdout.join("")
  };
}

describe("mimetic CLI scaffold", () => {
  it("prints useful Commander help", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: mimetic [options] [command]");
    expect(result.stdout).toContain("init");
    expect(result.stdout).toContain("doctor");
    expect(result.stdout).toContain("feedback");
    expect(result.stdout).toContain("Public-safety boundary");
  });

  it("fails closed with a JSON envelope for planned commands", async () => {
    const result = await runCli(["init", "--dry-run", "--json"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");

    const envelope = JSON.parse(result.stdout) as {
      schema: string;
      ok: boolean;
      command: string;
      error: { code: string };
      capabilities: {
        githubMutation: boolean;
        productionData: boolean;
        providerSpend: boolean;
      };
    };

    expect(envelope.schema).toBe(CLI_RESPONSE_SCHEMA);
    expect(envelope.ok).toBe(false);
    expect(envelope.command).toBe("init");
    expect(envelope.error.code).toBe("MIMETIC_UNIMPLEMENTED");
    expect(envelope.capabilities).toEqual({
      githubMutation: false,
      productionData: false,
      providerSpend: false
    });
  });

  it("does not imply GitHub mutation for feedback issue output", async () => {
    const result = await runCli([
      "feedback",
      "issue",
      "--run",
      "latest",
      "--repo",
      "example/app",
      "--format",
      "markdown",
      "--json"
    ]);

    const envelope = JSON.parse(result.stdout) as {
      command: string;
      capabilities: { githubMutation: boolean };
      issue: string;
    };

    expect(result.exitCode).toBe(2);
    expect(envelope.command).toBe("feedback issue");
    expect(envelope.capabilities.githubMutation).toBe(false);
    expect(envelope.issue).toBe("https://github.com/danielgwilson/mimetic-cli/issues/5");
  });

  it("writes human unsupported-command output to stderr", async () => {
    const result = await runCli(["run", "--dry-run"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("mimetic run is planned but not implemented yet.");
    expect(result.stderr).toContain("does not mutate GitHub");
  });
});
