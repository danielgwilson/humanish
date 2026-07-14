import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { runInit } from "../src/init.js";
import { renderObserver, serveObserver } from "../src/observer.js";
import { preflightOssMetaRepoAccess } from "../src/oss-meta-lab.js";
import { runOssLab } from "../src/oss-lab.js";
import { createProgram } from "../src/program.js";
import { doctor, listRuns, runDryRun, verifyRun } from "../src/run.js";
import { prepareRunArtifactPaths, validatePreparedRunArtifactPaths } from "../src/run-paths.js";
import { writePreparedRunLatestPointer } from "../src/selected-output-paths.js";

const execFileAsync = promisify(execFile);

async function withTempProject<T>(callback: (cwd: string, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "humanish-path-containment-"));
  const cwd = path.join(root, "project");
  await mkdir(cwd);
  try {
    return await callback(cwd, root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let exitCode = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: (text) => stderr.push(text),
    setExitCode: (code) => { exitCode = code; }
  });
  await program.parseAsync(["node", "humanish", ...args], { from: "node" });
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("run path containment", () => {
  it.each(["symlink", "hardlink", "fifo"] as const)(
    "fails Doctor safely for a %s .gitignore without following or blocking",
    async (kind) => {
      await withTempProject(async (cwd, root) => {
        await writeFile(path.join(cwd, "package.json"), '{"name":"doctor-containment"}\n', "utf8");
        await mkdir(path.join(cwd, "humanish"));
        const outside = path.join(root, `outside-gitignore-${kind}`);
        await writeFile(outside, ".humanish/\nOUTSIDE-SENTINEL\n", "utf8");
        const gitignore = path.join(cwd, ".gitignore");

        if (kind === "symlink") {
          await symlink(outside, gitignore);
        } else if (kind === "hardlink") {
          try {
            await link(outside, gitignore);
          } catch (error) {
            const code = error instanceof Error && "code" in error ? String(error.code) : "";
            if (["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(code)) return;
            throw error;
          }
        } else {
          await execFileAsync("mkfifo", [gitignore]);
        }

        const result = await Promise.race([
          doctor(cwd),
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error(`Doctor hung on ${kind} .gitignore`)), 1_000);
          })
        ]);

        expect(result.ok).toBe(false);
        expect(result.checks.find((check) => check.name === "target cwd")?.ok).toBe(true);
        expect(result.checks.find((check) => check.name === "package.json")?.ok).toBe(true);
        expect(result.checks.find((check) => check.name === "humanish source")?.ok).toBe(true);
        expect(result.checks.find((check) => check.name === "runtime ignore")?.ok).toBe(false);
        expect(await readFile(outside, "utf8")).toBe(".humanish/\nOUTSIDE-SENTINEL\n");
      });
    }
  );

  it("preserves safe legacy ids, explicit latest, and same-id overwrite", async () => {
    await withTempProject(async (cwd) => {
      for (const runId of ["UPPER_ID.v1", "café.v2_under", "..safe", "repeat--dash", "latest"]) {
        const first = await runDryRun({ cwd, dryRun: true, runId });
        expect(first.ok).toBe(true);
        expect(first.runId).toBe(runId);
        const second = await runDryRun({ cwd, dryRun: true, runId });
        expect(second.ok).toBe(true);
        expect((await verifyRun(cwd, "latest")).ok).toBe(true);
        expect((await verifyRun(cwd, runId === "latest" ? "latest" : runId)).ok).toBe(true);
      }
    });
  });

  it.each(["../escape", "nested/escape", "nested\\escape", "/absolute", "bad\0id", "latest.json"])(
    "rejects path-shaped run id %j before writing",
    async (runId) => {
      await withTempProject(async (cwd, root) => {
        const sentinel = path.join(root, "sentinel.txt");
        await writeFile(sentinel, "unchanged\n", "utf8");
        await expect(runDryRun({ cwd, dryRun: true, runId })).rejects.toThrow(/run id|path segment|reserved/i);
        expect(await readFile(sentinel, "utf8")).toBe("unchanged\n");
      });
    }
  );

  it("derives latest navigation from runId and rejects a mismatched pointer path", async () => {
    await withTempProject(async (cwd) => {
      await runDryRun({ cwd, dryRun: true, runId: "safe-run" });
      const pointerPath = path.join(cwd, ".humanish", "runs", "latest.json");
      const writePointer = (declaredPath: string): Promise<void> => writeFile(
        pointerPath,
        `${JSON.stringify({
          schema: "humanish.latest-run.v1",
          runId: "safe-run",
          path: declaredPath,
          updatedAt: new Date().toISOString()
        })}\n`,
        "utf8"
      );

      await writePointer(path.join(".humanish", "runs", "safe-run"));
      expect((await verifyRun(cwd, "latest")).ok).toBe(true);
      for (const invalidPath of [
        "/absolute/outside",
        "C:\\outside\\run",
        "\\\\server\\share\\run",
        path.join(".humanish", "runs", "other"),
        ".humanish/runs/other/../safe-run",
        path.join("..", "..", "outside")
      ]) {
        await writePointer(invalidPath);
        expect((await verifyRun(cwd, "latest")).ok, invalidPath).toBe(false);
      }
      expect((await verifyRun(cwd, "safe-run")).ok).toBe(true);
    });
  });

  it("emits one structured JSON error for an invalid CLI run id", async () => {
    await withTempProject(async (cwd) => {
      const result = await runCli(["run", "--dry-run", "--run-id", "../escape", "--cwd", cwd, "--json"]);
      expect(result.exitCode).toBe(2);
      const documents = result.stdout.trim().split(/\n(?=\{)/);
      expect(documents).toHaveLength(1);
      const envelope = JSON.parse(result.stdout) as { ok: boolean; error?: { code: string; message: string } };
      expect(envelope.ok).toBe(false);
      expect(envelope.error?.code).toBe("HUMANISH_UNEXPECTED");
      expect(envelope.error?.message).not.toContain(cwd);
      expect(result.stdout).not.toContain("at ");
    });
  });

  it("rejects symlinked storage roots, run directories, pointer files, and descendants", async () => {
    await withTempProject(async (cwd, root) => {
      const outside = path.join(root, "outside");
      await mkdir(outside);
      const sentinel = path.join(outside, "sentinel.txt");
      await writeFile(sentinel, "unchanged\n", "utf8");
      await symlink(outside, path.join(cwd, ".humanish"));
      await expect(runDryRun({ cwd, dryRun: true, runId: "blocked" })).rejects.toThrow(/symbolic link/i);
      expect(await readFile(sentinel, "utf8")).toBe("unchanged\n");
    });

    await withTempProject(async (cwd, root) => {
      const outside = path.join(root, "outside");
      await mkdir(outside);
      await mkdir(path.join(cwd, ".humanish"));
      await symlink(outside, path.join(cwd, ".humanish", "runs"));
      await expect(runDryRun({ cwd, dryRun: true, runId: "blocked" })).rejects.toThrow(/symbolic link/i);
    });

    await withTempProject(async (cwd, root) => {
      const outside = path.join(root, "outside");
      await mkdir(outside);
      await mkdir(path.join(cwd, ".humanish", "runs"), { recursive: true });
      await symlink(outside, path.join(cwd, ".humanish", "runs", "blocked"));
      await expect(runDryRun({ cwd, dryRun: true, runId: "blocked" })).rejects.toThrow(/symbolic link/i);
    });

    await withTempProject(async (cwd, root) => {
      await runDryRun({ cwd, dryRun: true, runId: "existing" });
      const outside = path.join(root, "outside.txt");
      await writeFile(outside, "unchanged\n", "utf8");
      await symlink(outside, path.join(cwd, ".humanish", "runs", "existing", "linked.txt"));
      const before = await readFile(path.join(cwd, ".humanish", "runs", "existing", "run.json"), "utf8");
      await expect(runDryRun({ cwd, dryRun: true, runId: "existing" })).rejects.toThrow(/symbolic link/i);
      expect(await readFile(path.join(cwd, ".humanish", "runs", "existing", "run.json"), "utf8")).toBe(before);
      expect(await readFile(outside, "utf8")).toBe("unchanged\n");
    });

    await withTempProject(async (cwd, root) => {
      await runDryRun({ cwd, dryRun: true, runId: "pointer-safe" });
      const pointer = path.join(cwd, ".humanish", "runs", "latest.json");
      const externalPointer = path.join(root, "external-latest.json");
      await rm(pointer);
      await writeFile(externalPointer, "{}\n", "utf8");
      await symlink(externalPointer, pointer);
      expect((await verifyRun(cwd, "latest")).ok).toBe(false);
      await expect(runDryRun({ cwd, dryRun: true, runId: "new-run" })).rejects.toThrow(/regular files|symbolic links/i);
      expect(await readFile(externalPointer, "utf8")).toBe("{}\n");
    });

    await withTempProject(async (cwd, root) => {
      await runDryRun({ cwd, dryRun: true, runId: "hardlink-safe" });
      const outside = path.join(root, "outside-hardlink.txt");
      const linked = path.join(cwd, ".humanish", "runs", "hardlink-safe", "linked.txt");
      await writeFile(outside, "unchanged\n", "utf8");
      try {
        await link(outside, linked);
      } catch (error) {
        const code = error instanceof Error && "code" in error ? String(error.code) : "";
        if (["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(code)) return;
        throw error;
      }
      await expect(prepareRunArtifactPaths(cwd, "hardlink-safe")).rejects.toThrow(/hardlink|single-link/i);
      expect(await readFile(outside, "utf8")).toBe("unchanged\n");
    });
  });

  it("does not serve encoded cross-run ids or symlinked artifacts", async () => {
    await withTempProject(async (cwd, root) => {
      await runDryRun({ cwd, dryRun: true, runId: "served" });
      const rendered = await renderObserver(cwd, "served");
      expect(rendered.ok).toBe(true);
      const secret = path.join(root, "secret.txt");
      await writeFile(secret, "DO-NOT-SERVE\n", "utf8");
      const server = await serveObserver(rendered, { port: 0 });
      try {
        await symlink(secret, path.join(cwd, ".humanish", "runs", "served", "leak.txt"));
        const base = new URL(server.url);
        const origin = `${base.protocol}//${base.host}`;
        const slash = await fetch(`${origin}/_humanish/runs/served%2Fother/run.json`);
        const backslash = await fetch(`${origin}/_humanish/runs/served%5Cother/run.json`);
        const leak = await fetch(`${origin}/leak.txt`);
        expect(slash.status).toBe(404);
        expect(backslash.status).toBe(404);
        expect(leak.status).toBe(404);
        expect(await leak.text()).not.toContain("DO-NOT-SERVE");
      } finally {
        await server.close();
      }
    });
  });

  it("runs, lists, verifies, and renders through a symlinked cwd", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "humanish-run-symlink-cwd-"));
    try {
      const realProject = path.join(root, "real-project");
      const linkedProject = path.join(root, "linked-project");
      await mkdir(realProject);
      await symlink(realProject, linkedProject);
      expect((await runDryRun({ cwd: linkedProject, dryRun: true, runId: "linked-cwd" })).ok).toBe(true);
      expect((await listRuns(linkedProject)).runs.map((run) => run.runId)).toContain("linked-cwd");
      expect((await verifyRun(linkedProject, "latest")).ok).toBe(true);
      expect((await renderObserver(linkedProject, "latest")).ok).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("binds a prepared run to its original cwd target and directory identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "humanish-run-token-"));
    try {
      const first = path.join(root, "first-project");
      const second = path.join(root, "second-project");
      const alias = path.join(root, "project-alias");
      await mkdir(first);
      await mkdir(second);
      await symlink(first, alias, "dir");
      const prepared = await prepareRunArtifactPaths(alias, "bound-run");

      await mkdir(path.join(second, ".humanish", "runs", "bound-run"), { recursive: true });
      const secondSentinel = path.join(second, ".humanish", "runs", "bound-run", "sentinel.txt");
      await writeFile(secondSentinel, "unchanged\n", "utf8");
      await rm(alias);
      await symlink(second, alias, "dir");
      await expect(validatePreparedRunArtifactPaths(prepared)).rejects.toThrow(/changed physical destination/i);
      expect(await readFile(secondSentinel, "utf8")).toBe("unchanged\n");

      const directProject = path.join(root, "direct-project");
      await mkdir(directProject);
      const recreated = await prepareRunArtifactPaths(directProject, "recreated-run");
      await rm(recreated.physicalRunRoot, { recursive: true });
      await mkdir(recreated.physicalRunRoot);
      await writeFile(path.join(recreated.physicalRunRoot, "sentinel.txt"), "unchanged\n", "utf8");
      await expect(validatePreparedRunArtifactPaths(recreated)).rejects.toThrow(/identity changed/i);
      expect(await readFile(path.join(recreated.physicalRunRoot, "sentinel.txt"), "utf8")).toBe("unchanged\n");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a hardlinked latest pointer before an atomic prepared write", async () => {
    await withTempProject(async (cwd, root) => {
      const prepared = await prepareRunArtifactPaths(cwd, "latest-hardlink");
      const outside = path.join(root, "outside-latest.json");
      await writeFile(outside, "unchanged\n", "utf8");
      try {
        await link(outside, prepared.physicalLatestPointer);
      } catch (error) {
        const code = error instanceof Error && "code" in error ? String(error.code) : "";
        if (["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(code)) return;
        throw error;
      }
      await expect(writePreparedRunLatestPointer(prepared, "mutated\n", "utf8"))
        .rejects.toThrow(/hardlink|single-link/i);
      expect(await readFile(outside, "utf8")).toBe("unchanged\n");
    });
  });

  it("fails verification when referenced evidence is replaced by a symlink", async () => {
    await withTempProject(async (cwd, root) => {
      await runDryRun({ cwd, dryRun: true, runId: "linked-evidence" });
      const events = path.join(cwd, ".humanish", "runs", "linked-evidence", "events.ndjson");
      const outside = path.join(root, "outside-events.ndjson");
      await rm(events);
      await writeFile(outside, "{\"event\":\"outside\"}\n", "utf8");
      await symlink(outside, events);
      const verified = await verifyRun(cwd, "linked-evidence");
      expect(verified.ok).toBe(false);
      expect(verified.error?.code).toBe("HUMANISH_INVALID_RUN_BUNDLE");
      expect(verified.checks).toContainEqual(expect.objectContaining({
        name: "run storage containment",
        ok: false
      }));
    });
  });

  it("rejects a hardlinked implicit scenario before creating run output or reading its bytes", async () => {
    await withTempProject(async (cwd, root) => {
      await mkdir(path.join(cwd, "humanish", "personas"), { recursive: true });
      await mkdir(path.join(cwd, "humanish", "scenarios"), { recursive: true });
      await writeFile(path.join(cwd, "package.json"), "{\"name\":\"safe-project\"}\n", "utf8");
      await writeFile(
        path.join(cwd, "humanish", "personas", "synthetic-new-user.yaml"),
        "id: safe-user\nname: Safe User\n",
        "utf8"
      );
      await writeFile(
        path.join(cwd, "humanish", "scenarios", "first-run-smoke.yaml"),
        "id: safe-smoke\ntitle: Safe Smoke\ngoal: Safe goal\n",
        "utf8"
      );
      const outside = path.join(root, "outside-secret.yaml");
      await writeFile(outside, "id: SHOULD-NOT-BE-READ\ntitle: secret\n", "utf8");
      try {
        await link(outside, path.join(cwd, "humanish", "scenarios", "extra.yaml"));
      } catch (error) {
        const code = error instanceof Error && "code" in error ? String(error.code) : "";
        if (["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(code)) return;
        throw error;
      }

      await expect(runDryRun({ cwd, dryRun: true, runId: "unsafe-config" }))
        .rejects.toThrow(/single-link/i);
      await expect(access(path.join(cwd, ".humanish"))).rejects.toThrow();
      expect(await readFile(outside, "utf8")).toBe("id: SHOULD-NOT-BE-READ\ntitle: secret\n");
    });
  });

  it("fails closed on symlinked OSS auxiliary storage before any network call", async () => {
    await withTempProject(async (cwd, root) => {
      const outside = path.join(root, "outside");
      await mkdir(outside);
      await writeFile(path.join(outside, "sentinel.txt"), "unchanged\n", "utf8");
      await symlink(outside, path.join(cwd, ".humanish"));
      await expect(runOssLab({ cwd, repos: ["owner/repo"], limit: 1, runId: "oss-safe" })).rejects.toThrow(/symbolic link/i);
      await expect(preflightOssMetaRepoAccess({ assignments: [], cwd, env: {} })).rejects.toThrow(/symbolic link/i);
      expect(await readFile(path.join(outside, "sentinel.txt"), "utf8")).toBe("unchanged\n");
    });
  });

  it("wires every direct run producer through the shared path guard", async () => {
    const producers = [
      "run.ts",
      "cua-actor-lab.ts",
      "shared-world-lab.ts",
      "concurrent-shared-world-lab.ts",
      "scripted-browser-lab.ts",
      "e2b-terminal-lab.ts"
    ];
    for (const producer of producers) {
      const source = await readFile(path.resolve("src", producer), "utf8");
      expect(source, producer).toContain("prepareRunArtifactPaths");
    }
    const metaSource = await readFile(path.resolve("src", "oss-meta-lab.ts"), "utf8");
    expect(metaSource).toContain("bindExistingRunArtifactPaths");
  });
});

describe("init path containment", () => {
  it.each([
    { target: "humanish", kind: "directory" },
    { target: ".humanish", kind: "directory" },
    { target: "humanish/personas/synthetic-new-user.yaml", kind: "file" },
    { target: ".gitignore", kind: "file" },
    { target: "package.json", kind: "file" }
  ])("rejects a symlinked init target: $target", async ({ target, kind }) => {
    await withTempProject(async (cwd, root) => {
      const outsideDir = path.join(root, "outside");
      await mkdir(outsideDir);
      const sentinel = path.join(outsideDir, "sentinel.txt");
      await writeFile(sentinel, "unchanged\n", "utf8");
      const targetPath = path.join(cwd, target);
      await mkdir(path.dirname(targetPath), { recursive: true });
      const source = kind === "directory" ? outsideDir : sentinel;
      await symlink(source, targetPath);

      const result = await runInit({ cwd, yes: true });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("HUMANISH_UNSAFE_PROJECT_PATH");
      expect(await readFile(sentinel, "utf8")).toBe("unchanged\n");
    });
  });

  it("supports a symlinked cwd while preserving the requested result path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "humanish-init-symlink-cwd-"));
    try {
      const realProject = path.join(root, "real-project");
      const linkedProject = path.join(root, "linked-project");
      await mkdir(realProject);
      await writeFile(path.join(realProject, "package.json"), "{\"name\":\"fixture\"}\n", "utf8");
      await symlink(realProject, linkedProject);
      const result = await runInit({ cwd: linkedProject, yes: true });
      expect(result.ok).toBe(true);
      expect(result.cwd).toBe(path.resolve(linkedProject));
      expect(await readFile(path.join(realProject, "humanish", "README.md"), "utf8")).toContain("# Humanish");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
