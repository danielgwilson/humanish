import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterAll, describe, expect, it, vi } from "vitest";

import { e2bShell } from "../../../src/substrates/e2b/shell.js";
import type { E2BDesktopCreateOptions } from "../../../src/substrates/e2b/sdk.js";
import {
  modalSandboxes,
  modalSandboxModule,
  type ModalSandboxProfile,
} from "../../../src/substrates/modal/sandbox.js";
import type {
  ModalClient,
  ModalExecParams,
  ModalProcess,
  ModalReadStream,
  ModalSandbox,
  ModalSandboxCreateParams,
} from "../../../src/substrates/modal/sdk.js";
import { hasSetsid, shellContract } from "../../helpers/shell-contract.js";

// Modal's observed behavior (spike, modal 0.11.1, 2026-10-19): every exec runs as root with its
// stdin pipe open until closed, a timeout rejects with "Deadline exceeded", `poll` is null while
// the sandbox runs and its exit code after, and the first call on an unknown id rejects with
// gRPC NOT_FOUND (code 5).

function readStream(source: Readable, binary: boolean): ModalReadStream {
  const chunks = async function* () {
    for await (const chunk of source)
      yield binary ? new Uint8Array(chunk as Buffer) : String(chunk);
  };
  const iterator = chunks();
  return {
    [Symbol.asyncIterator]: () => iterator,
    async readText() {
      let text = "";
      for await (const chunk of iterator) text += String(chunk);
      return text;
    },
    async readBytes() {
      const parts: Uint8Array[] = [];
      for await (const chunk of iterator)
        parts.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      return Buffer.concat(parts);
    },
  };
}

const USER_PREFIX = ["setpriv", "--reuid=1000", "--regid=1000", "--init-groups", "--"];

/** A sandbox that runs each exec on this machine. It refuses a command not dropped to the user. */
function localModalSandbox(sandboxId = "fake-sb-local"): ModalSandbox & { execs: string[][] } {
  const execs: string[][] = [];
  return {
    sandboxId,
    execs,
    async exec(command: string[], params: ModalExecParams = {}): Promise<ModalProcess> {
      execs.push(command);
      if (params.timeoutMs !== undefined && params.timeoutMs % 1000 !== 0)
        throw new Error(`timeoutMs must be a multiple of 1000ms, got ${params.timeoutMs}`);
      if (USER_PREFIX.some((part, index) => command[index] !== part))
        throw new Error(`exec as root: ${command.join(" ")}`);
      const [program, ...args] = command.slice(USER_PREFIX.length);
      // The stand-in cannot change user; a login shell's profile is not this test's subject.
      const argv = program === "bash" && args[0] === "-lc" ? ["-c", ...args.slice(1)] : args;
      const child = spawn(program!, argv, {
        cwd: params.workdir,
        env: { ...process.env, ...params.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const exited = new Promise<number>((resolve) =>
        child.on("close", (code) => resolve(code ?? 1)),
      );
      const deadline =
        params.timeoutMs === undefined
          ? undefined
          : new Promise<never>((_resolve, reject) =>
              setTimeout(() => {
                child.kill();
                reject(new Error("Deadline exceeded while streaming stdio for exec"));
              }, params.timeoutMs).unref(),
            );
      const binary = params.mode === "binary";
      return {
        stdout: readStream(child.stdout, binary),
        stderr: readStream(child.stderr, binary),
        stdin: {
          writeText: async (text) => void child.stdin.write(text),
          writeBytes: async (bytes) => void child.stdin.write(bytes),
        },
        closeStdin: async () => void child.stdin.end(),
        wait: () => (deadline === undefined ? exited : Promise.race([exited, deadline])),
      };
    },
    terminate: async () => undefined,
    poll: async () => null,
    wait: async () => 137,
    getTags: async () => ({}),
    tunnels: async () => ({}),
  };
}

const profile: ModalSandboxProfile = {
  image: () => ({ dockerfileCommands: () => profile.image(undefined as never) }),
  cpu: 2,
  memoryMiB: 4096,
};

/** A client whose sandboxes keep Modal's lifecycle: running until terminated, then exit 137. */
function fakeClient(sandbox: () => ModalSandbox = () => localModalSandbox()) {
  const created: ModalSandboxCreateParams[] = [];
  const live = new Map<string, { exit: number | null; tags: Record<string, string> }>();
  const notFound = () => Object.assign(new Error("NOT_FOUND: sandbox not found"), { code: 5 });
  const handle = (sandboxId: string): ModalSandbox => ({
    ...sandbox(),
    sandboxId,
    async poll() {
      const state = live.get(sandboxId);
      if (state === undefined) throw notFound();
      return state.exit;
    },
    async terminate() {
      const state = live.get(sandboxId);
      if (state !== undefined) state.exit ??= 137;
    },
    async wait() {
      return live.get(sandboxId)?.exit ?? 137;
    },
    async getTags() {
      return { ...live.get(sandboxId)?.tags };
    },
  });
  const client: ModalClient = {
    apps: { fromName: async () => ({ appId: "ap-humanish" }) },
    images: { fromRegistry: () => profile.image(undefined as never) },
    sandboxes: {
      async create(_app, _image, params = {}) {
        if (params.timeoutMs !== undefined && params.timeoutMs % 1000 !== 0)
          throw new Error(`timeoutMs must be a multiple of 1000ms, got ${params.timeoutMs}`);
        created.push(params);
        const sandboxId = `fake-sb-${created.length}`;
        live.set(sandboxId, { exit: null, tags: { ...params.tags } });
        return handle(sandboxId);
      },
      fromId: async (sandboxId) => handle(sandboxId),
      async *list(params = {}) {
        for (const [sandboxId, state] of live)
          if (
            state.exit === null &&
            Object.entries(params.tags ?? {}).every(([key, value]) => state.tags[key] === value)
          )
            yield handle(sandboxId);
      },
    },
  };
  return { client, created };
}

const connection = { tokenId: "ak-test", tokenSecret: "as-test", environment: "studies" };

const scratch = mkdtempSync(path.join(tmpdir(), "humanish-modal-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("a Modal sandbox meets the Shell contract", () => {
  let count = 0;
  shellContract(
    () => {
      count += 1;
      const dir = path.join(scratch, String(count));
      mkdirSync(dir);
      const { client } = fakeClient();
      const created = modalSandboxModule(client, connection, profile).Sandbox.create({
        apiKey: "",
      });
      return {
        shell: e2bShell({
          commands: { run: async (...args) => (await created).commands.run(...args) },
          files: { write: async (...args) => (await created).files.write(...args) },
        }),
        dir,
      };
    },
    { start: hasSetsid },
  );
});

describe("Modal sandbox commands", () => {
  async function sandbox() {
    const { client } = fakeClient();
    return modalSandboxModule(client, connection, profile).Sandbox.create({ apiKey: "" });
  }

  it("ends a command's input, so a reader of stdin finishes", async () => {
    const desktop = await sandbox();
    await expect(desktop.commands.run("cat; echo after")).resolves.toMatchObject({
      exitCode: 0,
      stdout: "after\n",
    });
  });

  it("streams output to the callbacks as it arrives and returns all of it", async () => {
    const desktop = await sandbox();
    const seen: string[] = [];
    const result = await desktop.commands.run("echo one; sleep 0.2; echo two >&2", {
      onStdout: (data) => void seen.push(`out:${data}`),
      onStderr: (data) => void seen.push(`err:${data}`),
    });
    expect(seen).toEqual(["out:one\n", "err:two\n"]);
    expect(result).toEqual({ exitCode: 0, stdout: "one\n", stderr: "two\n" });
  });

  it("throws the E2B SDK's CommandExitError shape on a non-zero exit", async () => {
    const desktop = await sandbox();
    await expect(
      desktop.commands.run("printf so-far; echo boom >&2; exit 4"),
    ).rejects.toMatchObject({
      name: "CommandExitError",
      exitCode: 4,
      stdout: "so-far",
      stderr: "boom\n",
    });
  });

  it("names a command that outlives its timeout a TimeoutError, in whole seconds", async () => {
    const desktop = await sandbox();
    await expect(desktop.commands.run("sleep 5", { timeoutMs: 100 })).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("keeps the account's tokens out of an error Modal raises", async () => {
    const { client } = fakeClient(() => ({
      ...localModalSandbox(),
      exec: async () => {
        throw new Error(`invalid metadata value for token-secret: ${connection.tokenSecret}`);
      },
    }));
    const desktop = await modalSandboxModule(client, connection, profile).Sandbox.create({
      apiKey: "",
    });
    const error = await desktop.commands.run("true").catch((thrown: unknown) => thrown);
    expect(String(error)).not.toContain(connection.tokenSecret);
    expect(String(error)).toContain("[REDACTED_MODAL_TOKEN]");
  });

  it("passes the command's env and working directory", async () => {
    const desktop = await sandbox();
    await expect(
      desktop.commands.run('printf "%s %s" "$GREETING" "$(pwd)"', {
        envs: { GREETING: "hello" },
        cwd: scratch,
      }),
    ).resolves.toMatchObject({ stdout: `hello ${scratch}` });
  });
});

describe("creating a Modal sandbox", () => {
  const options: E2BDesktopCreateOptions = {
    apiKey: "",
    timeoutMs: 900_000,
    envs: { STUDY: "1" },
    metadata: { tool: "humanish", runId: "run-1", runKey: "cccccccccccccccc" },
  };

  it("asks for the VM runtime, the profile's size, the lifetime, env and owner tags", async () => {
    const { client, created } = fakeClient();
    const desktop = await modalSandboxModule(client, connection, profile).Sandbox.create({
      ...options,
      // A fractional caps.maxMinutes derives a lifetime Modal refuses unless it is whole seconds.
      timeoutMs: 899_400,
    });
    expect(created).toEqual([
      expect.objectContaining({
        runtime: "vm",
        cpu: 2,
        memoryMiB: 4096,
        timeoutMs: 900_000,
        env: { STUDY: "1" },
        tags: { tool: "humanish", runId: "run-1", runKey: "cccccccccccccccc" },
      }),
    ]);
    // Modal bills the requested size; one core is two vCPU.
    await expect(desktop.getInfo!()).resolves.toEqual({ cpuCount: 4, memoryMB: 4096 });
  });

  it("limits egress to the allowlist's domains and CIDR ranges", async () => {
    const { client, created } = fakeClient();
    await modalSandboxModule(client, connection, profile).Sandbox.create({
      ...options,
      network: {
        allowOut: ["api.example.com", "*.example.org", "10.0.0.0/8"],
        denyOut: ["0.0.0.0/0"],
      },
    });
    expect(created[0]).toMatchObject({
      outboundDomainAllowlist: ["api.example.com", "*.example.org"],
      outboundCidrAllowlist: ["10.0.0.0/8"],
    });
  });

  it("refuses what only E2B has: a template, or a header transform", async () => {
    const { client, created } = fakeClient();
    const module = modalSandboxModule(client, connection, profile);
    await expect(module.Sandbox.create("custom-template", options)).rejects.toMatchObject({
      name: "ModalUnsupportedError",
    });
    await expect(
      module.Sandbox.create({
        ...options,
        network: { rules: { "api.openai.com": [{ transform: { headers: { A: "b" } } }] } },
      }),
    ).rejects.toMatchObject({ name: "ModalUnsupportedError" });
    expect(created).toEqual([]);
  });
});

describe("Modal sandboxes by id", () => {
  it("kill ends a running sandbox once, and getInfo then reports it gone", async () => {
    const { client } = fakeClient();
    const { sandboxId } = await modalSandboxModule(client, connection, profile).Sandbox.create({
      apiKey: "",
    });
    const account = modalSandboxes(client, connection);
    await expect(account.getInfo(sandboxId)).resolves.toMatchObject({ state: "running" });
    await expect(account.kill(sandboxId)).resolves.toBe(true);
    await expect(account.kill(sandboxId)).resolves.toBe(false);
    await expect(account.getInfo(sandboxId)).rejects.toMatchObject({
      name: "SandboxNotFoundError",
    });
  });

  it("does not confirm a kill whose sandbox Modal never reports finished", async () => {
    vi.useFakeTimers();
    try {
      const { client } = fakeClient();
      const { sandboxId } = await modalSandboxModule(client, connection, profile).Sandbox.create({
        apiKey: "",
      });
      const stuck = { ...client, sandboxes: { ...client.sandboxes } };
      stuck.sandboxes.fromId = async (id) => ({
        ...(await client.sandboxes.fromId(id)),
        terminate: async () => undefined,
      });
      const settled = modalSandboxes(stuck, connection)
        .kill(sandboxId)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await settled).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a request Modal does not answer within the deadline", async () => {
    const { client } = fakeClient();
    const hung = { ...client, sandboxes: { ...client.sandboxes } };
    hung.sandboxes.fromId = async (id) => ({
      ...(await client.sandboxes.fromId(id)),
      poll: () => new Promise<number | null>(() => {}),
    });
    await expect(
      modalSandboxes(hung, connection).getInfo("fake-sb-1", { requestTimeoutMs: 50 }),
    ).rejects.toThrow("within 50 ms");
  });

  it("lists nothing, and creates no App, in an environment without the humanish App", async () => {
    const { client } = fakeClient();
    const lookups: unknown[] = [];
    const empty = {
      ...client,
      apps: {
        fromName: async (_name: string, params?: unknown) => {
          lookups.push(params);
          throw Object.assign(new Error("NOT_FOUND: app not found"), { code: 5 });
        },
      },
    };
    const pages = modalSandboxes(empty, connection).list({
      query: { metadata: { tool: "humanish" } },
    });
    expect(await pages.nextItems()).toEqual([]);
    expect(lookups).toEqual([{ environment: "studies", createIfMissing: false }]);
  });

  it("reads an id Modal does not know as gone", async () => {
    const account = modalSandboxes(fakeClient().client, connection);
    await expect(account.kill("fake-sb-unknown")).resolves.toBe(false);
    await expect(account.getInfo("fake-sb-unknown")).rejects.toMatchObject({
      name: "SandboxNotFoundError",
    });
  });

  it("lists the running sandboxes that carry every given tag, with their tags", async () => {
    const { client } = fakeClient();
    const module = modalSandboxModule(client, connection, profile);
    const mine = { tool: "humanish", runId: "run-1", runKey: "aaaaaaaaaaaaaaaa" };
    const { sandboxId } = await module.Sandbox.create({ apiKey: "", metadata: mine });
    await module.Sandbox.create({ apiKey: "", metadata: { ...mine, runKey: "bbbbbbbbbbbbbbbb" } });
    const ended = await module.Sandbox.create({ apiKey: "", metadata: mine });
    const account = modalSandboxes(client, connection);
    await account.kill(ended.sandboxId);
    const pages = account.list({ query: { metadata: mine } });
    expect(pages.hasNext).toBe(true);
    expect(await pages.nextItems()).toEqual([{ sandboxId, metadata: mine, state: "running" }]);
    expect(pages.hasNext).toBe(false);
  });
});
