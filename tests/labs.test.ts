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
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-labs-"));
    await writeLab(cwd, "humanish/labs/first-run.yaml", [
      "schema: humanish.lab.v2",
      "id: first-run",
      "title: First run",
      "subject:",
      "  source: this-repo",
      "actors:",
      "  - type: synthetic-persona",
      "    count: 3"
    ].join("\n"));
    await writeLab(cwd, ".humanish/local/labs/private.yaml", [
      "schema: humanish.lab.v2",
      "id: private",
      "subject:",
      "  source: clone",
      "  repos:",
      "    - example/app",
      "execution:",
      "  target: e2b-desktop",
      "actors:",
      "  - type: codex-app-server",
      "policies:",
      "  redactRepos: true",
      "scenario:",
      "  mode: dry-run"
    ].join("\n"));

    const committed = await resolveLabManifest(cwd, "first-run");
    const ignored = await resolveLabManifest(cwd, "private");
    const explicit = await resolveLabManifest(cwd, ".humanish/local/labs/private.yaml");
    const list = await listLabManifests(cwd);

    expect(committed.ok && committed.origin).toBe("committed");
    expect(committed.ok && committed.config.actors[0]?.count).toBe(3);
    expect(ignored.ok && ignored.origin).toBe("ignored");
    expect(ignored.ok && ignored.config.subject.repos).toEqual(["example/app"]);
    expect(explicit.ok && explicit.origin).toBe("explicit");
    expect(list.labs.map((lab) => `${lab.origin}:${lab.id}`)).toEqual([
      "committed:first-run",
      "ignored:private"
    ]);
  });

  it("warns on .yml and fails invalid schemas", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-labs-invalid-"));
    await writeLab(cwd, "humanish/labs/compat.yml", [
      "schema: humanish.lab.v2",
      "id: compat",
      "subject:",
      "  source: this-repo",
      "actors:",
      "  - type: synthetic-persona"
    ].join("\n"));
    await writeLab(cwd, "humanish/labs/bad.yaml", [
      "schema: nope",
      "id: bad",
      "subject:",
      "  source: this-repo"
    ].join("\n"));

    const compat = await inspectLabManifest(cwd, "compat");
    const bad = await inspectLabManifest(cwd, "bad");

    expect(compat.ok).toBe(true);
    expect(compat.warnings.join("\n")).toContain("Prefer .yaml");
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe("HUMANISH_LAB_INVALID");
  });
});

async function writeLab(cwd: string, relativePath: string, contents: string): Promise<void> {
  const filePath = path.join(cwd, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${contents}\n`, "utf8");
}
