import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getActor } from "../src/actor-registry.js";
import { runCuaLane, type CuaLaneDeps, type CuaLaneSpec } from "../src/cua-actor-lab.js";
import { DEVICE_PRESETS } from "../src/device-presets.js";
import type { E2BDesktopCreateOptions, E2BDesktopModule, E2BDesktopSandbox } from "../src/e2b-desktop-launch.js";
import { LAB_CONFIG_SCHEMA, parseLabConfig } from "../src/lab-config.js";
import type { CommsReceivingRun } from "../src/comms-receiving.js";
import type { ReceivingSurface } from "../src/comms-receiving-types.js";
import { prepareSelectedOutputDirectory } from "../src/selected-output-paths.js";

describe("real inbox wiring through the actual CUA lane", () => {
  it.each([false, true])("accepts the runner's 60s request default and tears down after attachment fails (finalization failure=%s)", async failFinalization => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-receiving-wiring-"));
    try {
      const parsed = parseLabConfig({ schema: LAB_CONFIG_SCHEMA, id: "mail-wiring", title: "Receiving wiring",
        subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
        actors: [{ type: "openai-computer-use", persona: "first-time-visitor", mission: "Explore the app." }],
        execution: { target: "e2b-desktop", timeoutMs: 60_000 }, scenario: { mode: "live" } });
      if (!parsed.ok) throw new Error(parsed.error.message);
      const command = vi.fn(async () => ({ exitCode: 0, stdout: "" }));
      const write = vi.fn(async () => undefined);
      const desktop = { sandboxId: "synthetic-desktop", getInfo: async () => ({ cpuCount: 2, memoryMB: 2048 }),
        commands: { run: command }, files: { write }, launch: async () => undefined,
        screenshot: async () => new Uint8Array(), wait: async () => undefined, stream: { start: async () => undefined, getAuthKey: () => "", getUrl: () => "" }
      } as E2BDesktopSandbox;
      const created: E2BDesktopCreateOptions[] = [];
      const kill = vi.fn(async () => true);
      const module: E2BDesktopModule = { Sandbox: {
        create: async (first: string | E2BDesktopCreateOptions, second?: E2BDesktopCreateOptions) => { created.push(typeof first === "string" ? second! : first); return desktop; }, kill
      } };
      const attach = vi.fn(async (_participantId: string, { surface }: { surface: ReceivingSurface }) => {
        // Production deployment + publication run through the fake SDK, rather than replacing the renderer.
        await surface.publish([{ path: "inbox", body: "<p>Synthetic inbox</p>", contentType: "text/html; charset=utf-8" }]);
        throw new Error("Synthetic interruption after inbox attachment");
      });
      const finishParticipant = vi.fn(async () => { if (failFinalization) throw new Error("Synthetic email finalization failure"); });
      const receiving = { address: () => "participant@example.test", attach, finishParticipant } as unknown as CommsReceivingRun;
      const spec: CuaLaneSpec = { laneId: "participant-a", laneIndex: 0, simId: "sim-001", streamId: "stream-001",
        persona: { id: "first-time-visitor", traitsApplied: [], promptDigest: "synthetic-prompt" }, instructions: "Explore the app.",
        deviceName: "desktop", devicePreset: DEVICE_PRESETS.desktop, resolution: [1440, 950], screenshotDir: "", traceArtifactPath: "actor.json" };
      const deps: CuaLaneDeps & { receiving: CommsReceivingRun } = {
        config: parsed.config, descriptor: getActor("openai-computer-use"), appUrl: "http://127.0.0.1:3000/", cloneRoute: false,
        subjectEnvNames: [], hasGithubToken: false, env: { AGENTMAIL_API_KEY: "synthetic-management-credential-canary" },
        openaiApiKey: "synthetic-openai", e2bApiKey: "synthetic-e2b", requestTimeoutMs: 60_000,
        perLaneSandboxMs: 60_000, timeoutMs: 60_000, laneCount: 1,
        artifactRoot: await prepareSelectedOutputDirectory(cwd, "artifacts"), labCwd: cwd, redactScreenshots: true,
        scrubKnownValues: value => value, receiving, runSession: async () => { throw new Error("Participant should not start after the injected attachment failure"); },
        now: Date.now, hooks: { loadDesktopModule: async () => module, onPhase: () => undefined }
      };
      const result = await runCuaLane(spec, deps);
      expect(attach).toHaveBeenCalledOnce();
      expect(attach.mock.calls[0]?.[0]).toBe("participant-a");
      expect(result.sessionError).toContain("Synthetic interruption after inbox attachment");
      expect(command).toHaveBeenCalled();
      expect(write).toHaveBeenCalled();
      expect(JSON.stringify([created, command.mock.calls, write.mock.calls])).not.toContain("synthetic-management-credential-canary");
      expect(finishParticipant).toHaveBeenCalledOnce();
      expect(kill).toHaveBeenCalledOnce();
      expect(kill.mock.invocationCallOrder[0]).toBeGreaterThan(finishParticipant.mock.invocationCallOrder[0]!);
      if (failFinalization) expect(result.warnings).toContain("Real email finalization is incomplete. Inspect communication cleanup with humanish comms recover.");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});
