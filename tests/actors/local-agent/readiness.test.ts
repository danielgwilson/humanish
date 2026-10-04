// Whether a local-agent participant can run here, checked before any sandbox exists. A fake `codex`
// on a temporary `PATH` stands in for each case; computer use and shared world map the kind to their
// own error codes.

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { defaultCodexCliVersion } from "../../../src/actors/codex/codex-admission.js";
import { restrictedCodexNpmTarget } from "../../../src/actors/codex/restricted-executable.js";
import { localAgentRefusal } from "../../../src/actors/local-agent/readiness.js";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A directory to use as `PATH`, holding a `codex` that runs `script`, or empty when it is undefined. */
async function pathWithCodex(script: string | undefined): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "humanish-local-agent-readiness-"));
  dirs.push(dir);
  if (script !== undefined) {
    const bin = path.join(dir, "codex");
    await writeFile(bin, `#!/bin/sh\n${script}\n`);
    await chmod(bin, 0o755);
  }
  return dir;
}

/** A signed-in ChatGPT-account codex that reports `version` for --version. */
const signedIn = (version: string) =>
  [
    'if [ "$1" = "--version" ]; then echo "codex-cli ' + version + '"; exit 0; fi',
    'if [ "$1" = "login" ]; then echo "Logged in using ChatGPT"; exit 0; fi',
    "exit 3",
  ].join("\n");

const supportedHost = restrictedCodexNpmTarget(process.platform, process.arch) !== undefined;
const qualified = defaultCodexCliVersion();

async function refusal(script: string | undefined, caps: { maxUsd?: number } = {}) {
  const dir = await pathWithCodex(script);
  return localAgentRefusal({ agent: "codex", env: { PATH: dir, HOME: dir }, caps });
}

/**
 * A `PATH` holding a `claude` that reports `version`. It is signed in, or with `tokenOnly` signed
 * in only while CLAUDE_CODE_OAUTH_TOKEN is set, which the readiness check is then given.
 */
async function claudeRefusal(version: string, tokenOnly = false) {
  const dir = await mkdtemp(path.join(tmpdir(), "humanish-local-agent-readiness-"));
  dirs.push(dir);
  const signedIn = tokenOnly ? '[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]' : "true";
  await writeFile(
    path.join(dir, "claude"),
    [
      "#!/bin/sh",
      `if [ "$1" = "--version" ]; then echo "${version} (Claude Code)"; exit 0; fi`,
      `if [ "$1" = "auth" ] && ${signedIn}; then echo '{"loggedIn": true}'; exit 0; fi`,
      `if [ "$1" = "auth" ]; then echo '{"loggedIn": false}'; exit 1; fi`,
      "exit 3",
    ].join("\n"),
  );
  await chmod(path.join(dir, "claude"), 0o755);
  const env = {
    PATH: dir,
    HOME: dir,
    ...(tokenOnly ? { CLAUDE_CODE_OAUTH_TOKEN: "synthetic" } : {}),
  };
  return localAgentRefusal({ agent: "claude", env, caps: {} });
}

describe("localAgentRefusal", () => {
  it("reports a missing CLI when it is not on `PATH`", async () => {
    const result = await refusal(undefined);
    expect(result?.kind).toBe("agent-missing");
    expect(result?.message).toContain("needs the codex CLI on PATH and signed in");
  });

  it.each([
    ["reports it is not signed in", 'echo "Not logged in"\nexit 1', "reports it is not signed in"],
    [
      "cannot report its sign-in status",
      'echo "unexpected output"\nexit 2',
      "authentication status could not be checked",
    ],
  ])("asks for sign-in when the CLI %s", async (_name, script, message) => {
    const result = await refusal(script);
    expect(result?.kind).toBe("signin-required");
    expect(result?.message).toContain(message);
  });

  it("refuses an unqualified Codex release as unsupported", async () => {
    const result = await refusal(signedIn("0.0.1"));
    expect(result?.kind).toBe("unsupported");
  });

  it.skipIf(!supportedHost || qualified === undefined)(
    "refuses a dollar cap on a ChatGPT-account Codex, and admits it without one",
    async () => {
      const capped = await refusal(signedIn(qualified!), { maxUsd: 1 });
      expect(capped?.kind).toBe("unpriced-cap");
      expect(capped?.message).toContain("no API-dollar price");
      expect(await refusal(signedIn(qualified!))).toBeUndefined();
    },
  );

  it("refuses a Claude Code older than the release with --restricted, and admits the floor", async () => {
    const old = await claudeRefusal("2.1.247");
    expect(old?.kind).toBe("unsupported");
    expect(old?.message).toContain("2.1.248");
    expect(old?.message).toContain("claude update");
    expect(await claudeRefusal("2.1.248")).toBeUndefined();
  });

  it("checks Claude Code's sign-in with the environment the participant gets", async () => {
    // The participant does not get CLAUDE_CODE_OAUTH_TOKEN, so a login that needs it cannot run one.
    expect((await claudeRefusal("2.1.289", true))?.kind).toBe("signin-required");
  });
});
