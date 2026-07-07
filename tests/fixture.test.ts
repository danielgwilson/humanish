import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runInit } from "../src/init.js";

const fixturePath = path.resolve("fixtures/minimal-app");

describe("minimal target app fixture", () => {
  it("is public-safe source material for init dry-runs", async () => {
    const result = await runInit({
      cwd: fixturePath,
      dryRun: true
    });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("dry-run");
    expect(result.changes.some((change) => change.path === "homun/config.ts")).toBe(true);
    await expect(stat(path.join(fixturePath, "homun"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("can be copied to a temp app and initialized without committing runtime artifacts", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "homun-fixture-copy-"));
    const tempApp = path.join(tempRoot, "minimal-app");

    try {
      await cp(fixturePath, tempApp, { recursive: true });
      const result = await runInit({
        cwd: tempApp,
        yes: true
      });

      expect(result.ok).toBe(true);
      await expect(stat(path.join(tempApp, "homun/scenarios/first-run-smoke.yaml"))).resolves.toBeTruthy();
      await expect(stat(path.join(tempApp, ".homun/runs"))).resolves.toBeTruthy();

      const gitignore = await readFile(path.join(tempApp, ".gitignore"), "utf8");
      expect(gitignore).toContain(".homun/");
      expect(gitignore.lastIndexOf("!.env.example")).toBeGreaterThan(gitignore.lastIndexOf(".env*"));
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("contains only synthetic, non-secret fixture content", async () => {
    const files = [
      "README.md",
      ".env.example",
      "package.json",
      "src/server.mjs"
    ];
    const joined = (
      await Promise.all(files.map((file) => readFile(path.join(fixturePath, file), "utf8")))
    ).join("\n");

    expect(joined).toContain("synthetic.user@example.test");
    expect(joined).not.toMatch(/sk-[a-z0-9]/i);
    expect(joined).not.toMatch(/BEGIN (RSA|OPENSSH|PRIVATE) KEY/);
  });
});
