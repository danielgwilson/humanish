// A local-agent participant's CLI is checked before any sandbox exists. A CLI that is missing,
// signed out, or cannot report its sign-in status is refused as AGENT_SIGNIN_REQUIRED, with a
// message that names the fix. A fake `codex` on a temporary PATH stands in for each case.

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { liveCuaRejection } from "../../../src/routes/computer-use/preflight.js";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A directory to use as PATH, holding a `codex` that runs `script`, or empty when it is undefined. */
async function pathWithCodex(script: string | undefined): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "humanish-local-agent-"));
  dirs.push(dir);
  if (script !== undefined) {
    const bin = path.join(dir, "codex");
    await writeFile(bin, `#!/bin/sh\n${script}\n`);
    await chmod(bin, 0o755);
  }
  return dir;
}

describe("a local-agent participant's CLI at preflight", () => {
  it.each([
    ["is not on PATH", undefined, "needs the codex CLI on PATH and signed in"],
    ["reports not signed in", 'echo "Not logged in"\nexit 1', "reports not signed in"],
    [
      "cannot report its sign-in status",
      'echo "unexpected output"\nexit 2',
      "authentication status could not be checked",
    ],
  ])("is refused as AGENT_SIGNIN_REQUIRED when the CLI %s", async (_name, script, message) => {
    const dir = await pathWithCodex(script);
    const refusal = await liveCuaRejection({
      caps: {},
      model: undefined,
      hooks: {},
      env: { PATH: dir, HOME: dir, E2B_API_KEY: "e2b-test-key" },
      openaiApiKey: "",
      e2bApiKey: "e2b-test-key",
      localAgentRoute: true,
      preferredLocalAgent: "codex",
      subjectEnvNames: [],
      externalCommsConfig: undefined,
    });
    expect(refusal?.code).toBe("HUMANISH_CUA_LAB_AGENT_SIGNIN_REQUIRED");
    expect(refusal?.message).toContain(message);
  });
});
