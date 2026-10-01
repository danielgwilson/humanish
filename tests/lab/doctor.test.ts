import { createServer } from "node:http";
import { labSetupChecks } from "../../src/lab/doctor.js";
import { defaultCodexCliVersion } from "../../src/actors/codex/qualified-versions.js";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { doctor } from "../../src/cli/doctor.js";
import type { DetectLocalAgentsOptions } from "../../src/actors/local-agent/cli.js";
import { runLabPreflight } from "../../src/lab/preflight.js";
import { resolveLabManifest } from "../../src/lab/discover.js";
import { runLab } from "../../src/run-lab.js";

const noAgents: DetectLocalAgentsOptions = { which: async () => undefined };
const keyless = { HUMANISH_STRICT_KEYS: "1", PATH: "" };
const lab = (actor = "openai-computer-use", mode = "live") =>
  [
    "schema: humanish.lab.v2",
    "id: preview",
    "subject:",
    "  source: app-url",
    "  appUrl: https://preview.example.test/",
    "actors:",
    `  - type: ${actor}`,
    ...(actor === "local-agent" ? ["    localAgent: codex"] : []),
    "execution:",
    "  target: e2b-desktop",
    "scenario:",
    `  mode: ${mode}`,
    "policies:",
    "  allowPublicTargets: true",
  ].join("\n");

async function project<T>(manifest: string, run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(path.join(tmpdir(), "humanish-doctor-lab-"));
  try {
    await mkdir(path.join(cwd, "humanish/labs"), { recursive: true });
    await writeFile(path.join(cwd, "package.json"), "{}");
    await writeFile(path.join(cwd, ".gitignore"), ".humanish/\n");
    await writeFile(path.join(cwd, "humanish/labs/preview.yaml"), manifest);
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("selected lab setup without paid dispatch", () => {
  it("checks a local catch before participants and explains unavailable recipient routes", async () => {
    let compatible = true;
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          service: "humanish-comms-catch",
          capabilities: compatible ? ["recipient-inbox-v1"] : [],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const manifest =
        lab("local-agent")
          .replace("https://preview.example.test/", "http://localhost:3000/")
          .replace("target: e2b-desktop", "target: local") +
        `\nreview:\n  analysis: false\ncomms:\n  email:\n    external:\n      catchBaseUrl: ${url}\n`;
      await project(manifest, async (cwd) => {
        for (const ready of [true, false]) {
          compatible = ready;
          const result = await labSetupChecks({
            cwd,
            lab: "preview",
            env: keyless,
            agents: [],
            keyPresent: () => false,
            localRuntimeReadiness: async () => ({ ok: true, installed: true, message: "Ready" }),
            codexAnalysisReadiness: async () => ({ ready: true, errorCode: null }),
          });
          const check = result.checks.find((item) => item.name === "local captured inbox")!;
          expect(check.ok).toBe(ready);
          expect(check.message).toContain(
            ready ? "does not receive arbitrary internet mail" : "restart humanish comms catch",
          );
          expect(result.keys).toEqual([]);
        }
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("checks the qualified local participant even when analysis is disabled", async () => {
    const manifest =
      lab("local-agent")
        .replace("https://preview.example.test/", "http://localhost:3000/")
        .replace("target: e2b-desktop", "target: local") + "\nreview:\n  analysis: false\n";
    await project(manifest, async (cwd) => {
      const result = await labSetupChecks({
        cwd,
        lab: "preview",
        env: keyless,
        agents: [],
        keyPresent: () => false,
        localRuntimeReadiness: async () => ({
          ok: true,
          installed: false,
          message: "Runtime will download",
        }),
        codexAnalysisReadiness: async () => ({ ready: false, errorCode: "codex_login_required" }),
      });
      expect(result.keys).toEqual([]);
      expect(
        result.checks.find((item) => item.name === "local participant authentication"),
      ).toMatchObject({ ok: false });
      expect(result.checks.some((item) => item.name === "post-run analysis")).toBe(false);
    });
  });
  it("names the found Codex release and the pinned install command when it is not admitted", async () => {
    const manifest =
      lab("local-agent")
        .replace("https://preview.example.test/", "http://localhost:3000/")
        .replace("target: e2b-desktop", "target: local") +
      "\nreview:\n  analysis:\n    provider: codex\n";
    const install = `npm install -g @openai/codex@${defaultCodexCliVersion()}`;
    await project(manifest, async (cwd) => {
      const result = await labSetupChecks({
        cwd,
        lab: "preview",
        env: keyless,
        agents: [],
        keyPresent: () => false,
        localRuntimeReadiness: async () => ({ ok: true, installed: true, message: "Ready" }),
        codexAnalysisReadiness: async () => ({
          ready: false,
          errorCode: "codex_unsupported_version",
          detectedCliVersion: "0.150.0",
        }),
      });
      for (const name of ["local participant authentication", "post-run analysis"]) {
        const check = result.checks.find((item) => item.name === name)!;
        expect(check.ok, name).toBe(false);
        expect(check.message, name).toContain("Found Codex CLI 0.150.0");
        expect(check.message, name).toContain(install);
      }
    });
    const launcher = await import("../../src/analysis/restricted-codex.js");
    const session = await import("../../src/actors/codex/restricted-session.js");
    const readiness = vi
      .spyOn(launcher, "checkRestrictedCodexAnalysisReadiness")
      .mockResolvedValue({ ready: false, errorCode: "codex_unsupported_version" });
    const detect = vi.spyOn(session, "detectRestrictedCodexCliVersion").mockResolvedValue({
      cliVersion: null,
      errorCode: "codex_unsupported_version",
      detectedVersion: "0.150.0",
    });
    try {
      await project(manifest, async (cwd) => {
        const result = await labSetupChecks({
          cwd,
          lab: "preview",
          env: keyless,
          agents: [],
          keyPresent: () => false,
          localRuntimeReadiness: async () => ({ ok: true, installed: true, message: "Ready" }),
        });
        expect(detect).toHaveBeenCalledExactlyOnceWith({ timeoutMs: 5000 }, { env: keyless });
        expect(result.checks.find((item) => item.name === "post-run analysis")?.message).toContain(
          "Found Codex CLI 0.150.0",
        );
      });
    } finally {
      readiness.mockRestore();
      detect.mockRestore();
    }
  });

  it("uses the doctor's selected environment for the restricted account readiness check", async () => {
    const launcher = await import("../../src/analysis/restricted-codex.js");
    const readiness = vi
      .spyOn(launcher, "checkRestrictedCodexAnalysisReadiness")
      .mockResolvedValue({ ready: false, errorCode: "codex_login_required" });
    try {
      await project(
        lab("local-agent") + "\nreview:\n  analysis:\n    provider: codex\n",
        async (cwd) => {
          const env = {
            PATH: "/synthetic/cli",
            CODEX_HOME: "/synthetic/account",
            OPENAI_API_KEY: "synthetic-unused-key",
          };
          const result = await labSetupChecks({
            cwd,
            lab: "preview",
            env,
            agents: [],
            keyPresent: () => false,
          });
          expect(readiness).toHaveBeenCalledExactlyOnceWith({ timeoutMs: 5000 }, { env });
          expect(JSON.stringify(result)).not.toMatch(
            /synthetic\/(?:cli|account)|synthetic-unused-key/,
          );
        },
      );
    } finally {
      readiness.mockRestore();
    }
  });

  it("checks the qualified account analyst separately from participant API credentials", async () => {
    await project(
      lab("local-agent") + "\nreview:\n  analysis:\n    provider: codex\n",
      async (cwd) => {
        for (const ready of [true, false]) {
          const result = await labSetupChecks({
            cwd,
            lab: "preview",
            env: keyless,
            agents: [],
            keyPresent: () => false,
            codexAnalysisReadiness: async () => ({
              ready,
              errorCode: ready ? null : "codex_login_required",
            }),
          });
          const check = result.checks.find((item) => item.name === "post-run analysis")!;
          expect(check.ok).toBe(ready);
          expect(check.message).not.toContain("OPENAI_API_KEY");
          expect(result.keys).not.toContain("OPENAI_API_KEY");
          expect(check.message).toContain(
            ready ? "account allowance remain untested" : "No API fallback",
          );
          const scope = result.checks.find((item) => item.name === "check scope")!.message;
          expect(scope).toContain("without a model turn or participant resources");
          expect(scope).toContain("CLI startup may use the network");
          expect(scope).toContain(
            "Remote account validity, model access, quota and target reachability remain untested",
          );
        }
      },
    );
  });

  it.each([
    [
      "codex_unsupported_platform",
      "Use Linux x64 or the Apple Silicon Mac",
      "explicitly select provider: openai with an API key",
    ],
    ["codex_busy", "active in this process", "Wait for it to finish, then retry"],
  ])("gives actionable recovery for %s", async (errorCode, reason, recovery) => {
    await project(
      lab("local-agent") + "\nreview:\n  analysis:\n    provider: codex\n",
      async (cwd) => {
        const result = await labSetupChecks({
          cwd,
          lab: "preview",
          env: keyless,
          agents: [],
          keyPresent: () => false,
          codexAnalysisReadiness: async () => ({ ready: false, errorCode }),
        });
        const check = result.checks.find((item) => item.name === "post-run analysis")!;
        expect(check.ok).toBe(false);
        expect(check.message).toContain(reason);
        expect(check.message).toContain(recovery);
        expect(check.message).not.toContain("Install the qualified CLI");
        expect(check.message).toContain("No API fallback");
      },
    );
  });

  it("permits a keyless dry-run but identifies the missing live API credentials", async () => {
    await project(lab("openai-computer-use", "dry-run"), async (cwd) => {
      expect((await doctor(cwd, { lab: "preview", env: keyless, localAgents: noAgents })).ok).toBe(
        true,
      );
    });
    await project(lab(), async (cwd) => {
      const result = await doctor(cwd, { lab: "preview", env: keyless, localAgents: noAgents });
      expect(result.ok).toBe(false);
      expect(result.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual([
        "key OPENAI_API_KEY",
        "key E2B_API_KEY",
      ]);
      expect(result.checks.find((check) => check.name === "post-run analysis")?.message).toContain(
        "Will be skipped",
      );
    });
  });

  it("does not require an API key for an authenticated local participant, and explicitly skips analysis", async () => {
    await project(lab("local-agent"), async (cwd) => {
      const result = await doctor(cwd, {
        lab: "preview",
        env: { ...keyless, E2B_API_KEY: "synthetic-desktop-marker" },
        localAgents: {
          which: async (bin) => (bin === "codex" ? "/synthetic/codex" : undefined),
          exists: async () => false,
          authProbe: async () => ({
            code: 0,
            stdout: "",
            stderr: "Logged in using ChatGPT\nprivate-account-marker",
          }),
        },
      });
      expect(result.ok).toBe(true);
      expect(
        result.checks.find((check) => check.name === "local participant authentication")?.ok,
      ).toBe(true);
      expect(result.checks.find((check) => check.name === "post-run analysis")?.message).toContain(
        "no automatic findings report",
      );
      expect(JSON.stringify(result)).not.toMatch(/synthetic-desktop-marker|private-account-marker/);
    });
  });

  it("refuses installed but uncheckable authentication without pretending it is signed out", async () => {
    await project(lab("local-agent"), async (cwd) => {
      const result = await doctor(cwd, {
        lab: "preview",
        env: { ...keyless, E2B_API_KEY: "synthetic-desktop-marker" },
        localAgents: {
          which: async (bin) => (bin === "codex" ? "/synthetic/codex" : undefined),
          exists: async () => true,
          authProbe: async () => ({ code: null, stdout: "", stderr: "private-account-marker" }),
        },
      });
      expect(result.ok).toBe(false);
      const check = result.checks.find(
        (check) => check.name === "local participant authentication",
      );
      expect(check?.message).toContain("could not be checked");
      expect(check?.message).not.toContain("not signed in");
      expect(JSON.stringify(result)).not.toContain("private-account-marker");
    });
  });

  it("calls keys present without claiming remote validity", async () => {
    await project(lab(), async (cwd) => {
      const result = await doctor(cwd, {
        lab: "preview",
        env: {
          ...keyless,
          OPENAI_API_KEY: "synthetic-invalid-model",
          E2B_API_KEY: "synthetic-invalid-desktop",
        },
        localAgents: noAgents,
      });
      expect(result.ok).toBe(true);
      expect(result.checks.find((check) => check.name === "key OPENAI_API_KEY")?.message).toContain(
        "validity not tested",
      );
      expect(result.checks.find((check) => check.name === "check scope")?.message).toContain(
        "no paid resources",
      );
      expect(JSON.stringify(result)).not.toMatch(/synthetic-invalid/);
    });
  });

  it("does not claim the library-only local-app route can run through the CLI", async () => {
    await project(
      lab()
        .replace("source: app-url", "source: local-app")
        .replace("https://preview.example.test/", "http://127.0.0.1:3000/")
        .replace("target: e2b-desktop", "target: local")
        .replace("policies:\n  allowPublicTargets: true", ""),
      async (cwd) => {
        const result = await doctor(cwd, { lab: "preview", env: keyless, localAgents: noAgents });
        expect(result.ok).toBe(false);
        expect(result.checks.find((check) => check.name === "live route")?.message).toContain(
          "caller-supplied executor",
        );
      },
    );
  });

  it("separates successful metadata parsing from unverified setup", async () => {
    await project(lab(), async (cwd) => {
      const result = await runLabPreflight({ cwd, lab: "preview", env: keyless });
      expect(result.ok).toBe(true);
      expect(result.checks.find((check) => check.name === "reachability")?.message).toContain(
        "Credentials, local login, dependencies and target reachability were not checked",
      );
      expect(result.spend).toEqual({ e2bDesktop: false, model: false });
    });
  });

  it("refuses stale or unknown local login before touching the desktop provider", async () => {
    await project(lab("local-agent"), async (cwd) => {
      const resolved = await resolveLabManifest(cwd, "preview");
      if (!resolved.ok) throw new Error(resolved.error.message);
      const bin = path.join(cwd, "bin");
      await mkdir(bin);
      const command = path.join(bin, "codex");
      for (const [status, message] of [
        ["Not logged in", "reports not signed in"],
        ["unknown private-account-marker", "could not be checked"],
      ]) {
        await writeFile(
          command,
          `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(status)}); process.exit(1);\n`,
        );
        await chmod(command, 0o700);
        let desktopLoads = 0;
        const outcome = await runLab(resolved.config, {
          cwd,
          env: { ...keyless, PATH: bin, E2B_API_KEY: "synthetic-desktop-marker" },
          cuaHooks: {
            loadDesktopModule: async () => {
              desktopLoads++;
              throw new Error("Must not reach desktop provider");
            },
          },
        });
        if (outcome.backend !== "cua") throw new Error("Expected CUA route");
        expect(outcome.result.error?.message).toContain(message);
        expect(outcome.result.runId).toBe("not-created");
        expect(desktopLoads).toBe(0);
        expect(JSON.stringify(outcome)).not.toContain("private-account-marker");
      }
    });
  });
});
