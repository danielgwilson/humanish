import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  inspectLabManifest,
  listLabManifests,
  resolveLabManifest
} from "../src/labs.js";

describe("lab manifest resolution", () => {
  it("resolves committed, ignored, and explicit .yaml lab manifests", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "mimetic-labs-"));
    await writeLab(cwd, "mimetic/labs/first-run.yaml", [
      "schema: mimetic.lab.v1",
      "id: first-run",
      "kind: synthetic",
      "title: First run",
      "sims: 3"
    ].join("\n"));
    await writeLab(cwd, ".mimetic/local/labs/private.yaml", [
      "schema: mimetic.lab.v1",
      "id: private",
      "kind: oss-meta",
      "repos:",
      "  - example/app",
      "defaults:",
      "  dryRun: true",
      "  redactRepos: true"
    ].join("\n"));

    const committed = await resolveLabManifest(cwd, "first-run");
    const ignored = await resolveLabManifest(cwd, "private");
    const explicit = await resolveLabManifest(cwd, ".mimetic/local/labs/private.yaml");
    const list = await listLabManifests(cwd);

    expect(committed.ok && committed.origin).toBe("committed");
    expect(committed.ok && committed.manifest.sims).toBe(3);
    expect(ignored.ok && ignored.origin).toBe("ignored");
    expect(ignored.ok && ignored.manifest.repos).toEqual(["example/app"]);
    expect(explicit.ok && explicit.origin).toBe("explicit");
    expect(list.labs.map((lab) => `${lab.origin}:${lab.id}`)).toEqual([
      "committed:first-run",
      "ignored:private"
    ]);
  });

  it("warns on .yml and fails invalid schemas", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "mimetic-labs-invalid-"));
    await writeLab(cwd, "mimetic/labs/compat.yml", [
      "schema: mimetic.lab.v1",
      "id: compat",
      "kind: synthetic"
    ].join("\n"));
    await writeLab(cwd, "mimetic/labs/bad.yaml", [
      "schema: nope",
      "id: bad",
      "kind: synthetic"
    ].join("\n"));

    const compat = await inspectLabManifest(cwd, "compat");
    const bad = await inspectLabManifest(cwd, "bad");

    expect(compat.ok).toBe(true);
    expect(compat.warnings.join("\n")).toContain("Prefer .yaml");
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe("MIMETIC_LAB_INVALID");
  });
});

async function writeLab(cwd: string, relativePath: string, contents: string): Promise<void> {
  const filePath = path.join(cwd, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${contents}\n`, "utf8");
}
