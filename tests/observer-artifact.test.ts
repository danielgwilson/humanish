import { cp, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { observerArtifactNeedsBuild, renderObserver } from "../src/observer.js";
import { OBSERVER_DATA_SCHEMA } from "../src/observer-data.js";
import { runDryRun } from "../src/run.js";

// The Observer render path post-cutover (#426): renderObserverHtml is the one choke
// point every surface funnels through, and the prebuilt workspace artifact is the only
// renderer — no flag, no legacy fallback; rollback is a version pin.
//
// No pre-build here on purpose: in a repo checkout a missing or stale workspace
// artifact AUTO-BUILDS (the fresh-pull failure mode), so running this suite cold —
// exactly what CI's root test job does — exercises that path for real every run.

async function withRunBundle<T>(callback: (cwd: string) => Promise<T>): Promise<T> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "humanish-observer-artifact-"));
  const tempApp = path.join(tempRoot, "minimal-app");
  try {
    await cp(path.resolve("fixtures/minimal-app"), tempApp, { recursive: true });
    await runDryRun({ cwd: tempApp, dryRun: true, runId: "observer-proof" });
    return await callback(tempApp);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

describe("the Observer artifact render path", () => {
  it("renders the prebuilt workspace artifact with the snapshot inlined, by default", async () => {
    await withRunBundle(async (cwd) => {
      const result = await renderObserver(cwd, "latest");
      expect(result.ok).toBe(true);
      const html = await readFile(path.join(cwd, result.observerPath ?? ""), "utf8");
      expect(html).not.toContain("__HUMANISH_OBSERVER_DATA__");
      expect(html).toContain(`"schema":"${OBSERVER_DATA_SCHEMA}"`);
      expect(html).toContain("<title>Humanish Observer — observer-proof</title>");
      // The durability property the rebuild exists for: no network references.
      expect(html).not.toContain("fonts.googleapis");
    });
  });

  it("ignores the retired HUMANISH_OBSERVER env var entirely", async () => {
    await withRunBundle(async (cwd) => {
      process.env.HUMANISH_OBSERVER = "legacy";
      try {
        const result = await renderObserver(cwd, "latest");
        expect(result.ok).toBe(true);
        const html = await readFile(path.join(cwd, result.observerPath ?? ""), "utf8");
        expect(html).not.toContain("fonts.googleapis");
        expect(html).toContain(`"schema":"${OBSERVER_DATA_SCHEMA}"`);
      } finally {
        delete process.env.HUMANISH_OBSERVER;
      }
    });
  });
});

describe("observerArtifactNeedsBuild", () => {
  async function withWorkspace<T>(callback: (workspaceDir: string, artifactPath: string) => Promise<T>): Promise<T> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "humanish-observer-stale-"));
    const workspaceDir = path.join(tempRoot, "observer");
    const artifactPath = path.join(workspaceDir, "dist", "index.html");
    try {
      await mkdir(path.join(workspaceDir, "lib"), { recursive: true });
      await mkdir(path.join(workspaceDir, "dist"), { recursive: true });
      await writeFile(path.join(workspaceDir, "lib", "data.ts"), "export {};\n", "utf8");
      return await callback(workspaceDir, artifactPath);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  }

  it("wants a build when the artifact is missing (the fresh-pull failure mode)", async () => {
    await withWorkspace(async (workspaceDir, artifactPath) => {
      expect(observerArtifactNeedsBuild(workspaceDir, artifactPath)).toBe(true);
    });
  });

  it("is satisfied by an artifact newer than every source", async () => {
    await withWorkspace(async (workspaceDir, artifactPath) => {
      await writeFile(artifactPath, "<!doctype html>", "utf8");
      const future = new Date(Date.now() + 60_000);
      await utimes(artifactPath, future, future);
      expect(observerArtifactNeedsBuild(workspaceDir, artifactPath)).toBe(false);
    });
  });

  it("wants a rebuild when a source outdates the artifact (the stale-pull failure mode)", async () => {
    await withWorkspace(async (workspaceDir, artifactPath) => {
      await writeFile(artifactPath, "<!doctype html>", "utf8");
      const past = new Date(Date.now() - 60_000);
      await utimes(artifactPath, past, past);
      expect(observerArtifactNeedsBuild(workspaceDir, artifactPath)).toBe(true);
    });
  });
});
