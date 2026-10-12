import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve("scripts/packed-check.sh");

describe("packed-check.sh command line", () => {
  // A full run packs the tree and takes minutes, so the suite checks only the refusals. Each one
  // must stop before npm pack runs or a work directory is made under `TMPDIR`.
  it.each([
    [["humanish"]],
    [["--", "other-package@1.0.0"]],
    [["humanish@1.0.0", "extra"]],
    [["./humanish-1.0.0.tgz"]],
  ])("refuses %j with exit 2 and writes nothing", (args) => {
    const temp = mkdtempSync(join(tmpdir(), "packed-check-args-"));
    try {
      const result = spawnSync("bash", [script, ...args], {
        encoding: "utf8",
        env: { ...process.env, TMPDIR: temp },
        timeout: 10_000,
      });
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/^usage: /);
      expect(readdirSync(temp)).toEqual([]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
