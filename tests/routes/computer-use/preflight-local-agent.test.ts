// A local-agent participant's CLI is checked before any sandbox exists. A missing CLI is refused as
// AGENT_MISSING; one that is signed out or cannot report its sign-in status as AGENT_SIGNIN_REQUIRED;
// an unqualified release as ACTOR_UNSUPPORTED; and a dollar cap on a ChatGPT-account Codex as
// UNPRICED_CAP. Each message names the fix. A fake `codex` on a temporary PATH stands in for each.

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { liveCuaRejection } from "../../../src/routes/computer-use/preflight.js";
import { admittedCodexCliVersions } from "../../../src/actors/codex/qualified-versions.js";
import { restrictedCodexNpmTarget } from "../../../src/actors/codex/restricted-executable.js";

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

/** liveCuaRejection for a local-agent participant whose PATH is `dir`. */
function rejection(dir: string, caps: { maxUsd?: number } = {}) {
  return liveCuaRejection({
    caps,
    brain: { kind: "local-agent", agent: "codex" },
    env: { PATH: dir, HOME: dir, E2B_API_KEY: "e2b-test-key" },
    requirements: [
      { kind: "key", name: "E2B_API_KEY" },
      { kind: "local-agent", agent: "codex" },
    ],
    externalCommsConfig: undefined,
  });
}

/** A `codex` that reports `version` and a ChatGPT-account sign-in. */
const signedIn = (version: string) =>
  [
    `if [ "$1" = "--version" ]; then echo "codex-cli ${version}"; exit 0; fi`,
    'if [ "$1" = "login" ]; then echo "Logged in using ChatGPT"; exit 0; fi',
    "exit 3",
  ].join("\n");

describe("a local-agent participant's CLI at preflight", () => {
  it("is refused as AGENT_MISSING when the CLI is not on PATH", async () => {
    const refusal = await rejection(await pathWithCodex(undefined));
    expect(refusal?.code).toBe("HUMANISH_CUA_LAB_AGENT_MISSING");
    expect(refusal?.message).toContain("needs the codex CLI on PATH and signed in");
  });

  it.each([
    ["reports not signed in", 'echo "Not logged in"\nexit 1', "reports not signed in"],
    [
      "cannot report its sign-in status",
      'echo "unexpected output"\nexit 2',
      "authentication status could not be checked",
    ],
  ])("is refused as AGENT_SIGNIN_REQUIRED when the CLI %s", async (_name, script, message) => {
    const refusal = await rejection(await pathWithCodex(script));
    expect(refusal?.code).toBe("HUMANISH_CUA_LAB_AGENT_SIGNIN_REQUIRED");
    expect(refusal?.message).toContain(message);
  });

  it("is refused as ACTOR_UNSUPPORTED when the CLI is an unqualified release", async () => {
    const refusal = await rejection(await pathWithCodex(signedIn("0.0.1")));
    expect(refusal?.code).toBe("HUMANISH_CUA_LAB_ACTOR_UNSUPPORTED");
  });

  const qualified = admittedCodexCliVersions(process.platform, process.arch)[0];
  it.skipIf(restrictedCodexNpmTarget(process.platform, process.arch) === undefined || !qualified)(
    "is refused as UNPRICED_CAP when a ChatGPT-account Codex has a dollar cap",
    async () => {
      const refusal = await rejection(await pathWithCodex(signedIn(qualified!)), { maxUsd: 1 });
      expect(refusal?.code).toBe("HUMANISH_CUA_LAB_UNPRICED_CAP");
      expect(refusal?.message).toContain("no API-dollar price");
    },
  );
});
