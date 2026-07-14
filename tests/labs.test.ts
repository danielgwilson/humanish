import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  inspectLabManifest,
  listLabManifests,
  resolveLabManifest
} from "../src/labs.js";

const execFileAsync = promisify(execFile);

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

  it.each(["symlink", "hardlink", "fifo"] as const)(
    "rejects an unsafe higher-priority managed %s leaf without falling through or blocking",
    async (kind) => {
      const root = await mkdtemp(path.join(tmpdir(), "humanish-labs-unsafe-leaf-"));
      const cwd = path.join(root, "project");
      const outside = path.join(root, `outside-${kind}.yaml`);
      const candidate = path.join(cwd, "humanish", "labs", "priority.yaml");
      await mkdir(path.dirname(candidate), { recursive: true });
      await writeFile(outside, labYaml("outside"), "utf8");
      await writeLab(cwd, ".humanish/labs/priority.yaml", labYaml("fallback"));

      if (kind === "symlink") {
        await symlink(outside, candidate);
      } else if (kind === "hardlink") {
        try {
          await link(outside, candidate);
        } catch (error) {
          const code = error instanceof Error && "code" in error ? String(error.code) : "";
          if (["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(code)) return;
          throw error;
        }
      } else {
        await execFileAsync("mkfifo", [candidate]);
      }

      const resolved = await withinOneSecond(
        resolveLabManifest(cwd, "priority"),
        `named resolution hung on a managed ${kind} manifest`
      );
      const listed = await withinOneSecond(
        listLabManifests(cwd),
        `lab listing hung on a managed ${kind} manifest`
      );

      expect(resolved.ok).toBe(false);
      expect(!resolved.ok && resolved.error.code).toBe("HUMANISH_LAB_INVALID");
      expect(!resolved.ok && resolved.error.message).toMatch(/managed lab|single-link|containment/i);
      expect(listed.labs.map((lab) => `${lab.origin}:${lab.id}`)).toEqual(["ignored:fallback"]);
      expect(listed.warnings.join("\n")).toContain("humanish/labs/priority.yaml");
      expect(await readFile(outside, "utf8")).toBe(labYaml("outside"));
    }
  );

  it.each(["symlink", "fifo"] as const)(
    "rejects an unsafe managed %s lab directory and lists other safe roots",
    async (kind) => {
      const root = await mkdtemp(path.join(tmpdir(), "humanish-labs-unsafe-dir-"));
      const cwd = path.join(root, "project");
      const committedParent = path.join(cwd, "humanish");
      const committedLabs = path.join(committedParent, "labs");
      await mkdir(committedParent, { recursive: true });
      await writeLab(cwd, ".humanish/local/labs/priority.yaml", labYaml("safe-local"));

      if (kind === "symlink") {
        const outsideLabs = path.join(root, "outside-labs");
        await writeLab(outsideLabs, "priority.yaml", labYaml("outside"));
        await symlink(outsideLabs, committedLabs);
      } else {
        await execFileAsync("mkfifo", [committedLabs]);
      }

      const resolved = await withinOneSecond(
        resolveLabManifest(cwd, "priority"),
        `named resolution hung on a managed ${kind} directory`
      );
      const listed = await withinOneSecond(
        listLabManifests(cwd),
        `lab listing hung on a managed ${kind} directory`
      );

      expect(resolved.ok).toBe(false);
      expect(!resolved.ok && resolved.error.code).toBe("HUMANISH_LAB_INVALID");
      expect(listed.labs.map((lab) => `${lab.origin}:${lab.id}`)).toEqual(["ignored:safe-local"]);
      expect(listed.warnings.join("\n")).toMatch(/humanish[/\\]labs.*unsafe|symbolic links/i);
    }
  );

  it("keeps explicit symlink aliases as caller-selected input authority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "humanish-labs-explicit-alias-"));
    const cwd = path.join(root, "project");
    const target = path.join(root, "outside", "selected.yaml");
    const alias = path.join(cwd, "aliases", "selected.yaml");
    await mkdir(path.dirname(alias), { recursive: true });
    await writeLab(root, "outside/selected.yaml", labYaml("explicit-alias"));
    await symlink(target, alias);

    const resolved = await resolveLabManifest(cwd, "aliases/selected.yaml");

    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.origin).toBe("explicit");
    expect(resolved.ok && resolved.config.id).toBe("explicit-alias");
    expect(resolved.ok && resolved.path).toBe("aliases/selected.yaml");
    expect(resolved.ok && resolved.path).not.toContain("outside");
  });

  it.each(["hardlink", "fifo"] as const)(
    "rejects an explicit %s manifest without blocking",
    async (kind) => {
      const root = await mkdtemp(path.join(tmpdir(), "humanish-labs-explicit-unsafe-"));
      const cwd = path.join(root, "project");
      const selected = path.join(cwd, `selected-${kind}.yaml`);
      await mkdir(cwd, { recursive: true });
      if (kind === "hardlink") {
        const outside = path.join(root, "outside.yaml");
        await writeFile(outside, labYaml("outside"), "utf8");
        try {
          await link(outside, selected);
        } catch (error) {
          const code = error instanceof Error && "code" in error ? String(error.code) : "";
          if (["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(code)) return;
          throw error;
        }
      } else {
        await execFileAsync("mkfifo", [selected]);
      }

      const resolved = await withinOneSecond(
        resolveLabManifest(cwd, path.basename(selected)),
        `explicit resolution hung on a ${kind} manifest`
      );

      expect(resolved.ok).toBe(false);
      expect(!resolved.ok && resolved.error.code).toBe("HUMANISH_LAB_INVALID");
      expect(!resolved.ok && resolved.error.message).toMatch(/single-link|containment/i);
    }
  );

  it("resolves managed manifests from a caller-selected symlink cwd alias", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "humanish-labs-cwd-alias-"));
    const physicalCwd = path.join(root, "physical-project");
    const aliasCwd = path.join(root, "project-alias");
    await writeLab(physicalCwd, "humanish/labs/aliased.yaml", labYaml("aliased"));
    await symlink(physicalCwd, aliasCwd);

    const resolved = await resolveLabManifest(aliasCwd, "aliased");
    const listed = await listLabManifests(aliasCwd);

    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.path).toBe("humanish/labs/aliased.yaml");
    expect(listed.labs.map((lab) => lab.path)).toEqual(["humanish/labs/aliased.yaml"]);
  });
});

async function writeLab(cwd: string, relativePath: string, contents: string): Promise<void> {
  const filePath = path.join(cwd, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${contents}\n`, "utf8");
}

function labYaml(id: string): string {
  return [
    "schema: humanish.lab.v2",
    `id: ${id}`,
    "subject:",
    "  source: this-repo",
    "actors:",
    "  - type: synthetic-persona",
    ""
  ].join("\n");
}

async function withinOneSecond<T>(promise: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(message)), 1_000);
    })
  ]);
}
