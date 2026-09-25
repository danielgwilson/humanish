import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { expect, it } from "vitest";
import { createRestrictedCodexParticipant } from "../src/restricted-codex-participant.js";

it("rejects non-participant arguments in the captured native callback without leaking resources", async () => {
  // The captured callback uses a synthetic observation probe, not valid UI
  // actions. Reject those arguments before yielding any desktop input.
  const fixture = fileURLToPath(new URL("./fixtures/restricted-codex/fake-process.mjs", import.meta.url));
  const root = await mkdtemp(path.join(tmpdir(), "humanish-participant-wire-"));
  const authHome = path.join(root, "auth"), tempRoot = path.join(root, "temp"), trace = path.join(root, "calls.jsonl");
  await mkdir(authHome); await mkdir(tempRoot);
  await writeFile(path.join(authHome, "auth.json"), "synthetic-original-login", { mode: 0o600 });
  const handle = createRestrictedCodexParticipant({ authMode: "operator", reasoningEffort: "high", session: { executable: process.execPath, authHome, tempRoot,
    env: { HOME: authHome, PATH: process.env.PATH, XDG_CACHE_HOME: path.join(root, "cache") },
    spawnFn: (_file, args, settings) => spawn(process.execPath, [fixture, "participant-success", trace, ...args], settings) } });
  try {
    await expect(handle.provider.nextTurn({ instructions: "Use the synthetic page.", observation: {
      stateSignature: "synthetic", screenshot: PNG.sync.write(new PNG({ width: 2, height: 2 })) } }, new AbortController().signal))
      .rejects.toMatchObject({ code: "protocol_error", receipt: { dispatched: true, cleanup: "confirmed", usageComplete: false } });
    expect(await handle.close()).toEqual({ status: "confirmed" });
    expect(await readdir(tempRoot)).toEqual([]);
    expect(await readFile(path.join(authHome, "auth.json"), "utf8")).toBe("synthetic-original-login");
    const calls = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(c => c.method === "turn/start")).toHaveLength(1);
    const methods = calls.map(c => c.method);
    for (const gate of ["initialize", "config/read", "account/read", "thread/start", "mcpServerStatus/list"])
      expect(methods.indexOf(gate)).toBeLessThan(methods.indexOf("turn/start"));
    expect(calls.find(c => c.method === "thread/start").params.dynamicTools[0].name).toBe("humanish_ui");
    expect(calls.find(c => c.method === "turn/start").params.outputSchema.properties.outcome.enum).toEqual(["reached", "not_reached", "blocked"]);
  } finally { await handle.close(); await rm(root, { recursive: true, force: true }); }
});
