import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CommandExitError } from "@e2b/desktop";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { E2BDesktopSandbox } from "../../../src/substrates/e2b/sdk.js";
import { e2bShell, type E2BShellHandle } from "../../../src/substrates/e2b/shell.js";
import { hasSetsid, shellContract } from "../../helpers/shell-contract.js";

// A stand-in for the SDK's command and file surface that runs on this machine. Like the real
// Sandbox, `commands.run` throws the SDK's own CommandExitError on a non-zero exit.
function localSandbox(): E2BShellHandle {
  return {
    commands: {
      run: (command: string) =>
        new Promise((resolve, reject) => {
          execFile("bash", ["-c", command], (error, stdout, stderr) => {
            if (error === null) {
              resolve({ exitCode: 0, stdout, stderr });
              return;
            }
            const exitCode = typeof error.code === "number" ? error.code : 1;
            reject(
              new CommandExitError({ exitCode, stdout, stderr, error: `exit status ${exitCode}` }),
            );
          });
        }),
    },
    files: {
      async write(filePath: string, data: string | ArrayBuffer) {
        writeFileSync(filePath, typeof data === "string" ? data : Buffer.from(data));
        return undefined;
      },
    },
  } as E2BShellHandle;
}

const scratch = mkdtempSync(path.join(tmpdir(), "humanish-shell-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("the E2B shell meets the Shell contract", () => {
  let count = 0;
  shellContract(
    () => {
      count += 1;
      const dir = path.join(scratch, String(count));
      mkdirSync(dir);
      return { shell: e2bShell(localSandbox()), dir };
    },
    { start: hasSetsid },
  );
});

describe("e2bShell", () => {
  function recordingSandbox(run: E2BDesktopSandbox["commands"]["run"]) {
    const writes: unknown[][] = [];
    const sandbox = {
      commands: { run: vi.fn(run) },
      files: {
        write: vi.fn(async (...args: unknown[]) => {
          writes.push(args);
          return undefined;
        }),
      },
    } as unknown as E2BShellHandle;
    return { sandbox, writes };
  }

  it("forwards call options only when given, and binary writes as an octet stream", async () => {
    const { sandbox, writes } = recordingSandbox(async () => ({ exitCode: 0, stdout: "" }));
    const shell = e2bShell(sandbox);
    await shell.run("true");
    await shell.run("true", { requestTimeoutMs: 5 });
    expect(vi.mocked(sandbox.commands.run).mock.calls).toEqual([
      ["true"],
      ["true", { requestTimeoutMs: 5 }],
    ]);
    const bytes = new ArrayBuffer(2);
    await shell.writeFile("/a.txt", "text");
    await shell.writeFile("/b.bin", bytes, { requestTimeoutMs: 7 });
    expect(writes).toEqual([
      ["/a.txt", "text"],
      ["/b.bin", bytes, { requestTimeoutMs: 7, useOctetStream: true }],
    ]);
  });

  it("launches start in its own session with its output detached", async () => {
    const { sandbox } = recordingSandbox(async () => ({ exitCode: 0, stdout: "" }));
    await e2bShell(sandbox).start("python3 server.py");
    expect(vi.mocked(sandbox.commands.run).mock.calls[0]?.[0]).toBe(
      "setsid -f python3 server.py < /dev/null > /dev/null 2>&1",
    );
  });

  it("keeps the SDK's reason when a failed command has no stderr", async () => {
    const { sandbox } = recordingSandbox(async () => {
      throw new CommandExitError({ exitCode: 2, stdout: "", stderr: "", error: "exit status 2" });
    });
    await expect(e2bShell(sandbox).run("false")).resolves.toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "exit status 2",
    });
  });

  it("rejects a transport failure instead of inventing an exit", async () => {
    const transport = new Error("fetch failed");
    const { sandbox } = recordingSandbox(async () => {
      throw transport;
    });
    await expect(e2bShell(sandbox).run("true")).rejects.toBe(transport);
  });

  it("retries a transient write once when asked, and only then", async () => {
    let attempts = 0;
    const sandbox = {
      commands: { run: vi.fn() },
      files: {
        write: vi.fn(async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("12: [unavailable] envd not ready");
          return undefined;
        }),
      },
    } as unknown as E2BShellHandle;
    const onRetry = vi.fn();
    await e2bShell(sandbox).writeFile("/archive", new ArrayBuffer(1), {
      retryOnce: { onRetry, sleep: async () => undefined },
    });
    expect(attempts).toBe(2);
    expect(onRetry).toHaveBeenCalledWith("12: [unavailable] envd not ready");

    attempts = 0;
    await expect(e2bShell(sandbox).writeFile("/archive", new ArrayBuffer(1))).rejects.toThrow(
      "[unavailable]",
    );
    expect(attempts).toBe(1);
  });
});
