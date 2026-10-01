import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { saveCommsConnection } from "../../src/comms/connections.js";
import { resolveReceivingConnection } from "../../src/comms/receiving-runtime.js";
import { setUserKey } from "../../src/keys/key-resolution.js";

// resolveReceivingConnection runs key discovery. keyDeps points its stores at a temp home, so a
// test never reads the machine's own ~/.config/humanish/keys.env or ~/.e2b, or runs gh.
let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-receiving-keys-"));
  expect((await saveCommsConnection(cwd)).ok).toBe(true);
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

it("finds the connection's key in the store keyDeps names, and only there", async () => {
  const withKey = path.join(cwd, "home-with-key");
  setUserKey("AGENTMAIL_API_KEY", "synthetic-stored-agentmail", {}, { homeDir: withKey });
  const keyDeps = (homeDir: string) => ({ homeDir, execText: async () => null });

  const resolved = await resolveReceivingConnection(cwd, "agentmail", {}, keyDeps(withKey));
  expect(resolved.apiKey).toBe("synthetic-stored-agentmail");
  await expect(
    resolveReceivingConnection(cwd, "agentmail", {}, keyDeps(path.join(cwd, "empty-home"))),
  ).rejects.toThrow("Email connection credential is missing");
});
