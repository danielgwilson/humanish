import { createServer } from "node:http";
import { studySetupChecks } from "../../src/study/doctor.js";
import { defaultCodexCliVersion } from "../../src/actors/codex/codex-admission.js";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { doctor } from "../../src/cli/doctor.js";
import type { DetectLocalAgentsOptions } from "../../src/actors/local-agent/cli.js";
import { runStudyPreflight } from "../../src/study/preflight.js";
import { resolveStudyManifest } from "../../src/study/discover.js";
import { runStudyWith } from "../../src/run-study.js";
import { stringify } from "yaml";
import type { DetectedLocalAgent } from "../../src/actors/local-agent/cli.js";
import { lab as admissionLab } from "../admission/fixtures.js";
import { studyFileText } from "../helpers/study-file.js";

const noAgents: DetectLocalAgentsOptions = { which: async () => undefined };
// What a hosted Codex participant's operator handshake reports when it passes.
const hostedReady = {
  ready: true,
  errorCode: null,
  cliVersion: "0.160.0",
  resolvedModel: "synthetic-operator-model",
  authentication: "chatgpt-account" as const,
};
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
    await mkdir(path.join(cwd, "humanish/studies"), { recursive: true });
    await writeFile(path.join(cwd, "package.json"), "{}");
    await writeFile(path.join(cwd, ".gitignore"), ".humanish/\n");
    await writeFile(path.join(cwd, "humanish/studies/preview.yaml"), studyFileText(manifest, cwd));
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
          const result = await studySetupChecks({
            cwd,
            study: "preview",
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
      const result = await studySetupChecks({
        cwd,
        study: "preview",
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
      const result = await studySetupChecks({
        cwd,
        study: "preview",
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
        const result = await studySetupChecks({
          cwd,
          study: "preview",
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

  it("names each protocol change when a Codex release fails the schema check", async () => {
    const manifest =
      lab("local-agent")
        .replace("https://preview.example.test/", "http://localhost:3000/")
        .replace("target: e2b-desktop", "target: local") +
      "\nreview:\n  analysis:\n    provider: codex\n";
    await project(manifest, async (cwd) => {
      const result = await studySetupChecks({
        cwd,
        study: "preview",
        env: keyless,
        agents: [],
        keyPresent: () => false,
        localRuntimeReadiness: async () => ({ ok: true, installed: true, message: "Ready" }),
        codexAnalysisReadiness: async () => ({
          ready: false,
          errorCode: "codex_incompatible_release",
          detectedCliVersion: "0.160.0",
          protocolIncompatibilities: ["turn/start response turn.id is no longer in the schema"],
        }),
      });
      for (const name of ["local participant authentication", "post-run analysis"]) {
        const check = result.checks.find((item) => item.name === name)!;
        expect(check.ok, name).toBe(false);
        expect(check.message, name).toContain(
          `Codex CLI 0.160.0 changed the app-server protocol humanish uses: turn/start response turn.id is no longer in the schema. Install the last tested release with \`npm install -g @openai/codex@${defaultCodexCliVersion()}\`. Then sign in with a ChatGPT account (\`codex login\`).`,
        );
      }
    });
  });

  const localCodexLab =
    lab("local-agent")
      .replace("https://preview.example.test/", "http://localhost:3000/")
      .replace("target: e2b-desktop", "target: local") +
    "\nreview:\n  analysis:\n    provider: codex\n";
  const install = `npm install -g @openai/codex@${defaultCodexCliVersion()}`;
  const notCodex = "it is neither a native Codex executable nor the @openai/codex npm launcher";

  it.each([
    ["codex_login_required", undefined, ["Run `codex login`"], ["Install"]],
    ["codex_unsupported_auth", undefined, ["`codex logout`", "`codex login`"], ["Install"]],
    [
      "codex_unavailable",
      { path: "/opt/tools/codex", reason: notCodex },
      ["humanish found `/opt/tools/codex` and cannot run it", notCodex, install],
      [],
    ],
    [
      "codex_unavailable",
      { reason: "no executable `codex` is on PATH" },
      ["no executable `codex` is on PATH", install],
      [],
    ],
  ] as const)(
    "gives %s its own recovery on both Codex rows",
    async (errorCode, refusedExecutable, says, omits) => {
      await project(localCodexLab, async (cwd) => {
        const result = await studySetupChecks({
          cwd,
          study: "preview",
          env: keyless,
          agents: [],
          keyPresent: () => false,
          localRuntimeReadiness: async () => ({ ok: true, installed: true, message: "Ready" }),
          codexAnalysisReadiness: async () => ({
            ready: false,
            errorCode,
            ...(refusedExecutable === undefined ? {} : { refusedExecutable }),
          }),
        });
        for (const name of ["local participant authentication", "post-run analysis"]) {
          const message = result.checks.find((item) => item.name === name)!.message;
          for (const text of says) expect(message, name).toContain(text);
          for (const text of omits) expect(message, name).not.toContain(text);
        }
      });
    },
  );

  it("names the codex file on `PATH` it turned down when Codex is unavailable", async () => {
    const bin = await mkdtemp(path.join(tmpdir(), "humanish-doctor-codex-wrapper-"));
    await writeFile(path.join(bin, "codex"), '#!/bin/sh\nexec real-codex "$@"\n', {
      mode: 0o755,
    });
    const launcher = await import("../../src/analysis/restricted-codex.js");
    const readiness = vi
      .spyOn(launcher, "checkRestrictedCodexAnalysisReadiness")
      .mockResolvedValue({ ready: false, errorCode: "codex_unavailable" });
    try {
      await project(localCodexLab, async (cwd) => {
        const result = await studySetupChecks({
          cwd,
          study: "preview",
          env: { ...keyless, PATH: bin },
          agents: [],
          keyPresent: () => false,
          localRuntimeReadiness: async () => ({ ok: true, installed: true, message: "Ready" }),
        });
        const message = result.checks.find(
          (item) => item.name === "local participant authentication",
        )!.message;
        expect(message).toContain(`\`${path.join(bin, "codex")}\``);
        expect(message).toContain(notCodex);
        // Neither in a project nor npm's global prefix: whatever installed it replaces it.
        expect(message).toContain("Update it with the tool that installed it");
        expect(message).not.toContain("npm install -g");
      });
    } finally {
      readiness.mockRestore();
      await rm(bin, { recursive: true, force: true });
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
          const result = await studySetupChecks({
            cwd,
            study: "preview",
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
          const result = await studySetupChecks({
            cwd,
            study: "preview",
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
        const result = await studySetupChecks({
          cwd,
          study: "preview",
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
      expect(
        (await doctor(cwd, { study: "preview", env: keyless, localAgents: noAgents })).ok,
      ).toBe(true);
    });
    await project(lab(), async (cwd) => {
      const result = await doctor(cwd, { study: "preview", env: keyless, localAgents: noAgents });
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
        study: "preview",
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
        codexParticipantReadiness: async () => hostedReady,
      });
      expect(result.ok).toBe(true);
      expect(
        result.checks.find((check) => check.name === "local participant authentication")?.ok,
      ).toBe(true);
      expect(result.checks.find((check) => check.name === "post-run analysis")).toMatchObject({
        ok: true,
        status: "note",
        message: expect.stringContaining("no automatic findings report"),
      });
      expect(JSON.stringify(result)).not.toMatch(/synthetic-desktop-marker|private-account-marker/);
    });
  });

  it("refuses installed but uncheckable authentication without pretending it is signed out", async () => {
    await project(lab("local-agent"), async (cwd) => {
      const result = await doctor(cwd, {
        study: "preview",
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
        study: "preview",
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

  it.each([
    ["without a scorer", "", "present (process env), not used by this study"],
    [
      "with a declared scorer, whose code may read any key",
      "\nreview:\n  scorer:\n    ref: humanish/scorers/judge.mjs\n",
      "supplied by process env; presence only, validity not tested",
    ],
  ])("says when a present key is one the lab does not read, %s", async (_name, extra, codexRow) => {
    await project(lab("local-agent") + extra, async (cwd) => {
      const result = await doctor(cwd, {
        study: "preview",
        env: {
          ...keyless,
          OPENAI_API_KEY: "synthetic-model",
          E2B_API_KEY: "synthetic-desktop",
          CODEX_API_KEY: "synthetic-codex",
        },
        localAgents: noAgents,
      });
      const message = (name: string) =>
        result.checks.find((check) => check.name === `key ${name}`)?.message;
      expect(message("CODEX_API_KEY")).toBe(codexRow);
      // E2B_API_KEY is required, and the default automatic analysis reads OPENAI_API_KEY.
      expect(message("E2B_API_KEY")).toContain("supplied by process env");
      expect(message("OPENAI_API_KEY")).toContain("supplied by process env");
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
        const result = await doctor(cwd, { study: "preview", env: keyless, localAgents: noAgents });
        expect(result.ok).toBe(false);
        expect(result.checks.find((check) => check.name === "live route")?.message).toContain(
          "caller-supplied executor",
        );
      },
    );
  });

  it("separates successful metadata parsing from unverified setup", async () => {
    await project(lab(), async (cwd) => {
      const result = await runStudyPreflight({ cwd, study: "preview", env: keyless });
      expect(result.ok).toBe(true);
      expect(result.checks.find((check) => check.name === "reachability")?.message).toContain(
        "Credentials, local login, dependencies and target reachability were not checked",
      );
      expect(result.spend).toEqual({ e2bDesktop: false, model: false });
    });
  });

  it("refuses stale or unknown local login before touching the desktop provider", async () => {
    await project(lab("local-agent"), async (cwd) => {
      const resolved = await resolveStudyManifest(cwd, "preview");
      if (!resolved.ok) throw new Error(resolved.error.message);
      const bin = path.join(cwd, "bin");
      await mkdir(bin);
      const command = path.join(bin, "codex");
      for (const [status, message] of [
        ["Not logged in", "reports it is not signed in"],
        ["unknown private-account-marker", "could not be checked"],
      ]) {
        await writeFile(
          command,
          `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(status)}); process.exit(1);\n`,
        );
        await chmod(command, 0o700);
        let desktopLoads = 0;
        const outcome = await runStudyWith(
          resolved.config,
          {
            cwd,
            env: { ...keyless, PATH: bin, E2B_API_KEY: "synthetic-desktop-marker" },
          },
          {
            desktopModule: async () => {
              desktopLoads++;
              throw new Error("Must not reach desktop provider");
            },
          },
        );
        if (outcome.route !== "computer-use") throw new Error("Expected CUA route");
        expect(outcome.result.error?.message).toContain(message);
        expect(outcome.result.runId).toBe("not-created");
        expect(desktopLoads).toBe(0);
        expect(JSON.stringify(outcome)).not.toContain("private-account-marker");
      }
    });
  });
});

describe("a shared-world lab with a local-agent actor in doctor", () => {
  const codex = (authStatus: DetectedLocalAgent["authStatus"]): DetectedLocalAgent => ({
    id: "codex",
    bin: "codex",
    label: "Codex",
    credentialPath: "/synthetic/auth.json",
    binPath: "/synthetic/codex",
    credentialsPresent: true,
    authStatus,
  });

  async function setup(
    base: "sharedProvisioned" | "sharedExternal",
    agents: DetectedLocalAgent[],
    actor: Record<string, unknown> = { type: "local-agent", localAgent: "codex" },
  ) {
    const raw = admissionLab(
      base,
      { scenario: { mode: "live" }, review: { analysis: false } },
      actor,
    );
    return project(stringify(raw), (cwd) =>
      studySetupChecks({
        cwd,
        study: "humanish/studies/preview.yaml",
        env: keyless,
        agents,
        keyPresent: () => false,
        codexParticipantReadiness: async () => hostedReady,
      }),
    );
  }

  it("runs the provisioned plane on E2B alone and shows the agent's sign-in", async () => {
    const result = await setup("sharedProvisioned", [codex("authenticated")]);
    expect(result.checks.some((check) => check.name === "live route")).toBe(false);
    expect(result).toMatchObject({ desktop: true, keys: ["E2B_API_KEY"] });
    expect(
      result.checks.find((check) => check.name === "local participant authentication"),
    ).toMatchObject({ ok: true });
  });

  it("adds OPENAI_API_KEY on the external-public plane for the lobby-code reader", async () => {
    const result = await setup("sharedExternal", [codex("authenticated")]);
    expect(result.checks.some((check) => check.name === "live route")).toBe(false);
    expect(result.keys).toEqual(["E2B_API_KEY", "OPENAI_API_KEY"]);
  });

  it.each(["sharedProvisioned", "sharedExternal"] as const)(
    "asks an openai participant on the %s plane for E2B and OpenAI keys",
    async (base) => {
      const result = await setup(base, [], { type: "openai-computer-use" });
      expect(result).toMatchObject({ desktop: true, keys: ["E2B_API_KEY", "OPENAI_API_KEY"] });
    },
  );

  it.each([
    ["is signed out", [codex("unauthenticated")], "reports not signed in"],
    ["is not on PATH", [], "is not on this process's PATH"],
  ])("fails the sign-in row when the agent %s", async (_name, agents, message) => {
    const result = await setup("sharedProvisioned", agents);
    const row = result.checks.find((check) => check.name === "local participant authentication");
    expect(row).toMatchObject({ ok: false });
    expect(row?.message).toContain(message);
  });
});

describe("doctor reads a live run's needs from the lab's plan", () => {
  const check = (raw: Record<string, unknown>, env: NodeJS.ProcessEnv = keyless) =>
    project(stringify(raw), (cwd) =>
      studySetupChecks({
        cwd,
        study: "humanish/studies/preview.yaml",
        env,
        agents: [],
        keyPresent: () => false,
      }),
    );

  it("reports each subject env name the plan requires, present or missing", async () => {
    const raw = admissionLab("cuClone", {
      scenario: { mode: "live" },
      review: { analysis: false },
      subject: { env: ["SYNTHETIC_SUBJECT_TOKEN"] },
    });
    const row = async (env: NodeJS.ProcessEnv) =>
      (await check(raw, env)).checks.find(
        (item) => item.name === "subject env SYNTHETIC_SUBJECT_TOKEN",
      );
    expect(await row(keyless)).toMatchObject({ ok: false });
    expect(await row({ ...keyless, SYNTHETIC_SUBJECT_TOKEN: "synthetic-value" })).toEqual({
      name: "subject env SYNTHETIC_SUBJECT_TOKEN",
      ok: true,
      message: "present; value not shown",
    });
  });

  it("fails the live route row for a lab the planner refuses", async () => {
    // A 55-minute session derives a sandbox deadline past the 60-minute limit. The parser admits
    // it; the planner, and so `humanish lab run`, refuses it.
    const raw = admissionLab("cuAppUrl", {
      scenario: { mode: "live" },
      execution: { timeoutMs: 3_300_000 },
    });
    const result = await check(raw);
    expect(result).toMatchObject({ desktop: false, keys: [] });
    const row = result.checks.find((item) => item.name === "live route");
    expect(row?.ok).toBe(false);
    expect(row?.message).toContain("may not live longer than 60m");
  });
});
