// Study files resolve from the studies/ directories. humanish no longer reads a humanish.lab.v2 file
// or a labs/ directory: it refuses them by name with the command that fixes each, so the user is not
// told the study does not exist.

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { saveCommsConnection } from "../../src/comms/connections.js";
import { configureCommsStudy } from "../../src/comms/setup.js";
import { listStudyManifests, resolveStudyManifest } from "../../src/study/discover.js";
import { runInit } from "../../src/study/init.js";
import { migrateStudies } from "../../src/study/migrate/migrate.js";
import { otherStudyFiles, studyFileCandidates } from "../../src/study/files.js";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-study-files-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/** A humanish.lab.v2 file. */
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

/** A humanish.study.v3 file. */
async function writeV3(relativePath: string, id: string, extra: Record<string, unknown> = {}) {
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
  it("reads the studies directories in order", async () => {
    await writeV3("humanish/studies/first.yaml", "first");
    await writeV3(".humanish/local/studies/first.yaml", "first-shadowed");

    const first = await resolveStudyManifest(cwd, "first");
    expect(first.ok && [first.config.id, first.origin, first.path]).toEqual([
      "first",
      "committed",
      "humanish/studies/first.yaml",
    ]);
  });

  it("reads the studies file of a name that a labs file also uses", async () => {
    await writeV3("humanish/studies/foo.yaml", "foo");
    await writeV3(".humanish/local/labs/foo.yml", "foo-old");

    const resolved = await resolveStudyManifest(cwd, "foo");
    expect(resolved.ok && [resolved.config.id, resolved.path]).toEqual([
      "foo",
      "humanish/studies/foo.yaml",
    ]);
    // An explicit path to a v3 file runs wherever the file is.
    const explicit = await resolveStudyManifest(cwd, ".humanish/local/labs/foo.yml");
    expect(explicit.ok && explicit.config.id).toBe("foo-old");
  });

  it("lists the studies files and warns about each labs or v2 file, naming its fix", async () => {
    await writeV3("humanish/studies/foo.yaml", "foo");
    await writeV3("humanish/labs/moved.yaml", "moved");
    await write("humanish/labs/bar.yaml", "bar");
    await write("humanish/studies/old.yaml", "old");

    const listed = await listStudyManifests(cwd);
    expect(listed.studies.map((entry) => entry.path)).toEqual(["humanish/studies/foo.yaml"]);
    expect(listed.warnings).toEqual([
      "humanish/studies/old.yaml is a humanish.lab.v2 file, which humanish no longer reads. Run humanish migrate humanish/studies/old.yaml to convert it.",
      "humanish/labs/bar.yaml is a humanish.lab.v2 file in humanish/labs/, which humanish no longer reads. Run humanish migrate humanish/labs/bar.yaml to convert it and move it to humanish/studies/.",
      "humanish/labs/moved.yaml is in humanish/labs/, which humanish no longer reads. Move it to humanish/studies/.",
    ]);
  });
});

describe("files humanish no longer reads", () => {
  it.each([
    [
      "a v2 file in a studies directory",
      "humanish/studies/a.yaml",
      "v2",
      "HUMANISH_STUDY_V2_UNSUPPORTED",
      "humanish/studies/a.yaml is a humanish.lab.v2 file, which humanish no longer reads. Run humanish migrate humanish/studies/a.yaml to convert it.",
    ],
    [
      "a v2 file in a labs directory",
      ".humanish/local/labs/a.yaml",
      "v2",
      "HUMANISH_STUDY_V2_UNSUPPORTED",
      ".humanish/local/labs/a.yaml is a humanish.lab.v2 file in .humanish/local/labs/, which humanish no longer reads. Run humanish migrate .humanish/local/labs/a.yaml to convert it and move it to .humanish/local/studies/.",
    ],
    [
      "a v3 file in a labs directory",
      "humanish/labs/a.yaml",
      "v3",
      "HUMANISH_STUDY_RETIRED_DIRECTORY",
      "humanish/labs/a.yaml is in humanish/labs/, which humanish no longer reads. Move it to humanish/studies/.",
    ],
  ])("refuses %s by name, naming the fix", async (_name, relativePath, format, code, message) => {
    await (format === "v2" ? write(relativePath, "a") : writeV3(relativePath, "a"));

    const resolved = await resolveStudyManifest(cwd, "a");
    expect(!resolved.ok && resolved.error).toEqual({ code, message });
  });

  it("refuses a v2 file by explicit path too", async () => {
    await write("elsewhere/a.yaml", "a");

    const resolved = await resolveStudyManifest(cwd, "elsewhere/a.yaml");
    expect(!resolved.ok && resolved.error).toEqual({
      code: "HUMANISH_STUDY_V2_UNSUPPORTED",
      message:
        "elsewhere/a.yaml is a humanish.lab.v2 file, which humanish no longer reads. Run humanish migrate elsewhere/a.yaml to convert it.",
    });
  });

  it("names migrate's --cwd for a v2 file outside the project, quoted for the shell", async () => {
    // migrate refuses a path outside its --cwd. The directory has a space, so the shell must get
    // it as one argument.
    const outside = await mkdtemp(path.join(os.tmpdir(), "humanish study outside-"));
    try {
      await writeFile(
        path.join(outside, "a.yaml"),
        stringify({
          schema: "humanish.lab.v2",
          id: "a",
          subject: { source: "this-repo" },
          actors: [{ type: "synthetic-persona" }],
        }),
      );
      const resolved = await resolveStudyManifest(cwd, path.join(outside, "a.yaml"));
      const message = !resolved.ok ? resolved.error.message : "";
      expect(message).toBe(
        `${path.join(outside, "a.yaml")} is a humanish.lab.v2 file, which humanish no longer reads. Run humanish migrate --cwd '${outside}' a.yaml to convert it.`,
      );
      // The shell splits the suggested command into the arguments migrate needs, and migrate
      // accepts them.
      const args = /Run humanish migrate (.*) to convert it\.$/.exec(message)?.[1] ?? "";
      const argv = execFileSync("sh", ["-c", `printf '%s\\n' ${args}`], { encoding: "utf8" });
      expect(argv.trimEnd().split("\n")).toEqual(["--cwd", outside, "a.yaml"]);
      const migrated = await migrateStudies({ cwd: outside, paths: ["a.yaml"], dryRun: true });
      expect(migrated.files.map((file) => [file.source, file.action])).toEqual([
        ["a.yaml", "rewrite"],
      ]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("does not follow a link in a labs directory, and a studies file wins over it", async () => {
    await write("elsewhere/outside.yaml", "outside");
    await mkdir(path.join(cwd, "humanish/labs"), { recursive: true });
    await symlink(
      path.join(cwd, "elsewhere/outside.yaml"),
      path.join(cwd, "humanish/labs/linked.yaml"),
    );

    const linked = await resolveStudyManifest(cwd, "linked");
    expect(!linked.ok && linked.error.code).toBe("HUMANISH_STUDY_INVALID");
    expect(!linked.ok && linked.error.message).not.toContain("humanish migrate");

    await writeV3("humanish/studies/linked.yaml", "linked");
    const preferred = await resolveStudyManifest(cwd, "linked");
    expect(preferred.ok && preferred.path).toBe("humanish/studies/linked.yaml");
  });

  it("lists each file it refuses in retired, with its code", async () => {
    await write("humanish/studies/old.yaml", "old");
    await writeV3(".humanish/labs/moved.yaml", "moved");

    const listed = await listStudyManifests(cwd);
    expect(listed.retired.map((file) => [file.path, file.code])).toEqual([
      ["humanish/studies/old.yaml", "HUMANISH_STUDY_V2_UNSUPPORTED"],
      [".humanish/labs/moved.yaml", "HUMANISH_STUDY_RETIRED_DIRECTORY"],
    ]);
    expect(listed.warnings).toEqual(listed.retired.map((file) => file.message));
  });

  it("names only humanish/studies/ when a name is not found", async () => {
    const resolved = await resolveStudyManifest(cwd, "missing");
    expect(!resolved.ok && resolved.error).toEqual({
      code: "HUMANISH_STUDY_NOT_FOUND",
      message: "Study not found: missing. Look in humanish/studies/, or pass a .yaml path.",
    });
  });
});

describe("writers", () => {
  it("init skips a starter whose name a labs file already uses, and names migrate", async () => {
    await write("humanish/labs/first-run.yaml", "first-run");

    const result = await runInit({ cwd, dryRun: true, env: {} });
    const change = result.changes.find((entry) => entry.path === "humanish/studies/first-run.yaml");
    expect(change).toMatchObject({ action: "skip" });
    expect(result.warnings).toContain(
      "Skipped humanish/studies/first-run.yaml: humanish/labs/first-run.yaml already uses the name first-run. Move it to a studies/ directory; humanish migrate converts and moves a v2 file.",
    );
  });

  it("comms configure refuses a destination name another study directory uses", async () => {
    await saveCommsConnection(cwd);
    await writeV3("humanish/studies/signup.yaml", "signup", {
      route: "computer-use",
      mode: "live",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000" },
      actor: { type: "openai-computer-use", mission: "Create an account." },
      execution: { target: "e2b-desktop" },
    });
    await writeV3("humanish/studies/signup-receiving.yaml", "signup-receiving");

    const plan = await configureCommsStudy({ cwd, study: "signup", connection: "agentmail" });
    expect(plan).toMatchObject({
      ok: false,
      message:
        "humanish/studies/signup-receiving.yaml already uses the name signup-receiving. Rename or remove it before configuring email, so `run signup-receiving` reads one file.",
    });
  });

  it("comms configure counts a dangling link as a file with that name", async () => {
    await saveCommsConnection(cwd);
    await writeV3("humanish/studies/signup.yaml", "signup", {
      route: "computer-use",
      mode: "live",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000" },
      actor: { type: "openai-computer-use", mission: "Create an account." },
      execution: { target: "e2b-desktop" },
    });
    await mkdir(path.join(cwd, "humanish/labs"), { recursive: true });
    await symlink("missing.yaml", path.join(cwd, "humanish/labs/signup-receiving.yaml"));

    const plan = await configureCommsStudy({ cwd, study: "signup", connection: "agentmail" });
    expect(plan).toMatchObject({ ok: false });
    expect((plan as { message: string }).message).toContain(
      "humanish/labs/signup-receiving.yaml already uses the name signup-receiving.",
    );
  });
});
