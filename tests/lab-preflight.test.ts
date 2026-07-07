import { CommanderError } from "commander";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { E2BDesktopModule, E2BDesktopSandbox } from "../src/e2b-desktop-launch.js";
import { runLabPreflight, type LabPreflightResult } from "../src/lab-preflight.js";
import { createProgram } from "../src/program.js";

interface CliResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

async function runCli(args: string[]): Promise<CliResult> {
  let exitCode = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: (text) => stderr.push(text),
    setExitCode: (code) => {
      exitCode = code;
    }
  });

  program.exitOverride();

  try {
    await program.parseAsync(["node", "homun", ...args], { from: "node" });
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") {
      return { exitCode: 0, stderr: stderr.join(""), stdout: stdout.join("") };
    }
    throw error;
  }

  return {
    exitCode,
    stderr: stderr.join(""),
    stdout: stdout.join("")
  };
}

describe("lab preflight", () => {
  it("preflights public-preview targets from a sandbox without exposing raw URLs", async () => {
    await withTempLab({
      "homun/labs/preview.yaml": publicPreviewLab("https://preview.example.test/start")
    }, async (cwd) => {
      let created = 0;
      let killed = 0;
      const result = await runLabPreflight({
        cwd,
        lab: "preview",
        reachability: "public-preview",
        env: { E2B_API_KEY: "e2b_test_key_for_preflight" },
        hooks: {
          loadDesktopModule: async () => fakeDesktopModule({
            onCreate: () => {
              created += 1;
            },
            onKill: () => {
              killed += 1;
            },
            probeReady: true
          })
        }
      });

      expect(result.ok).toBe(true);
      expect(created).toBe(1);
      expect(killed).toBe(1);
      expect(result.spend).toEqual({ e2bDesktop: true, model: false });
      expect(result.sandbox.killed).toBe(true);
      expect(result.targets.every((target) => target.checked && target.reachable)).toBe(true);
      expect(JSON.stringify(result)).not.toContain("preview.example.test");
    });
  });

  it("blocks loopback targets in public-preview mode before launching a sandbox", async () => {
    await withTempLab({
      "homun/labs/loopback.yaml": publicPreviewLab("http://127.0.0.1:3000/start")
    }, async (cwd) => {
      let created = 0;
      const result = await runLabPreflight({
        cwd,
        lab: "loopback",
        reachability: "public-preview",
        env: { E2B_API_KEY: "e2b_test_key_for_preflight" },
        hooks: {
          loadDesktopModule: async () => fakeDesktopModule({
            onCreate: () => {
              created += 1;
            },
            probeReady: true
          })
        }
      });

      expect(result.ok).toBe(false);
      expect(created).toBe(0);
      expect(result.error?.code).toBe("HOMUN_LAB_PREFLIGHT_TARGET_POLICY");
      expect(result.targets.some((target) => target.status === "blocked")).toBe(true);
    });
  });

  it("checks lane targets instead of blocking an unused loopback appUrl", async () => {
    await withTempLab({
      "homun/labs/target-roster.yaml": [
        "schema: homun.lab.v2",
        "id: target-roster",
        "subject:",
        "  source: app-url",
        "  appUrl: http://127.0.0.1:3000/",
        "execution:",
        "  target: e2b-desktop",
        "actors:",
        "  - type: openai-computer-use",
        "    lanes:",
        "      - id: reviewer",
        "        target: https://reviewer-preview.example.test/work",
        "      - id: operator",
        "        target: https://operator-preview.example.test/work",
        "scenario:",
        "  mode: live",
        "policies:",
        "  allowPublicTargets: true"
      ].join("\n")
    }, async (cwd) => {
      let created = 0;
      const result = await runLabPreflight({
        cwd,
        lab: "target-roster",
        reachability: "public-preview",
        env: { E2B_API_KEY: "e2b_test_key_for_preflight" },
        hooks: {
          loadDesktopModule: async () => fakeDesktopModule({
            onCreate: () => {
              created += 1;
            },
            probeReady: true
          })
        }
      });

      expect(result.ok).toBe(true);
      expect(created).toBe(1);
      expect(result.targets.find((target) => target.kind === "subject.appUrl")?.checked).toBe(false);
      expect(result.targets.filter((target) => target.kind === "actors[0].lanes[].target").every((target) => target.checked)).toBe(true);
    });
  });

  it("fails public-preview without allowPublicTargets before launching a sandbox", async () => {
    await withTempLab({
      "homun/labs/no-policy.yaml": [
        "schema: homun.lab.v2",
        "id: no-policy",
        "subject:",
        "  source: app-url",
        "  appUrl: https://preview.example.test/start",
        "execution:",
        "  target: e2b-desktop",
        "actors:",
        "  - type: openai-computer-use",
        "scenario:",
        "  mode: live"
      ].join("\n")
    }, async (cwd) => {
      const result = await runLabPreflight({ cwd, lab: "no-policy", reachability: "public-preview" });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("HOMUN_LAB_INVALID");
      expect(result.sandbox.created).toBe(false);
    });
  });

  it("supports metadata-only CLI preflight with clean JSON", async () => {
    await withTempLab({
      "homun/labs/first-run.yaml": [
        "schema: homun.lab.v2",
        "id: first-run",
        "subject:",
        "  source: this-repo",
        "actors:",
        "  - type: synthetic-persona",
        "scenario:",
        "  mode: dry-run"
      ].join("\n")
    }, async (cwd) => {
      const result = await runCli(["lab", "preflight", "first-run", "--cwd", cwd, "--json"]);
      const envelope = JSON.parse(result.stdout) as LabPreflightResult;

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(envelope.ok).toBe(true);
      expect(envelope.reachability).toBe("metadata");
      expect(envelope.spend).toEqual({ e2bDesktop: false, model: false });
      expect(envelope.checks.some((check) => check.name === "reachability")).toBe(true);
    });
  });
});

function publicPreviewLab(target: string): string {
  return [
    "schema: homun.lab.v2",
    "id: preview",
    "subject:",
    "  source: app-url",
    `  appUrl: ${target}`,
    "execution:",
    "  target: e2b-desktop",
    "actors:",
    "  - type: openai-computer-use",
    "scenario:",
    "  mode: live",
    "policies:",
    "  allowPublicTargets: true"
  ].join("\n");
}

function fakeDesktopModule(args: {
  onCreate?: () => void;
  onKill?: () => void;
  probeReady: boolean;
}): E2BDesktopModule {
  const sandbox: E2BDesktopSandbox = {
    sandboxId: "sandbox_preflight_fixture",
    commands: {
      run: async (command: string) => {
        if (command.includes("curl")) {
          return { stdout: args.probeReady ? "READY\n" : "WAIT\n" };
        }
        return { stdout: "" };
      }
    },
    files: {
      write: async () => undefined
    },
    launch: async () => undefined,
    screenshot: async () => new Uint8Array(),
    wait: async () => undefined,
    stream: {
      getAuthKey: () => "stream_auth_key",
      getUrl: () => "https://stream.example.test",
      start: async () => undefined
    }
  };

  return {
    Sandbox: {
      create: async () => {
        args.onCreate?.();
        return sandbox;
      },
      kill: async () => {
        args.onKill?.();
        return undefined;
      }
    }
  };
}

async function withTempLab<T>(files: Record<string, string>, callback: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(path.join(tmpdir(), "homun-lab-preflight-"));
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const filePath = path.join(cwd, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${contents}\n`, "utf8");
    }
    return await callback(cwd);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
}
