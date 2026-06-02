import { CommanderError } from "commander";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_OSS_REPOS,
  normalizeOssRepoSlugs,
  validateOssRepoSlug
} from "../src/oss-lab.js";
import {
  buildOssRepoAssignments
} from "../src/oss-meta-lab.js";
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
    expect(normalizeOssRepoSlugs(["developit/mitt,lukeed/clsx"])).toEqual([
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

  it("assigns repos across requested headed desktop lanes", () => {
    expect(buildOssRepoAssignments(["developit/mitt", "lukeed/clsx"], 4).map((assignment) => assignment.repo)).toEqual([
      "developit/mitt",
      "lukeed/clsx",
      "developit/mitt",
      "lukeed/clsx"
    ]);
  });

  it("exposes lab oss help as the Observer-of-Observers meta-lab", async () => {
    const result = await runCli(["lab", "oss", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: mimetic lab oss");
    expect(result.stdout).toContain("Watch headed Codex/E2B OSS meta-sims");
    expect(result.stdout).toContain("--repos");
    expect(result.stdout).toContain("Observer-of-Observers");
    expect(result.stdout).toContain("mimetic lab oss-smoke");
  });

  it("keeps disposable-clone safety on lab oss-smoke", async () => {
    const result = await runCli(["lab", "oss-smoke", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: mimetic lab oss-smoke");
    expect(result.stdout).toContain("Clone lightweight public OSS repos");
    expect(result.stdout).toContain("--keep");
    expect(result.stdout).toContain("removed by default");
  });

  it("renders a no-network OSS meta-lab contract from --repos", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "mimetic-oss-meta-"));
    const result = await runCli([
      "lab",
      "oss",
      "--dry-run",
      "--json",
      "--no-open",
      "--cwd",
      cwd,
      "--run-id",
      "oss-meta-test",
      "--repos",
      "developit/mitt,lukeed/clsx",
      "--count",
      "4"
    ]);

    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout) as {
      assignments: Array<{ repo: string }>;
      observer: { observerPath: string };
      schema: string;
    };
    expect(json.schema).toBe("mimetic.oss-meta-lab-result.v1");
    expect(json.assignments.map((assignment) => assignment.repo)).toEqual([
      "developit/mitt",
      "lukeed/clsx",
      "developit/mitt",
      "lukeed/clsx"
    ]);
    expect(json.observer.observerPath).toBe(".mimetic/runs/oss-meta-test/observer/index.html");

    const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", "oss-meta-test", "run.json"), "utf8")) as {
      streams: Array<{
        terminal: { tail: string };
        ui: { route: string };
      }>;
    };
    expect(bundle.streams[0]?.terminal.tail).toContain("npx mimetic init --yes");
    expect(bundle.streams[0]?.ui.route).toBe("e2b://desktop/developit/mitt");
  });
});
