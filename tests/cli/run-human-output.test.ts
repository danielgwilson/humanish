import { cp } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

describe("the dry run's human summary", () => {
  it("counts participants, not sims", async () => {
    const root = await makeTestTempDir("humanish-run-human-");
    const cwd = path.join(root, "minimal-app");
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    const stdout: string[] = [];
    const program = createProgram({
      writeOut: (text) => stdout.push(text),
      writeErr: () => {},
      setExitCode: () => {},
    });
    program.exitOverride();

    await program.parseAsync(["node", "humanish", "run", "--dry-run", "--cwd", cwd, "--no-open"], {
      from: "node",
    });

    const lines = stdout.join("").split("\n");
    expect(lines).toContain("humanish run dry-run");
    expect(lines.some((line) => /^participants: \d+$/.test(line))).toBe(true);
    expect(lines.some((line) => line.startsWith("sims:"))).toBe(false);
  });
});
