import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendContainedOutputFile,
  prepareSelectedOutputDirectory,
  removeContainedOutputFile,
  type PreparedSelectedOutputDirectory,
} from "../../src/run/contained-output.js";

let base: string;
let out: string;
let root: PreparedSelectedOutputDirectory;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "humanish-contained-append-"));
  root = await prepareSelectedOutputDirectory(base, "out");
  out = root.physicalPath;
  await mkdir(path.join(out, "live"));
});

afterEach(async () => {
  await rm(base, { force: true, recursive: true });
});

const bytes = (text: string) => Buffer.from(text, "utf8");

describe("appendContainedOutputFile", () => {
  it("appends after the bytes the caller says the file holds", async () => {
    await writeFile(path.join(out, "live/1.1.ndjson"), "a\n");
    await appendContainedOutputFile(root, "live/1.1.ndjson", bytes("b\nc\n"), 2);
    expect(await readFile(path.join(out, "live/1.1.ndjson"), "utf8")).toBe("a\nb\nc\n");
  });

  it("refuses a file that holds other than the caller's count, leaving it as it was", async () => {
    await writeFile(path.join(out, "live/1.1.ndjson"), "a\nextra");
    await expect(
      appendContainedOutputFile(root, "live/1.1.ndjson", bytes("b\n"), 2),
    ).rejects.toThrow(/holds 7 bytes, not 2/);
    expect(await readFile(path.join(out, "live/1.1.ndjson"), "utf8")).toBe("a\nextra");
  });

  it("refuses a missing file without creating it", async () => {
    await expect(
      appendContainedOutputFile(root, "live/1.1.ndjson", bytes("b\n"), 0),
    ).rejects.toThrow(/ENOENT/);
    await expect(stat(path.join(out, "live/1.1.ndjson"))).rejects.toThrow(/ENOENT/);
  });

  it("refuses a link at the path and leaves its target unchanged", async () => {
    await writeFile(path.join(base, "outside.txt"), "a\n");
    await symlink(path.join(base, "outside.txt"), path.join(out, "live/1.1.ndjson"));
    await expect(
      appendContainedOutputFile(root, "live/1.1.ndjson", bytes("b\n"), 2),
    ).rejects.toThrow(/single-link regular files/);
    expect(await readFile(path.join(base, "outside.txt"), "utf8")).toBe("a\n");
  });

  it("refuses a hard-linked file and leaves both names unchanged", async () => {
    await writeFile(path.join(base, "outside.txt"), "a\n");
    await link(path.join(base, "outside.txt"), path.join(out, "live/1.1.ndjson"));
    await expect(
      appendContainedOutputFile(root, "live/1.1.ndjson", bytes("b\n"), 2),
    ).rejects.toThrow(/single-link regular files/);
    expect(await readFile(path.join(base, "outside.txt"), "utf8")).toBe("a\n");
  });

  it("refuses a folder on the path that is a link out of the root", async () => {
    await mkdir(path.join(base, "elsewhere"));
    await writeFile(path.join(base, "elsewhere/1.1.ndjson"), "a\n");
    await symlink(path.join(base, "elsewhere"), path.join(out, "linked"), "dir");
    await expect(
      appendContainedOutputFile(root, "linked/1.1.ndjson", bytes("b\n"), 2),
    ).rejects.toThrow(/must not be symbolic links/);
    expect(await readFile(path.join(base, "elsewhere/1.1.ndjson"), "utf8")).toBe("a\n");
  });

  it("refuses a path that leaves the root", async () => {
    await writeFile(path.join(base, "outside.txt"), "a\n");
    await expect(
      appendContainedOutputFile(root, "../outside.txt", bytes("b\n"), 2),
    ).rejects.toThrow(/traversal/);
    expect(await readFile(path.join(base, "outside.txt"), "utf8")).toBe("a\n");
  });
});

describe("removeContainedOutputFile", () => {
  it("removes a regular file inside the root", async () => {
    await writeFile(path.join(out, "live/1.1.ndjson"), "a\n");
    await removeContainedOutputFile(root, "live/1.1.ndjson");
    await expect(stat(path.join(out, "live/1.1.ndjson"))).rejects.toThrow(/ENOENT/);
  });

  it("does nothing when nothing is at the path or a folder on it is missing", async () => {
    await removeContainedOutputFile(root, "live/9.9.ndjson");
    await removeContainedOutputFile(root, "gone/9.9.ndjson");
    expect((await stat(path.join(out, "live"))).isDirectory()).toBe(true);
  });

  it("removes an empty folder and keeps one that holds a file", async () => {
    await mkdir(path.join(out, "empty"));
    await writeFile(path.join(out, "live/1.1.ndjson"), "a\n");
    await removeContainedOutputFile(root, "empty");
    await expect(stat(path.join(out, "empty"))).rejects.toThrow(/ENOENT/);
    await expect(removeContainedOutputFile(root, "live")).rejects.toThrow(/ENOTEMPTY/);
    expect(await readFile(path.join(out, "live/1.1.ndjson"), "utf8")).toBe("a\n");
  });

  it("refuses a file reached through a folder that links out of the root", async () => {
    await mkdir(path.join(base, "elsewhere"));
    await writeFile(path.join(base, "elsewhere/1.1.ndjson"), "a\n");
    await symlink(path.join(base, "elsewhere"), path.join(out, "linked"), "dir");
    await expect(removeContainedOutputFile(root, "linked/1.1.ndjson")).rejects.toThrow(
      /must not be symbolic links/,
    );
    expect(await readFile(path.join(base, "elsewhere/1.1.ndjson"), "utf8")).toBe("a\n");
  });

  it("refuses a hard-linked file", async () => {
    await writeFile(path.join(base, "outside.txt"), "a\n");
    await link(path.join(base, "outside.txt"), path.join(out, "live/1.1.ndjson"));
    await expect(removeContainedOutputFile(root, "live/1.1.ndjson")).rejects.toThrow(
      /not a single-link regular file/,
    );
    expect(await readFile(path.join(out, "live/1.1.ndjson"), "utf8")).toBe("a\n");
  });
});
