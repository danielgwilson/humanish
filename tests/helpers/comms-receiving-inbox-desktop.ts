import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { E2BDesktopSandbox } from "../../src/e2b-desktop-launch.js";

/** Runs the production surface server and publication commands locally, without any provider. */
export function localInboxDesktop(): { desktop: E2BDesktopSandbox; files: string[] } {
  const files: string[] = [];
  const desktop = {
    commands: {
      async run(command: string, options?: { timeoutMs?: number }) {
        try { const result = await promisify(execFile)("bash", ["-c", command], { timeout: options?.timeoutMs ?? 15000, maxBuffer: 1024 * 1024 }); return { exitCode: 0, ...result }; }
        catch (error) { return { exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : "Failed" }; }
      }
    },
    files: { async write(path: string, body: string | ArrayBuffer) {
      files.push(path); await mkdir(dirname(path), { recursive: true });
      await writeFile(path, typeof body === "string" ? body : Buffer.from(body));
    } }
  } as E2BDesktopSandbox;
  return { desktop, files };
}
export async function unusedInboxPort(): Promise<number> {
  const server = createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test port");
  const port = address.port; await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
