// `humanish migrate` removes a labs/ directory its moves emptied, with a non-recursive rmdir once
// every entry in it moved, so anything else in it, a dotfile included, keeps the directory.

import { existsSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { createProgram } from "../../src/cli/program.js";
import { migrateStudies } from "../../src/study/migrate.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

let cwd: string;
beforeEach(async () => {
  cwd = await makeTestTempDir("humanish-migrate-labs-");
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const v2 = (id: string) =>
  stringify({
    schema: "humanish.lab.v2",
    id,
    subject: { source: "this-repo" },
    actors: [{ type: "synthetic-persona", count: 2 }],
  });

async function write(relativePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(path.join(cwd, relativePath)), { recursive: true });
  await writeFile(path.join(cwd, relativePath), contents);
}

// Every file under the project, by relative path, with its contents.
async function tree(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(cwd, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    files[path.relative(cwd, full)] = await readFile(full, "utf8");
  }
  return files;
}

describe("an emptied labs/ directory", () => {
  it("is removed once every file in it moved", async () => {
    await write("humanish/labs/a.yaml", v2("a"));
    await write("humanish/labs/b.yaml", v2("b"));
    const result = await migrateStudies({ cwd });
    expect(result).toMatchObject({ ok: true, removedDirectories: ["humanish/labs"] });
    expect(existsSync(path.join(cwd, "humanish/labs"))).toBe(false);
    expect(existsSync(path.join(cwd, "humanish/studies/a.yaml"))).toBe(true);
    expect(existsSync(path.join(cwd, "humanish/studies/b.yaml"))).toBe(true);
  });

  it("is named in the summary line", async () => {
    await write("humanish/labs/a.yaml", v2("a"));
    const out: string[] = [];
    const program = createProgram({
      writeOut: (text) => out.push(text),
      writeErr: (text) => out.push(text),
      setExitCode: () => undefined,
    });
    program.exitOverride();
    await program.parseAsync(["node", "humanish", "migrate", "--cwd", cwd], { from: "node" });
    expect(out.at(-1)).toBe(
      "Converted 1 study file. Removed humanish/labs/, which the move emptied.\n",
    );
  });

  it.each([
    ["a dotfile", ".keep"],
    ["another file", "notes.txt"],
    ["a subdirectory", "drafts/c.yaml"],
  ])("is kept when it holds %s", async (_label, other) => {
    await write("humanish/labs/a.yaml", v2("a"));
    await write(path.join("humanish/labs", other), "kept\n");
    const result = await migrateStudies({ cwd });
    expect(result.ok).toBe(true);
    expect(result.removedDirectories).toBeUndefined();
    expect(existsSync(path.join(cwd, "humanish/labs/a.yaml"))).toBe(false);
    expect(existsSync(path.join(cwd, "humanish/labs", other))).toBe(true);
  });

  it("is kept when a file appears in it after the plan", async () => {
    await write("humanish/labs/a.yaml", v2("a"));
    const result = await migrateStudies({
      cwd,
      onPhase: (finished) => {
        if (finished === "commit") writeFileSync(path.join(cwd, "humanish/labs/.new"), "new\n");
      },
    });
    expect(result.ok).toBe(true);
    expect(result.removedDirectories).toBeUndefined();
    expect(existsSync(path.join(cwd, "humanish/labs/.new"))).toBe(true);
  });

  it("is a planned step under --dry-run, and nothing is removed", async () => {
    await write("humanish/labs/a.yaml", v2("a"));
    const before = await tree();
    const out: string[] = [];
    const program = createProgram({
      writeOut: (text) => out.push(text),
      writeErr: (text) => out.push(text),
      setExitCode: () => undefined,
    });
    program.exitOverride();
    await program.parseAsync(["node", "humanish", "migrate", "--cwd", cwd, "--dry-run"], {
      from: "node",
    });
    expect(out.join("")).toContain(
      "humanish/labs/: removed after the move, since nothing else is in it",
    );
    expect(out.join("")).toContain("Dry run: nothing was written.");
    expect(await tree()).toEqual(before);
    expect(existsSync(path.join(cwd, "humanish/labs"))).toBe(true);
    expect(await migrateStudies({ cwd, dryRun: true })).toMatchObject({
      ok: true,
      dryRun: true,
      removedDirectories: ["humanish/labs"],
    });
  });
});
