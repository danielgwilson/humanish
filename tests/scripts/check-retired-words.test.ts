import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve("scripts/check-retired-words.ts");

/** The --max-* flags package.json's vocabulary:check script passes. */
function packageFlags(): string[] {
  const scripts = (
    JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  return scripts["vocabulary:check"]!.split(" ").filter((arg) => arg.startsWith("--max-"));
}

/** Runs the checker over this repo's src/ and returns its exit status and stdout. */
function run(args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
      encoding: "utf8",
    });
    return { status: 0, stdout };
  } catch (error) {
    const failed = error as { status: number; stdout: string };
    return { status: failed.status, stdout: failed.stdout };
  }
}

describe("vocabulary:check needs a cap for every count", () => {
  it("fails when a word has no --max flag, naming the flag and today's count", () => {
    const flags = packageFlags();
    const study = flags.find((flag) => flag.startsWith("--max-study="))!;
    const result = run(flags.filter((flag) => flag !== study));

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/--max-study=\d+/);
    const count = /^study: (\d+)$/m.exec(result.stdout)?.[1];
    expect(result.stdout).toContain(`--max-study=${count}`);
  });
});
