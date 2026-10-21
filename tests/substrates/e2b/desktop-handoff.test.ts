// The desktop's stand-ins for the apps a link hands off to, run under the real bash and sh: the
// browser launch script installs them, a browser runs `xdg-email` or `xdg-open` by name, and the
// reader the participant's executor polls returns each link once.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  externalHandoffReader,
  externalLinkHandlerSetup,
} from "../../../src/substrates/e2b/desktop-handoff.js";
import type { ShellResult } from "../../../src/substrates/shell.js";

const execFileAsync = promisify(execFile);

async function bash(command: string, env: NodeJS.ProcessEnv = process.env): Promise<ShellResult> {
  try {
    const { stdout, stderr } = await execFileAsync("bash", ["-c", command], { env });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

describe("the desktop's stand-ins for a link's app", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "humanish-external-links-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** What a browser started by the launch script does with a link it cannot open itself. */
  const browserHandsOff = (opener: string, url: string, env?: NodeJS.ProcessEnv) =>
    bash(
      [
        "set -euo pipefail",
        externalLinkHandlerSetup(path.join(dir, "links")),
        `${opener} '${url}'`,
      ].join("\n"),
      env,
    );

  it("reads a mailto link back once, keeping only its recipients", async () => {
    const opened = await browserHandsOff(
      "xdg-email",
      "mailto:help@example.test?cc=desk%40example.test&subject=Refund&body=order%2042%20is%20late",
    );
    expect(opened.exitCode).toBe(0);
    const read = externalHandoffReader(
      { run: (command) => bash(command) },
      {
        dir: path.join(dir, "links"),
        requestTimeoutMs: 5_000,
      },
    );
    expect(await read()).toEqual([
      { scheme: "mailto", recipients: ["help@example.test", "desk@example.test"] },
    ]);
    expect(await read()).toEqual([]);
  });

  it("reads a phone link by its scheme, and later links after it", async () => {
    const read = externalHandoffReader(
      { run: (command) => bash(command) },
      {
        dir: path.join(dir, "links"),
        requestTimeoutMs: 5_000,
      },
    );
    await browserHandsOff("xdg-open", "tel:+1-555-0100");
    expect(await read()).toEqual([{ scheme: "tel" }]);
    await browserHandsOff("xdg-open", "sms:+1-555-0100?body=hello");
    expect(await read()).toEqual([{ scheme: "sms" }]);
  });

  it("passes a web link to the desktop's own opener", async () => {
    const realBin = path.join(dir, "real-bin");
    await mkdir(realBin);
    const opener = path.join(realBin, "xdg-open");
    await writeFile(opener, `#!/bin/sh\nprintf '%s\\n' "$1" > '${path.join(dir, "opened")}'\n`);
    await chmod(opener, 0o755);
    const opened = await browserHandsOff("xdg-open", "https://example.test/help", {
      ...process.env,
      PATH: `${realBin}:${process.env.PATH ?? ""}`,
    });
    expect(opened.exitCode).toBe(0);
    expect(await readFile(path.join(dir, "opened"), "utf8")).toBe("https://example.test/help\n");
    const read = externalHandoffReader(
      { run: (command) => bash(command) },
      {
        dir: path.join(dir, "links"),
        requestTimeoutMs: 5_000,
      },
    );
    expect(await read()).toEqual([]);
  });
});
