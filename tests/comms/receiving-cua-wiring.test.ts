import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getActor } from "../../src/actors/registry.js";
import { runCuaParticipant } from "../../src/routes/computer-use/participant-execution.js";
import { type CuaParticipantDeps } from "../../src/routes/computer-use/types.js";
import type {
  E2BDesktopCreateOptions,
  E2BDesktopModule,
  E2BDesktopSandbox,
} from "../../src/substrates/e2b/sdk.js";
import { LAB_CONFIG_SCHEMA } from "../../src/lab/types.js";
import { parseLabConfig } from "../../src/lab/config.js";
import type { CommsReceivingRun } from "../../src/comms/receiving.js";
import type { ReceivingSurface } from "../../src/comms/receiving-types.js";
import { DEFAULT_OPENAI_CU_MODEL } from "../../src/actors/computer-use/openai-provider.js";
import { prepareSelectedOutputDirectory } from "../../src/run/contained-output.js";
import { inertDesktopInput } from "../helpers/inert-desktop-input.js";
import { participantRun } from "../helpers/participant-run.js";

describe("real inbox wiring through the actual CUA lane", () => {
  it.each([false, true])(
    "accepts the runner's 60s request default and tears down after attachment fails (finalization failure=%s)",
    async (failFinalization) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "humanish-receiving-wiring-"));
      try {
        const parsed = parseLabConfig({
          schema: LAB_CONFIG_SCHEMA,
          id: "mail-wiring",
          title: "Receiving wiring",
          subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
          actors: [
            {
              type: "openai-computer-use",
              persona: "first-time-visitor",
              mission: "Explore the app.",
            },
          ],
          execution: { target: "e2b-desktop", timeoutMs: 60_000 },
          scenario: { mode: "live" },
        });
        if (!parsed.ok) throw new Error(parsed.error.message);
        const command = vi.fn(async () => ({ exitCode: 0, stdout: "" }));
        const write = vi.fn(async () => undefined);
        const desktop = {
          sandboxId: "synthetic-desktop",
          ...inertDesktopInput(),
          getInfo: async () => ({ cpuCount: 2, memoryMB: 2048 }),
          commands: { run: command },
          files: { write },
          launch: async () => undefined,
          screenshot: async () => new Uint8Array(),
          wait: async () => undefined,
          stream: { start: async () => undefined, getAuthKey: () => "", getUrl: () => "" },
        } as E2BDesktopSandbox;
        const created: E2BDesktopCreateOptions[] = [];
        const kill = vi.fn(async () => true);
        const module: E2BDesktopModule = {
          Sandbox: {
            create: async (
              first: string | E2BDesktopCreateOptions,
              second?: E2BDesktopCreateOptions,
            ) => {
              created.push(typeof first === "string" ? second! : first);
              return desktop;
            },
            kill,
          },
        };
        const attach = vi.fn(
          async (_participantId: string, { surface }: { surface: ReceivingSurface }) => {
            // Production deployment + publication run through the fake SDK, rather than replacing the renderer.
            await surface.publish([
              {
                path: "inbox",
                body: "<p>Synthetic inbox</p>",
                contentType: "text/html; charset=utf-8",
              },
            ]);
            throw new Error("Synthetic interruption after inbox attachment");
          },
        );
        const finishParticipant = vi.fn(async () => {
          if (failFinalization) throw new Error("Synthetic email finalization failure");
        });
        const receiving = {
          address: () => "participant@example.test",
          attach,
          finishParticipant,
        } as unknown as CommsReceivingRun;
        const spec = participantRun({
          id: "participant-a",
          index: 0,
          persona: {
            id: "first-time-visitor",
            traitsApplied: [],
            promptDigest: "synthetic-prompt",
          },
          instructions: "Explore the app.",
        });
        const deps: CuaParticipantDeps & { receiving: CommsReceivingRun } = {
          residual: parsed.config,
          labId: parsed.config.id,
          caps: {},
          descriptor: getActor("openai-computer-use"),
          brain: { kind: "openai", model: DEFAULT_OPENAI_CU_MODEL },
          appUrl: "http://127.0.0.1:3000/",
          subject: { kind: "app-url", appUrl: "http://127.0.0.1:3000/", publicTargets: false },
          env: { AGENTMAIL_API_KEY: "synthetic-management-credential-canary" },
          openaiApiKey: "synthetic-openai",
          e2bApiKey: "synthetic-e2b",
          requestTimeoutMs: 60_000,
          sandboxMs: 60_000,
          timeoutMs: 60_000,
          participantCount: 1,
          artifactRoot: await prepareSelectedOutputDirectory(cwd, "artifacts"),
          labCwd: cwd,
          redactScreenshots: true,
          scrubKnownValues: (value) => value,
          receiving,
          runSession: async () => {
            throw new Error("Participant should not start after the injected attachment failure");
          },
          now: Date.now,
          desktopModule: async () => module,
          onStream: async () => undefined,
          reportSubjectPhase: () => undefined,
        };
        const result = await runCuaParticipant(spec, deps);
        expect(attach).toHaveBeenCalledOnce();
        expect(attach.mock.calls[0]?.[0]).toBe("participant-a");
        expect(result.sessionError).toContain("Synthetic interruption after inbox attachment");
        expect(command).toHaveBeenCalled();
        expect(write).toHaveBeenCalled();
        expect(JSON.stringify([created, command.mock.calls, write.mock.calls])).not.toContain(
          "synthetic-management-credential-canary",
        );
        expect(finishParticipant).toHaveBeenCalledOnce();
        expect(kill).toHaveBeenCalledOnce();
        expect(kill.mock.invocationCallOrder[0]).toBeGreaterThan(
          finishParticipant.mock.invocationCallOrder[0]!,
        );
        if (failFinalization)
          expect(result.warnings).toContain(
            "Real email finalization is incomplete. Inspect communication cleanup with humanish comms recover.",
          );
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );
});
