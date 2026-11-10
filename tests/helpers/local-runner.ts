import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import type { Runner } from "../../src/remote/runner.js";

/** A runner whose commands and file reads run on this machine, in a home directory of their own. */
export async function localRunner() {
  const home = await mkdtemp(path.join(tmpdir(), "humanish-runner-home-"));
  const runner = {
    sandbox: {
      files: {
        read: async (file: string) =>
          Readable.toWeb(createReadStream(path.join(home, file))) as ReadableStream<Uint8Array>,
      },
    },
    shell: {
      run: (command: string) =>
        new Promise((resolve) => {
          execFile(
            "bash",
            ["-c", command],
            { cwd: home, env: { ...process.env, HOME: home }, encoding: "utf8" },
            (error, stdout, stderr) =>
              resolve({
                exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
                stdout,
                stderr,
              }),
          );
        }),
    },
  } as unknown as Runner;
  const runDir = path.join(home, "project", ".humanish", "runs", "cua-remote");
  await mkdir(runDir, { recursive: true });
  await mkdir(path.join(home, ".humanish-remote"), { recursive: true });
  return { home, runner, runDir };
}
