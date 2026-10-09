import { CommanderError } from "commander";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { E2BDesktopModule, E2BDesktopSandbox } from "../../src/substrates/e2b/sdk.js";
import { runStudyPreflight, type StudyPreflightResult } from "../../src/study/preflight.js";
import { createProgram } from "../../src/cli/program.js";
import { inertDesktopInput } from "../helpers/inert-desktop-input.js";
import { lab } from "../admission/fixtures.js";

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
    },
  });

  program.exitOverride();

  try {
    await program.parseAsync(["node", "humanish", ...args], { from: "node" });
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") {
      return { exitCode: 0, stderr: stderr.join(""), stdout: stdout.join("") };
    }
    throw error;
  }

  return {
    exitCode,
    stderr: stderr.join(""),
    stdout: stdout.join(""),
  };
}

describe("lab preflight", () => {
  it("preflights public-preview targets from a sandbox without exposing raw URLs", async () => {
    await withTempLab(
      {
        "humanish/studies/preview.yaml": publicPreviewLab("https://preview.example.test/start"),
      },
      async (cwd) => {
        let created = 0;
        let killed = 0;
        const result = await runStudyPreflight({
          cwd,
          study: "preview",
          reachability: "public-preview",
          env: { E2B_API_KEY: "e2b_test_key_for_preflight" },
          hooks: {
            loadDesktopModule: async () =>
              fakeDesktopModule({
                onCreate: () => {
                  created += 1;
                },
                onKill: () => {
                  killed += 1;
                },
                probeReady: true,
              }),
          },
        });

        expect(result.ok).toBe(true);
        expect(created).toBe(1);
        expect(killed).toBe(1);
        expect(result.spend).toEqual({ e2bDesktop: true, model: false });
        expect(result.sandbox.killed).toBe(true);
        expect(result.targets.every((target) => target.checked && target.reachable)).toBe(true);
        expect(JSON.stringify(result)).not.toContain("preview.example.test");
      },
    );
  });

  it("blocks loopback targets in public-preview mode before launching a sandbox", async () => {
    await withTempLab(
      {
        "humanish/studies/loopback.yaml": publicPreviewLab("http://127.0.0.1:3000/start"),
      },
      async (cwd) => {
        let created = 0;
        const result = await runStudyPreflight({
          cwd,
          study: "loopback",
          reachability: "public-preview",
          env: { E2B_API_KEY: "e2b_test_key_for_preflight" },
          hooks: {
            loadDesktopModule: async () =>
              fakeDesktopModule({
                onCreate: () => {
                  created += 1;
                },
                probeReady: true,
              }),
          },
        });

        expect(result.ok).toBe(false);
        expect(created).toBe(0);
        expect(result.error?.code).toBe("HUMANISH_STUDY_PREFLIGHT_TARGET_POLICY");
        expect(result.targets.some((target) => target.status === "blocked")).toBe(true);
      },
    );
  });

  it("checks participant targets instead of blocking an unused loopback appUrl", async () => {
    await withTempLab(
      {
        "humanish/studies/target-roster.yaml": [
          "schema: humanish.study.v3",
          "id: target-roster",
          "route: computer-use",
          "mode: live",
          "subject:",
          "  source: app-url",
          "  appUrl: http://127.0.0.1:3000/",
          "execution:",
          "  target: e2b-desktop",
          "actor:",
          "  type: openai-computer-use",
          "participants:",
          "  - id: reviewer",
          "    target: https://reviewer-preview.example.test/work",
          "  - id: operator",
          "    target: https://operator-preview.example.test/work",
          "policies:",
          "  allowPublicTargets: true",
        ].join("\n"),
      },
      async (cwd) => {
        let created = 0;
        const result = await runStudyPreflight({
          cwd,
          study: "target-roster",
          reachability: "public-preview",
          env: { E2B_API_KEY: "e2b_test_key_for_preflight" },
          hooks: {
            loadDesktopModule: async () =>
              fakeDesktopModule({
                onCreate: () => {
                  created += 1;
                },
                probeReady: true,
              }),
          },
        });

        expect(result.ok).toBe(true);
        expect(created).toBe(1);
        expect(result.targets.find((target) => target.kind === "subject.appUrl")?.checked).toBe(
          false,
        );
        const participantTargets = result.targets.filter(
          (target) => target.kind === "participants[].target",
        );
        expect(participantTargets.map((target) => target.label)).toEqual([
          "participants[0].target",
          "participants[1].target",
        ]);
        expect(participantTargets.every((target) => target.checked)).toBe(true);
      },
    );
  });

  it("fails public-preview without allowPublicTargets before launching a sandbox", async () => {
    await withTempLab(
      {
        // Written as v3 by hand: the converter refuses a file that does not parse.
        "humanish/studies/no-policy.yaml": [
          "schema: humanish.study.v3",
          "id: no-policy",
          "route: computer-use",
          "mode: live",
          "subject:",
          "  source: app-url",
          "  appUrl: https://preview.example.test/start",
          "execution:",
          "  target: e2b-desktop",
          "actor:",
          "  type: openai-computer-use",
        ].join("\n"),
      },
      async (cwd) => {
        const result = await runStudyPreflight({
          cwd,
          study: "no-policy",
          reachability: "public-preview",
        });

        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe("HUMANISH_STUDY_INVALID");
        expect(result.sandbox.created).toBe(false);
      },
    );
  });

  it("supports metadata-only CLI preflight with clean JSON", async () => {
    await withTempLab(
      {
        "humanish/studies/first-run.yaml": [
          "schema: humanish.study.v3",
          "id: first-run",
          "route: preview",
          "mode: dry-run",
          "subject:",
          "  source: this-repo",
          "actor:",
          "  type: synthetic-persona",
        ].join("\n"),
      },
      async (cwd) => {
        const result = await runCli(["study", "check", "first-run", "--cwd", cwd, "--json"]);
        const envelope = JSON.parse(result.stdout) as StudyPreflightResult;

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(envelope.ok).toBe(true);
        expect(envelope.reachability).toBe("metadata");
        expect(envelope.route).toBe("preview");
        expect(envelope).not.toHaveProperty("backend");
        expect(envelope.spend).toEqual({ e2bDesktop: false, model: false });
        expect(envelope.checks.some((check) => check.name === "reachability")).toBe(true);
      },
    );
  });
});

// A clone study whose 60-minute session plus 40 minutes of provisioning and teardown headroom asks
// E2B for a 100-minute sandbox, past the 60 minutes allowed when the setting is unset.
const LONG_CLONE_STUDY = [
  "schema: humanish.study.v3",
  "id: long-clone",
  "route: computer-use",
  "mode: dry-run",
  "subject:",
  "  source: clone",
  "  repos:",
  "    - example-org/example-app",
  "  serve:",
  "    start: python3 -m http.server 3000",
  "    url: http://127.0.0.1:3000/",
  "actor:",
  "  type: openai-computer-use",
  "  mission: Explore and stop.",
  "execution:",
  "  target: e2b-desktop",
  "  timeoutMs: 3600000",
  "review:",
  "  analysis: false",
].join("\n");

describe("study check and the planner", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses a study humanish run refuses at plan time, with the run's code and message", async () => {
    await withTempLab({ "humanish/studies/long-clone.yaml": LONG_CLONE_STUDY }, async (cwd) => {
      const checked = await runCli(["study", "check", "long-clone", "--cwd", cwd, "--json"]);
      const run = await runCli(["run", "long-clone", "--cwd", cwd, "--json"]);
      const check = JSON.parse(checked.stdout) as StudyPreflightResult;
      const refused = JSON.parse(run.stdout) as { error?: { code: string; message: string } };

      expect(run.exitCode).toBe(2);
      expect(refused.error?.code).toBe("HUMANISH_COMPUTER_USE_SUBJECT_INVALID");
      expect(checked.exitCode).toBe(2);
      expect(check.ok).toBe(false);
      expect(check.error).toEqual(refused.error);
      expect(check.checks.find((row) => row.name === "plan")).toMatchObject({ ok: false });
      expect(check.error?.message).toMatch(
        /a 100m sandbox deadline, .* set HUMANISH_E2B_MAX_SANDBOX_MINUTES to 100 or more\.$/,
      );
    });
  });

  it.each([
    // Each participant's own sandbox: 55m + 10m of teardown buffer.
    { plane: "external-public", base: "sharedExternal", sessionMinutes: 55 },
    // The subject sandbox outlives every participant: 20m + 30m to provision + 5m for the one seed
    // step + 10m of teardown buffer.
    { plane: "provisioned", base: "sharedProvisioned", sessionMinutes: 20 },
  ] as const)(
    "refuses a shared-world study on the $plane plane whose 65m sandbox deadline passes the ceiling",
    async ({ base, sessionMinutes }) => {
      const study = lab(base, {
        id: "long-shared",
        execution: { timeoutMs: sessionMinutes * 60_000 },
      });
      // A JSON document is a YAML document.
      await withTempLab(
        { "humanish/studies/long-shared.yaml": JSON.stringify(study) },
        async (cwd) => {
          const run = await runCli(["run", "long-shared", "--cwd", cwd, "--json"]);
          const checked = await runCli(["study", "check", "long-shared", "--cwd", cwd, "--json"]);
          const refused = JSON.parse(run.stdout) as { error?: { code: string; message: string } };

          expect(run.exitCode).toBe(2);
          expect(refused.error?.code).toBe("HUMANISH_SHARED_WORLD_INVALID");
          expect(refused.error?.message).toMatch(
            /a 65m .*deadline.* may not live longer than 60m\. .* set HUMANISH_E2B_MAX_SANDBOX_MINUTES to 65 or more\.$/,
          );
          expect(checked.exitCode).toBe(2);
          expect((JSON.parse(checked.stdout) as StudyPreflightResult).error).toEqual(refused.error);

          vi.stubEnv("HUMANISH_E2B_MAX_SANDBOX_MINUTES", "65");
          expect(
            (await runCli(["study", "check", "long-shared", "--cwd", cwd, "--json"])).exitCode,
          ).toBe(0);
        },
      );
    },
  );

  it("passes the same study once the sandbox ceiling admits it", async () => {
    vi.stubEnv("HUMANISH_E2B_MAX_SANDBOX_MINUTES", "100");
    await withTempLab({ "humanish/studies/long-clone.yaml": LONG_CLONE_STUDY }, async (cwd) => {
      const checked = await runCli(["study", "check", "long-clone", "--cwd", cwd, "--json"]);
      const check = JSON.parse(checked.stdout) as StudyPreflightResult;

      expect(checked.exitCode).toBe(0);
      expect(check.ok).toBe(true);
      expect(check.checks.every((row) => row.ok)).toBe(true);
    });
  });
});

function publicPreviewLab(target: string): string {
  return [
    "schema: humanish.study.v3",
    "id: preview",
    "route: computer-use",
    "mode: live",
    "subject:",
    "  source: app-url",
    `  appUrl: ${target}`,
    "execution:",
    "  target: e2b-desktop",
    "actor:",
    "  type: openai-computer-use",
    "policies:",
    "  allowPublicTargets: true",
  ].join("\n");
}

function fakeDesktopModule(args: {
  onCreate?: () => void;
  onKill?: () => void;
  probeReady: boolean;
}): E2BDesktopModule {
  const sandbox: E2BDesktopSandbox = {
    sandboxId: "fake-sandbox_preflight_fixture",
    ...inertDesktopInput(),
    commands: {
      run: async (command: string) => {
        if (command.includes("curl")) {
          return { stdout: args.probeReady ? "READY\n" : "WAIT\n" };
        }
        return { stdout: "" };
      },
    },
    files: {
      write: async () => undefined,
    },
    launch: async () => undefined,
    screenshot: async () => new Uint8Array(),
    wait: async () => undefined,
    stream: {
      getAuthKey: () => "stream_auth_key",
      getUrl: () => "https://stream.example.test",
      start: async () => undefined,
    },
  };

  return {
    Sandbox: {
      create: async () => {
        args.onCreate?.();
        return sandbox;
      },
      kill: async () => {
        args.onKill?.();
        return true;
      },
    },
  };
}

async function withTempLab<T>(
  files: Record<string, string>,
  callback: (cwd: string) => Promise<T>,
): Promise<T> {
  const cwd = await mkdtemp(path.join(tmpdir(), "humanish-lab-preflight-"));
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
