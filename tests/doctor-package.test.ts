import { execFile } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/init.js";
import { doctor } from "../src/run.js";

const execFileAsync = promisify(execFile);
const env = { HUMANISH_STRICT_KEYS: "1", PATH: "" };
const options = { lab: "first-run", env, localAgents: { which: async () => undefined } };

async function standaloneProject(check: (cwd: string, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "humanish-doctor-package-"));
  const cwd = path.join(root, "project");
  await mkdir(cwd);
  try {
    const initialized = await runInit({ cwd, yes: true, env });
    expect(initialized.ok).toBe(true);
    expect(initialized.warnings).toContain("Skipped package.json scripts because package.json was not found.");
    await check(cwd, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("doctor's optional project package metadata", () => {
  it("accepts an initialized standalone project's keyless first-run without inventing package.json", async () => {
    await standaloneProject(async cwd => {
      const result = await doctor(cwd, options);
      expect(result.ok).toBe(true);
      expect(result.checks.find(check => check.name === "package.json")).toMatchObject({
        ok: true, message: expect.stringContaining("optional for Humanish")
      });
      await expect(lstat(path.join(cwd, "package.json"))).rejects.toMatchObject({ code: "ENOENT" });

      await writeFile(path.join(cwd, "package.json"), "{}\n");
      expect((await doctor(cwd, options)).checks.find(check => check.name === "package.json")).toMatchObject({
        ok: true, message: "package.json is present and safe to read"
      });
    });
  });

  it.each(["symlink", "dangling symlink", "hardlink", "directory", "fifo"] as const)(
    "still refuses a %s package.json instead of treating it as absent", async kind => {
      await standaloneProject(async (cwd, root) => {
        const outside = path.join(root, "outside.json");
        const sentinel = '{"name":"synthetic-outside-sentinel"}\n';
        await writeFile(outside, sentinel);
        const target = path.join(cwd, "package.json");
        if (kind === "symlink") await symlink(outside, target);
        else if (kind === "dangling symlink") await symlink(path.join(root, "missing.json"), target);
        else if (kind === "hardlink") await link(outside, target);
        else if (kind === "directory") await mkdir(target);
        else await execFileAsync("mkfifo", [target]);

        const result = await doctor(cwd, options);
        expect(result.ok).toBe(false);
        expect(result.checks.filter(check => !check.ok).map(check => check.name)).toEqual(["package.json"]);
        expect(result.checks.find(check => check.name === "package.json")?.message).toBe("package.json could not be safely read");
        expect(JSON.stringify(result)).not.toContain("synthetic-outside-sentinel");
        expect(await readFile(outside, "utf8")).toBe(sentinel);
      });
    }
  );

  it.skipIf(process.getuid?.() === 0)("still refuses an unreadable regular package.json", async () => {
    await standaloneProject(async cwd => {
      const target = path.join(cwd, "package.json");
      await writeFile(target, "{}\n");
      await chmod(target, 0o000);
      try {
        const result = await doctor(cwd, options);
        expect(result.ok).toBe(false);
        expect(result.checks.filter(check => !check.ok).map(check => check.name)).toEqual(["package.json"]);
        expect(result.checks.find(check => check.name === "package.json")?.message).toBe("package.json could not be safely read");
      } finally {
        await chmod(target, 0o600);
      }
    });
  });
});
