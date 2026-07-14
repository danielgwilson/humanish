import { link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertPreparedSelectedOutputDirectory,
  prepareContainedOutputDirectory,
  prepareContainedOutputFile,
  prepareManagedHumanishOutputDirectory,
  prepareSelectedOutputDirectory,
  prepareSelectedOutputFile,
  readContainedRegularFile,
  writeContainedOutputFile,
  writePreparedSelectedOutputFile
} from "../src/selected-output-paths.js";

describe("selected output path containment", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "humanish-selected-output-"));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("preserves requested paths while mapping an in-base selection through a symlinked cwd", async () => {
    const physicalProject = path.join(root, "physical-project");
    const cwdAlias = path.join(root, "project-alias");
    await mkdir(physicalProject);
    await symlink(physicalProject, cwdAlias, "dir");

    const preparedRoot = await prepareSelectedOutputDirectory(cwdAlias, ".humanish/codex-app-server-ui");
    const preparedState = await prepareSelectedOutputFile(cwdAlias, ".humanish/codex-app-server-ui/state.json");
    await writePreparedSelectedOutputFile(preparedState, "state\n", "utf8");

    expect(preparedRoot.requestedPath).toBe(path.join(cwdAlias, ".humanish/codex-app-server-ui"));
    expect(preparedRoot.physicalPath).toBe(await realpath(path.join(physicalProject, ".humanish/codex-app-server-ui")));
    expect(preparedState.requestedPath).toBe(path.join(cwdAlias, ".humanish/codex-app-server-ui/state.json"));
    expect(await readFile(path.join(physicalProject, ".humanish/codex-app-server-ui/state.json"), "utf8")).toBe("state\n");
  });

  it("binds explicit absolute and lexically outside relative directory aliases to their physical target", async () => {
    const base = path.join(root, "base");
    const target = path.join(root, "selected-target");
    const absoluteAlias = path.join(root, "absolute-alias");
    const outsideAlias = path.join(root, "outside-alias");
    await mkdir(base);
    await mkdir(target);
    await symlink(target, absoluteAlias, "dir");
    await symlink(target, outsideAlias, "dir");

    const absolute = await prepareSelectedOutputDirectory(base, absoluteAlias);
    const outside = await prepareSelectedOutputDirectory(base, "../outside-alias");
    await writeContainedOutputFile(absolute, "codex-app-server/summary.json", "{}\n", "utf8");

    expect(absolute.requestedPath).toBe(absoluteAlias);
    expect(outside.requestedPath).toBe(outsideAlias);
    expect(absolute.physicalPath).toBe(await realpath(target));
    expect(outside.physicalPath).toBe(await realpath(target));
    expect(await readFile(path.join(target, "codex-app-server/summary.json"), "utf8")).toBe("{}\n");
  });

  it("allows a canonical OS alias ancestor such as /tmp while guarding the selected child", async () => {
    const selected = path.join("/tmp", `humanish-selected-${path.basename(root)}`);
    try {
      const prepared = await prepareSelectedOutputDirectory(root, selected);
      await writeContainedOutputFile(prepared, "proof.txt", "ok\n", "utf8");
      expect(await readFile(path.join(prepared.physicalPath, "proof.txt"), "utf8")).toBe("ok\n");
    } finally {
      await rm(selected, { force: true, recursive: true });
    }
  });

  it("treats equivalent relative and absolute caller selections as the same authority", async () => {
    const project = path.join(root, "project");
    const target = path.join(root, "target");
    await mkdir(project);
    await mkdir(target);
    await symlink(target, path.join(project, "relative-alias"), "dir");

    const relative = await prepareSelectedOutputDirectory(project, "relative-alias");
    const absolute = await prepareSelectedOutputDirectory(project, path.join(project, "relative-alias"));
    expect(relative.physicalPath).toBe(await realpath(target));
    expect(absolute.physicalPath).toBe(relative.physicalPath);
  });

  it("rejects a managed default alias even though the same explicit selection is authorized", async () => {
    const project = path.join(root, "project");
    const outside = path.join(root, "outside");
    const sentinel = path.join(outside, "sentinel.txt");
    await mkdir(project);
    await mkdir(outside);
    await writeFile(sentinel, "unchanged\n", "utf8");
    await symlink(outside, path.join(project, ".humanish"), "dir");

    const explicit = await prepareSelectedOutputDirectory(project, ".humanish/codex-app-server-ui");
    expect(explicit.physicalPath).toBe(await realpath(path.join(outside, "codex-app-server-ui")));
    await expect(prepareManagedHumanishOutputDirectory(project, "codex-app-server-ui"))
      .rejects.toThrow(/symbolic links/i);
    expect(await readFile(sentinel, "utf8")).toBe("unchanged\n");
  });

  it("rejects generated child and file symlinks plus an exact selected file leaf", async () => {
    const selectedRoot = path.join(root, "selected");
    const outside = path.join(root, "outside");
    const sentinel = path.join(outside, "sentinel.txt");
    await mkdir(selectedRoot);
    await mkdir(outside);
    await writeFile(sentinel, "unchanged\n", "utf8");
    const prepared = await prepareSelectedOutputDirectory(root, selectedRoot);

    await symlink(outside, path.join(selectedRoot, "codex-app-server"), "dir");
    await expect(prepareContainedOutputDirectory(prepared, "codex-app-server"))
      .rejects.toThrow(/symbolic links/i);
    await rm(path.join(selectedRoot, "codex-app-server"));

    await mkdir(path.join(selectedRoot, "codex-app-server"));
    await symlink(sentinel, path.join(selectedRoot, "codex-app-server", "summary.json"));
    await expect(prepareContainedOutputFile(prepared, "codex-app-server/summary.json"))
      .rejects.toThrow(/regular files/i);

    const selectedState = path.join(root, "selected-state.json");
    await symlink(sentinel, selectedState);
    await expect(prepareSelectedOutputFile(root, selectedState)).rejects.toThrow(/regular files/i);
    expect(await readFile(sentinel, "utf8")).toBe("unchanged\n");
  });

  it("reads only lexically and physically contained regular files", async () => {
    const selectedRoot = path.join(root, "run");
    const sibling = path.join(root, "run-sibling");
    const outside = path.join(root, "outside");
    await mkdir(selectedRoot);
    await mkdir(sibling);
    await mkdir(outside);
    await writeFile(path.join(selectedRoot, "ordinary.txt"), "ordinary\n", "utf8");
    await writeFile(path.join(sibling, "secret.txt"), "sibling\n", "utf8");
    await writeFile(path.join(outside, "secret.txt"), "outside\n", "utf8");
    await symlink(path.join(outside, "secret.txt"), path.join(selectedRoot, "leaf-link.txt"));
    await symlink(outside, path.join(selectedRoot, "dir-link"), "dir");

    const prepared = await prepareSelectedOutputDirectory(root, selectedRoot);
    expect((await readContainedRegularFile(prepared, "ordinary.txt"))?.toString("utf8")).toBe("ordinary\n");
    expect(await readContainedRegularFile(prepared, "../run-sibling/secret.txt")).toBeNull();
    expect(await readContainedRegularFile(prepared, "leaf-link.txt")).toBeNull();
    expect(await readContainedRegularFile(prepared, "dir-link/secret.txt")).toBeNull();
  });

  it("rejects a selected-root alias retarget and same-path directory recreation", async () => {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    const alias = path.join(root, "selected");
    await mkdir(first);
    await mkdir(second);
    await writeFile(path.join(second, "sentinel.txt"), "unchanged\n", "utf8");
    await symlink(first, alias, "dir");
    const preparedAlias = await prepareSelectedOutputDirectory(root, alias);

    await rm(alias);
    await symlink(second, alias, "dir");
    await expect(assertPreparedSelectedOutputDirectory(preparedAlias)).rejects.toThrow(/changed physical destination/i);
    await expect(writeContainedOutputFile(preparedAlias, "sentinel.txt", "mutated\n", "utf8"))
      .rejects.toThrow(/changed physical destination/i);
    expect(await readFile(path.join(second, "sentinel.txt"), "utf8")).toBe("unchanged\n");

    const recreated = path.join(root, "recreated");
    await mkdir(recreated);
    const preparedRecreated = await prepareSelectedOutputDirectory(root, recreated);
    await rm(recreated, { recursive: true });
    await mkdir(recreated);
    await writeFile(path.join(recreated, "sentinel.txt"), "unchanged\n", "utf8");
    await expect(assertPreparedSelectedOutputDirectory(preparedRecreated)).rejects.toThrow(/identity changed/i);
    await expect(writeContainedOutputFile(preparedRecreated, "sentinel.txt", "mutated\n", "utf8"))
      .rejects.toThrow(/identity changed/i);
    expect(await readFile(path.join(recreated, "sentinel.txt"), "utf8")).toBe("unchanged\n");
  });

  it("rejects hardlinked inputs and atomically replaces an ordinary output file", async () => {
    const selectedRoot = path.join(root, "selected-hardlink");
    const outside = path.join(root, "outside-hardlink.txt");
    await mkdir(selectedRoot);
    await writeFile(outside, "unchanged\n", "utf8");
    const hardlink = path.join(selectedRoot, "hardlink.txt");
    try {
      await link(outside, hardlink);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(code)) return;
      throw error;
    }
    const prepared = await prepareSelectedOutputDirectory(root, selectedRoot);
    expect(await readContainedRegularFile(prepared, "hardlink.txt")).toBeNull();
    await expect(writeContainedOutputFile(prepared, "hardlink.txt", "mutated\n", "utf8"))
      .rejects.toThrow(/hardlinks|single-link/i);
    await expect(prepareSelectedOutputFile(root, hardlink)).rejects.toThrow(/hardlinks|single-link/i);
    expect(await readFile(outside, "utf8")).toBe("unchanged\n");

    const ordinary = path.join(selectedRoot, "ordinary.txt");
    await writeFile(ordinary, "before\n", "utf8");
    const before = await stat(ordinary);
    await writeContainedOutputFile(prepared, "ordinary.txt", "after\n", "utf8");
    const after = await stat(ordinary);
    expect(await readFile(ordinary, "utf8")).toBe("after\n");
    expect(after.ino).not.toBe(before.ino);
  });
});
