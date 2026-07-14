import { access, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startCodexAppServerUi } from "../src/codex-app-server-ui.js";
import { runCodexAppServerSession } from "../src/codex-app-server.js";

describe("Codex app-server output containment", () => {
  let root: string;
  let project: string;
  let fakeServer: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "humanish-codex-containment-"));
    project = path.join(root, "project");
    fakeServer = path.join(root, "fake-app-server.mjs");
    await mkdir(project);
    await writeFile(fakeServer, [
      "import fs from 'node:fs';",
      "import readline from 'node:readline';",
      "const marker = process.argv[2];",
      "const delay = Number(process.argv[3] || '0');",
      "if (marker) fs.writeFileSync(marker, 'started\\n');",
      "const rl = readline.createInterface({ input: process.stdin });",
      "const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
      "const thread = { id: 'thread-safe', sessionId: 'session-safe', model: 'test-model', cliVersion: 'test-cli' };",
      "const turn = { id: 'turn-safe', status: 'inProgress' };",
      "rl.on('line', (line) => {",
      "  const msg = JSON.parse(line);",
      "  if (msg.method === 'initialize') send({ id: msg.id, result: { userAgent: 'containment-fake' } });",
      "  if (msg.method === 'account/login/start') send({ id: msg.id, result: { type: 'apiKey' } });",
      "  if (msg.method === 'thread/start') { send({ id: msg.id, result: { thread } }); send({ method: 'thread/started', params: { thread } }); }",
      "  if (msg.method === 'turn/start') {",
      "    send({ id: msg.id, result: { turn } });",
      "    send({ method: 'turn/started', params: { threadId: thread.id, turn } });",
      "    setTimeout(() => {",
      "      send({ method: 'turn/completed', params: { threadId: thread.id, turn: { ...turn, status: 'completed' } } });",
      "      setTimeout(() => process.exit(0), 20);",
      "    }, delay);",
      "  }",
      "});"
    ].join("\n"), "utf8");
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("rejects an aliased implicit managed root before spawning the actor", async () => {
    const outside = path.join(root, "outside");
    const marker = path.join(root, "actor-started");
    await mkdir(outside);
    await symlink(outside, path.join(project, ".humanish"), "dir");

    await expect(startCodexAppServerUi({
      actorCommand: actorCommand(marker),
      cwd: project,
      prompt: "test",
      timeoutMs: 2_000
    })).rejects.toThrow(/symbolic links/i);
    await expect(access(marker)).rejects.toThrow();
  });

  it("authorizes the same explicit root and keeps omitted state inside that bound root", async () => {
    const outside = path.join(root, "outside");
    const marker = path.join(root, "actor-started");
    await mkdir(outside);
    await symlink(outside, path.join(project, ".humanish"), "dir");

    const controller = await startCodexAppServerUi({
      actorCommand: actorCommand(marker),
      cwd: project,
      prompt: "test",
      runRoot: ".humanish/codex-app-server-ui",
      timeoutMs: 2_000
    });
    const completed = await controller.completion;
    expect(completed.status).toBe("passed");
    expect(controller.stateFile).toBe(path.join(project, ".humanish", "codex-app-server-ui", "state.json"));
    expect(await readFile(path.join(outside, "codex-app-server-ui", "state.json"), "utf8")).toContain('"status": "passed"');
  });

  it("keeps an explicit independent state path separate and rejects its exact symlink leaf", async () => {
    const runRoot = path.join(root, "selected-run");
    const stateParent = path.join(root, "selected-state-parent");
    const stateAlias = path.join(project, "state-parent-alias");
    const marker = path.join(root, "actor-started");
    await mkdir(runRoot);
    await mkdir(stateParent);
    await symlink(stateParent, stateAlias, "dir");

    const controller = await startCodexAppServerUi({
      actorCommand: actorCommand(marker),
      cwd: project,
      prompt: "test",
      runRoot,
      stateFile: "state-parent-alias/controller.json",
      timeoutMs: 2_000
    });
    await controller.completion;
    expect(await readFile(path.join(stateParent, "controller.json"), "utf8")).toContain('"schema"');
    await expect(access(path.join(runRoot, "state.json"))).rejects.toThrow();

    const sentinel = path.join(root, "state-sentinel.json");
    const linkedState = path.join(project, "linked-state.json");
    await writeFile(sentinel, "unchanged\n", "utf8");
    await symlink(sentinel, linkedState);
    await expect(startCodexAppServerUi({
      actorCommand: actorCommand(path.join(root, "actor-should-not-start")),
      cwd: project,
      prompt: "test",
      runRoot: path.join(root, "other-run"),
      stateFile: linkedState,
      timeoutMs: 2_000
    })).rejects.toThrow(/regular files/i);
    expect(await readFile(sentinel, "utf8")).toBe("unchanged\n");
  });

  it("rejects a selected-root retarget during the child window without mutating the new target", async () => {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    const alias = path.join(project, "run-alias");
    const marker = path.join(root, "actor-started");
    await mkdir(first);
    await mkdir(second);
    await writeFile(path.join(second, "sentinel.txt"), "unchanged\n", "utf8");
    await symlink(first, alias, "dir");

    const controller = await startCodexAppServerUi({
      actorCommand: actorCommand(marker, 250),
      cwd: project,
      keepOpen: true,
      prompt: "test",
      runRoot: "run-alias",
      timeoutMs: 10_000
    });
    await waitForFile(marker);
    await rm(alias);
    await symlink(second, alias, "dir");
    try {
      await expect(controller.completion).rejects.toThrow(/changed physical destination/i);
      expect(await readFile(path.join(second, "sentinel.txt"), "utf8")).toBe("unchanged\n");
      await expect(access(path.join(second, "codex-app-server", "summary.json"))).rejects.toThrow();
      await expect(fetch(controller.url)).rejects.toThrow();
    } finally {
      await controller.close();
    }
  });

  it("serves only contained single-link artifacts and handles malformed encodings as 404", async () => {
    const runRoot = path.join(root, "served-run");
    const marker = path.join(root, "actor-started");
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "DO-NOT-SERVE\n", "utf8");
    const controller = await startCodexAppServerUi({
      actorCommand: actorCommand(marker),
      cwd: project,
      keepOpen: true,
      prompt: "test",
      runRoot,
      timeoutMs: 2_000
    });
    await controller.completion;
    await symlink(path.join(outside, "secret.txt"), path.join(runRoot, "leaf-link.txt"));
    await symlink(outside, path.join(runRoot, "dir-link"), "dir");
    let hardlinkSupported = true;
    try {
      await link(path.join(outside, "secret.txt"), path.join(runRoot, "hard-link.txt"));
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(code)) hardlinkSupported = false;
      else throw error;
    }
    try {
      expect((await fetch(new URL("artifact/codex-app-server/summary.json", controller.url))).status).toBe(200);
      for (const suffix of [
        "artifact/leaf-link.txt",
        ...(hardlinkSupported ? ["artifact/hard-link.txt"] : []),
        "artifact/dir-link%2Fsecret.txt",
        "artifact/..%2Foutside%2Fsecret.txt",
        "artifact/%ZZ"
      ]) {
        const response = await fetch(new URL(suffix, controller.url));
        expect(response.status, suffix).toBe(404);
        expect(await response.text()).not.toContain("DO-NOT-SERVE");
      }
    } finally {
      await controller.close();
    }
  });

  it("preflights direct-session generated paths before actor spawn", async () => {
    const selected = path.join(root, "direct-selected");
    const outside = path.join(root, "direct-outside");
    const marker = path.join(root, "direct-actor-started");
    await mkdir(selected);
    await mkdir(outside);
    await writeFile(path.join(outside, "sentinel.txt"), "unchanged\n", "utf8");
    await symlink(outside, path.join(selected, "codex-app-server"), "dir");

    await expect(runCodexAppServerSession({
      actorCommand: [process.execPath, fakeServer, marker, "0"],
      cwd: project,
      prompt: "test",
      runRoot: selected,
      timeoutMs: 2_000
    })).rejects.toThrow(/symbolic links/i);
    await expect(access(marker)).rejects.toThrow();
    expect(await readFile(path.join(outside, "sentinel.txt"), "utf8")).toBe("unchanged\n");

    await rm(path.join(selected, "codex-app-server"));
    await mkdir(path.join(selected, "codex-app-server"));
    try {
      await link(path.join(outside, "sentinel.txt"), path.join(selected, "codex-app-server", "summary.json"));
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(code)) return;
      throw error;
    }
    const hardlinkMarker = path.join(root, "direct-hardlink-actor-started");
    await expect(runCodexAppServerSession({
      actorCommand: [process.execPath, fakeServer, hardlinkMarker, "0"],
      cwd: project,
      prompt: "test",
      runRoot: selected,
      timeoutMs: 2_000
    })).rejects.toThrow(/hardlink|single-link/i);
    await expect(access(hardlinkMarker)).rejects.toThrow();
    expect(await readFile(path.join(outside, "sentinel.txt"), "utf8")).toBe("unchanged\n");
  });

  function actorCommand(marker: string, delay = 0): string {
    return [process.execPath, fakeServer, marker, String(delay)].map((part) => JSON.stringify(part)).join(" ");
  }
});

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (await access(filePath).then(() => true).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path.basename(filePath)}.`);
}
