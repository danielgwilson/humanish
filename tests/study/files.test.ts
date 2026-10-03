// Study files resolve from the studies/ directories first, then the labs/ directories they replace.
// One name in both families is an error, and no writer creates that collision.

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { saveCommsConnection } from "../../src/comms/connections.js";
import { configureCommsLab } from "../../src/comms/setup.js";
import { listLabManifests, resolveLabManifest } from "../../src/study/discover.js";
import { runInit } from "../../src/study/init.js";
import { otherStudyFiles, studyFileCandidates } from "../../src/study/files.js";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-study-files-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function write(relativePath: string, id: string, extra: Record<string, unknown> = {}) {
  await mkdir(path.dirname(path.join(cwd, relativePath)), { recursive: true });
  await writeFile(
    path.join(cwd, relativePath),
    stringify({
      schema: "humanish.lab.v2",
      id,
      subject: { source: "this-repo" },
      actors: [{ type: "synthetic-persona" }],
      ...extra,
    }),
  );
}

describe("study file candidates", () => {
  it("lists the studies directories, then the labs directories, .yaml before .yml", () => {
    expect(studyFileCandidates("foo").map((candidate) => candidate.relativePath)).toEqual([
      "humanish/studies/foo.yaml",
      "humanish/studies/foo.yml",
      ".humanish/studies/foo.yaml",
      ".humanish/studies/foo.yml",
      ".humanish/local/studies/foo.yaml",
      ".humanish/local/studies/foo.yml",
      "humanish/labs/foo.yaml",
      "humanish/labs/foo.yml",
      ".humanish/labs/foo.yaml",
      ".humanish/labs/foo.yml",
      ".humanish/local/labs/foo.yaml",
      ".humanish/local/labs/foo.yml",
    ]);
  });

  it("finds the other files that use a name, leaving out the writer's own path", async () => {
    const present = new Set(["humanish/labs/foo.yaml", ".humanish/local/studies/foo.yml"]);
    const exists = async (relativePath: string) => present.has(relativePath);
    expect(await otherStudyFiles("foo", exists, "humanish/labs/foo.yaml")).toEqual([
      ".humanish/local/studies/foo.yml",
    ]);
    expect(await otherStudyFiles("bar", exists)).toEqual([]);
  });
});

describe("study discovery", () => {
  it("resolves a studies file first and still finds a labs file", async () => {
    await write("humanish/studies/first.yaml", "first");
    await write(".humanish/local/studies/first.yaml", "first-shadowed");
    await write(".humanish/local/labs/second.yaml", "second");

    const first = await resolveLabManifest(cwd, "first");
    const second = await resolveLabManifest(cwd, "second");
    expect(first.ok && [first.config.id, first.origin, first.path]).toEqual([
      "first",
      "committed",
      "humanish/studies/first.yaml",
    ]);
    expect(second.ok && [second.config.id, second.origin]).toEqual(["second", "ignored"]);
  });

  it("refuses a name that is a file in both a studies and a labs directory, naming both", async () => {
    await write("humanish/studies/foo.yaml", "foo");
    await write(".humanish/local/labs/foo.yml", "foo-old");

    const resolved = await resolveLabManifest(cwd, "foo");
    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.error).toEqual({
      code: "HUMANISH_STUDY_AMBIGUOUS",
      message:
        "foo names two files, humanish/studies/foo.yaml and .humanish/local/labs/foo.yml. Delete the one you do not want; if you keep .humanish/local/labs/foo.yml, run humanish migrate to move it. Or pass the path of the one to run.",
    });
    const explicit = await resolveLabManifest(cwd, ".humanish/local/labs/foo.yml");
    expect(explicit.ok && explicit.config.id).toBe("foo-old");
  });

  it("lists both files of a colliding name with the error, and no other file", async () => {
    await write("humanish/studies/foo.yaml", "foo");
    await write("humanish/labs/foo.yaml", "foo-old");
    await write("humanish/labs/bar.yaml", "bar");

    const listed = await listLabManifests(cwd);
    expect(listed.studies.map((entry) => [entry.path, entry.error])).toEqual([
      ["humanish/labs/bar.yaml", undefined],
      [
        "humanish/studies/foo.yaml",
        "foo names two files, humanish/studies/foo.yaml and humanish/labs/foo.yaml; running it by name fails until you delete one (humanish migrate moves a kept labs/ file).",
      ],
      [
        "humanish/labs/foo.yaml",
        "foo names two files, humanish/studies/foo.yaml and humanish/labs/foo.yaml; running it by name fails until you delete one (humanish migrate moves a kept labs/ file).",
      ],
    ]);
  });
});

describe("files 0.109 stops reading", () => {
  async function writeV3(relativePath: string, id: string) {
    await mkdir(path.dirname(path.join(cwd, relativePath)), { recursive: true });
    await writeFile(
      path.join(cwd, relativePath),
      stringify({
        schema: "humanish.study.v3",
        id,
        route: "preview",
        mode: "dry-run",
        subject: { source: "this-repo" },
        actor: { type: "synthetic-persona" },
      }),
    );
  }
  const retired = (warnings: string[]) => warnings.filter((entry) => entry.includes("0.109"));

  it.each([
    [
      "a v2 file in a studies directory",
      "humanish/studies/a.yaml",
      "v2",
      "humanish/studies/a.yaml is a humanish.lab.v2 file, which 0.109 stops reading. Run humanish migrate humanish/studies/a.yaml to convert it.",
    ],
    [
      "a v2 file in a labs directory",
      ".humanish/local/labs/a.yaml",
      "v2",
      ".humanish/local/labs/a.yaml is a humanish.lab.v2 file in .humanish/local/labs/, and 0.109 reads neither. Run humanish migrate to convert it and move it to .humanish/local/studies/.",
    ],
    [
      "a v3 file in a labs directory",
      "humanish/labs/a.yaml",
      "v3",
      "humanish/labs/a.yaml is in humanish/labs/, which 0.109 stops reading. Move it to humanish/studies/.",
    ],
  ])("warns about %s, naming the fix", async (_name, relativePath, format, warning) => {
    await (format === "v2" ? write(relativePath, "a") : writeV3(relativePath, "a"));

    const resolved = await resolveLabManifest(cwd, "a");
    expect(resolved.ok && retired(resolved.warnings)).toEqual([warning]);
  });

  it("does not warn about a v3 file in a studies directory", async () => {
    await writeV3(".humanish/studies/a.yaml", "a");

    const resolved = await resolveLabManifest(cwd, "a");
    expect(resolved.ok && retired(resolved.warnings)).toEqual([]);
  });

  it("study list counts the files in one warning", async () => {
    await writeV3("humanish/studies/clean.yaml", "clean");
    await write("humanish/studies/old.yaml", "old");
    expect(retired((await listLabManifests(cwd)).warnings)).toEqual([
      "One study file uses humanish.lab.v2 or a labs/ directory, which 0.109 stops reading. humanish migrate converts and moves the v2 files; humanish study show names the fix for each file.",
    ]);

    await writeV3("humanish/labs/moved.yaml", "moved");
    expect(retired((await listLabManifests(cwd)).warnings)[0]).toMatch(/^2 study files use /);
  });
});

describe("writers", () => {
  it("init skips a starter whose name a labs file already uses, and names migrate", async () => {
    await write("humanish/labs/first-run.yaml", "first-run");

    const result = await runInit({ cwd, dryRun: true, env: {} });
    const change = result.changes.find((entry) => entry.path === "humanish/studies/first-run.yaml");
    expect(change).toMatchObject({ action: "skip" });
    expect(result.warnings).toContain(
      "Skipped humanish/studies/first-run.yaml: humanish/labs/first-run.yaml already uses the name first-run, and a second file with that name would make `run first-run` fail. Run humanish migrate to move it to a studies/ directory.",
    );
  });

  it("comms configure refuses a destination name another study directory uses", async () => {
    await saveCommsConnection(cwd);
    await write("humanish/labs/signup.yaml", "signup", {
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000" },
      actors: [{ type: "openai-computer-use", mission: "Create an account." }],
      execution: { target: "e2b-desktop" },
      scenario: { mode: "live" },
    });
    await write("humanish/studies/signup-receiving.yaml", "signup-receiving");

    const plan = await configureCommsLab({ cwd, lab: "signup", connection: "agentmail" });
    expect(plan).toMatchObject({
      ok: false,
      message:
        "humanish/studies/signup-receiving.yaml already uses the name signup-receiving. Rename or remove it before configuring email, so `run signup-receiving` reads one file.",
    });
  });

  it("comms configure counts a dangling link as a file with that name", async () => {
    await saveCommsConnection(cwd);
    await write("humanish/labs/signup.yaml", "signup", {
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000" },
      actors: [{ type: "openai-computer-use", mission: "Create an account." }],
      execution: { target: "e2b-desktop" },
      scenario: { mode: "live" },
    });
    await symlink("missing.yaml", path.join(cwd, "humanish/labs/signup-receiving.yaml"));

    const plan = await configureCommsLab({ cwd, lab: "signup", connection: "agentmail" });
    expect(plan).toMatchObject({ ok: false });
    expect((plan as { message: string }).message).toContain(
      "humanish/labs/signup-receiving.yaml already uses the name signup-receiving.",
    );
  });
});
