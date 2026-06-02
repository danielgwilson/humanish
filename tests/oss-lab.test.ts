import { CommanderError } from "commander";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_OSS_REPOS,
  normalizeOssRepoSlugs,
  validateOssRepoSlug
} from "../src/oss-lab.js";
import { createProgram } from "../src/program.js";

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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
  for (const command of program.commands) {
    command.exitOverride();
    for (const nested of command.commands) {
      nested.exitOverride();
    }
  }

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

describe("OSS lab command", () => {
  it("keeps default repo selection lightweight and public", () => {
    expect(normalizeOssRepoSlugs(undefined)).toEqual([...DEFAULT_OSS_REPOS]);
    expect(normalizeOssRepoSlugs([" developit/mitt ", "developit/mitt", "lukeed/clsx"])).toEqual([
      "developit/mitt",
      "lukeed/clsx"
    ]);
  });

  it("accepts only GitHub owner/repo slugs", () => {
    expect(validateOssRepoSlug("developit/mitt")).toBe(true);
    expect(validateOssRepoSlug("sindresorhus/is-plain-obj")).toBe(true);
    expect(validateOssRepoSlug("https://github.com/developit/mitt")).toBe(false);
    expect(validateOssRepoSlug("git@github.com:developit/mitt.git")).toBe(false);
    expect(validateOssRepoSlug("../private/repo")).toBe(false);
  });

  it("exposes lab oss help with disposable-clone safety", async () => {
    const result = await runCli(["lab", "oss", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: mimetic lab oss");
    expect(result.stdout).toContain("Clone lightweight public OSS repos");
    expect(result.stdout).toContain("--keep");
    expect(result.stdout).toContain("removed by default");
  });
});
