// Study files resolve from the studies/ directories first, then the labs/ directories they replace.
// One name in both families is an error, and no writer creates that collision.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { saveCommsConnection } from "../../src/comms/connections.js";
import { configureCommsLab } from "../../src/comms/setup.js";
import { listLabManifests, resolveLabManifest } from "../../src/lab/discover.js";
import { runInit } from "../../src/lab/init.js";
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
        "foo names two files, humanish/studies/foo.yaml and .humanish/local/labs/foo.yml. Keep the one under studies/ and remove the other, or pass the path of the one to run.",
    });
    const explicit = await resolveLabManifest(cwd, ".humanish/local/labs/foo.yml");
    expect(explicit.ok && explicit.config.id).toBe("foo-old");
  });

  it("lists both files of a colliding name with the error, and no other file", async () => {
    await write("humanish/studies/foo.yaml", "foo");
    await write("humanish/labs/foo.yaml", "foo-old");
    await write("humanish/labs/bar.yaml", "bar");

    const listed = await listLabManifests(cwd);
    expect(listed.labs.map((entry) => [entry.path, entry.error])).toEqual([
      ["humanish/labs/bar.yaml", undefined],
      [
        "humanish/studies/foo.yaml",
        "foo names two files, humanish/studies/foo.yaml and humanish/labs/foo.yaml; running it by name fails until one is removed.",
      ],
      [
        "humanish/labs/foo.yaml",
        "foo names two files, humanish/studies/foo.yaml and humanish/labs/foo.yaml; running it by name fails until one is removed.",
      ],
    ]);
  });
});

describe("writers", () => {
  it("init skips a starter whose name a studies file already uses", async () => {
    await write("humanish/studies/first-run.yaml", "first-run");

    const result = await runInit({ cwd, dryRun: true, env: {} });
    const change = result.changes.find((entry) => entry.path === "humanish/labs/first-run.yaml");
    expect(change).toMatchObject({ action: "skip" });
    expect(result.warnings).toContain(
      "Skipped humanish/labs/first-run.yaml: humanish/studies/first-run.yaml already uses the name first-run, and a second file with that name would make `run first-run` fail.",
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
});
