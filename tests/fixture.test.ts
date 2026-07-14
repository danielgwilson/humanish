import { execFile } from "node:child_process";
import { cp, link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { runInit } from "../src/init.js";

const fixturePath = path.resolve("fixtures/minimal-app");
const execFileAsync = promisify(execFile);

describe("minimal target app fixture", () => {
  it("is public-safe source material for init dry-runs", async () => {
    const result = await runInit({
      cwd: fixturePath,
      dryRun: true
    });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("dry-run");
    expect(result.changes.some((change) => change.path === "humanish/config.ts")).toBe(true);
    await expect(stat(path.join(fixturePath, "humanish"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("can be copied to a temp app and initialized without committing runtime artifacts", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "humanish-fixture-copy-"));
    const tempApp = path.join(tempRoot, "minimal-app");

    try {
      await cp(fixturePath, tempApp, { recursive: true });
      const result = await runInit({
        cwd: tempApp,
        yes: true
      });

      expect(result.ok).toBe(true);
      await expect(stat(path.join(tempApp, "humanish/scenarios/first-run-smoke.yaml"))).resolves.toBeTruthy();
      await expect(stat(path.join(tempApp, ".humanish/runs"))).resolves.toBeTruthy();

      const gitignore = await readFile(path.join(tempApp, ".gitignore"), "utf8");
      expect(gitignore).toContain(".humanish/");
      expect(gitignore.lastIndexOf("!.env.example")).toBeGreaterThan(gitignore.lastIndexOf(".env*"));
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects a hardlinked init target without mutating the external inode", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "humanish-init-hardlink-"));
    const tempApp = path.join(tempRoot, "app");
    const externalPackage = path.join(tempRoot, "external-package.json");
    const original = "{\"name\":\"external-sentinel\"}\n";

    try {
      await mkdir(tempApp);
      await writeFile(externalPackage, original, "utf8");
      await link(externalPackage, path.join(tempApp, "package.json"));

      const result = await runInit({ cwd: tempApp, yes: true });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("HUMANISH_UNSAFE_PROJECT_PATH");
      expect(result.error?.message).toContain("hardlinked files");
      expect(await readFile(externalPackage, "utf8")).toBe(original);
      await expect(stat(path.join(tempApp, "humanish"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("returns a structured error when init targets have the wrong filesystem kind", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "humanish-init-wrong-kind-"));
    const packageDirectoryApp = path.join(tempRoot, "package-directory");
    const runtimeFileApp = path.join(tempRoot, "runtime-file");

    try {
      await mkdir(path.join(packageDirectoryApp, "package.json"), { recursive: true });
      const packageResult = await runInit({ cwd: packageDirectoryApp, yes: true });

      expect(packageResult).toMatchObject({
        ok: false,
        error: { code: "HUMANISH_UNSAFE_PROJECT_PATH" }
      });
      expect(packageResult.error?.message).toContain("package.json");
      await expect(stat(path.join(packageDirectoryApp, "humanish"))).rejects.toMatchObject({ code: "ENOENT" });

      await mkdir(runtimeFileApp, { recursive: true });
      await writeFile(path.join(runtimeFileApp, ".humanish"), "not-a-directory\n", "utf8");
      const runtimeResult = await runInit({ cwd: runtimeFileApp, yes: true });

      expect(runtimeResult).toMatchObject({
        ok: false,
        error: { code: "HUMANISH_UNSAFE_PROJECT_PATH" }
      });
      expect(runtimeResult.error?.message).toContain(".humanish/runs");
      await expect(stat(path.join(runtimeFileApp, "humanish"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects a FIFO init target without opening or blocking on it", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "humanish-init-fifo-"));
    const tempApp = path.join(tempRoot, "app");

    try {
      await mkdir(tempApp);
      await execFileAsync("mkfifo", [path.join(tempApp, ".gitignore")]);

      const result = await Promise.race([
        runInit({ cwd: tempApp, yes: true }),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("runInit blocked while inspecting a FIFO")), 1_000);
        })
      ]);

      expect(result).toMatchObject({
        ok: false,
        error: { code: "HUMANISH_UNSAFE_PROJECT_PATH" }
      });
      expect(result.error?.message).toContain(".gitignore");
      await expect(stat(path.join(tempApp, "humanish"))).rejects.toMatchObject({ code: "ENOENT" });
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
