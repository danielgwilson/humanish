import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { joinJournals } from "../../src/remote/launch.js";
import { parseDigests, uploadProject, type Runner } from "../../src/remote/runner.js";

const HASH = "a".repeat(64);

describe("the runner's run listing", () => {
  it("reads sha256sum lines as paths inside the run directory", () => {
    expect(
      parseDigests(`${HASH}  ./run.json\n${"b".repeat(64)} *./screenshots/lane-01/0001.png\n`),
    ).toEqual([
      { sha256: HASH, path: "run.json" },
      { sha256: "b".repeat(64), path: "screenshots/lane-01/0001.png" },
    ]);
  });

  it("skips lines that do not name a file under the directory", () => {
    expect(parseDigests(`${HASH}  /etc/passwd\nnot a digest\n${HASH}  ../escape\n`)).toEqual([]);
  });
});

describe("joining this machine's sandbox journal with the runner's", () => {
  it("keeps every line of both, once each, ending in one newline", () => {
    expect(joinJournals('{"runner":1}\n\n', '\n{"participant":1}\n')).toBe(
      '{"runner":1}\n{"participant":1}\n',
    );
    expect(joinJournals("", "")).toBe("");
  });
});

describe("uploading a study to the runner", () => {
  async function project() {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-upload-"));
    await mkdir(path.join(cwd, "humanish", "personas"), { recursive: true });
    await writeFile(path.join(cwd, "study.yaml"), "id: synthetic\n");
    await writeFile(path.join(cwd, "humanish", "personas", "p.md"), "persona\n");
    const written: string[] = [];
    const runner = {
      sandbox: {},
      shell: { writeFile: async (file: string) => void written.push(file) },
    } as unknown as Runner;
    return { cwd, runner, written };
  }

  it("uploads the study and every persona file to the same place in the runner's project", async () => {
    const { cwd, runner, written } = await project();
    try {
      await uploadProject(runner, cwd, ["study.yaml"], ["humanish/personas", "missing"]);
      expect(written.sort()).toEqual(["project/humanish/personas/p.md", "project/study.yaml"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("refuses a file that links elsewhere on this machine", async () => {
    const { cwd, runner, written } = await project();
    try {
      await writeFile(path.join(cwd, "..", path.basename(cwd) + "-secret"), "KEY=synthetic\n");
      await symlink(
        path.join(cwd, "..", path.basename(cwd) + "-secret"),
        path.join(cwd, "input.txt"),
      );
      await expect(uploadProject(runner, cwd, ["study.yaml", "input.txt"], [])).rejects.toThrow(
        "input.txt is a link",
      );
      expect(written).not.toContain("project/input.txt");
    } finally {
      await rm(path.join(cwd, "..", path.basename(cwd) + "-secret"), { force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
