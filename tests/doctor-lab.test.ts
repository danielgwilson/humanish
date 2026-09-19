import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { doctor } from "../src/run.js";
import type { DetectLocalAgentsOptions } from "../src/local-agent-cli.js";
import { runLabPreflight } from "../src/lab-preflight.js";
import { resolveLabManifest } from "../src/labs.js";
import { runLab } from "../src/lab-engine.js";

const noAgents: DetectLocalAgentsOptions = { which: async () => undefined };
const keyless = { HUMANISH_STRICT_KEYS: "1", PATH: "" };
const lab = (actor = "openai-computer-use", mode = "live") => [
  "schema: humanish.lab.v2", "id: preview", "subject:", "  source: app-url", "  appUrl: https://preview.example.test/",
  "actors:", `  - type: ${actor}`, ...(actor === "local-agent" ? ["    localAgent: codex"] : []),
  "execution:", "  target: e2b-desktop", "scenario:", `  mode: ${mode}`, "policies:", "  allowPublicTargets: true"
].join("\n");

async function project<T>(manifest: string, run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(path.join(tmpdir(), "humanish-doctor-lab-"));
  try {
    await mkdir(path.join(cwd, "humanish/labs"), { recursive: true });
    await writeFile(path.join(cwd, "package.json"), "{}");
    await writeFile(path.join(cwd, ".gitignore"), ".humanish/\n");
    await writeFile(path.join(cwd, "humanish/labs/preview.yaml"), manifest);
    return await run(cwd);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

describe("selected lab setup without paid dispatch", () => {
  it("permits a keyless dry-run but identifies the missing live API credentials", async () => {
    await project(lab("openai-computer-use", "dry-run"), async cwd => {
      expect((await doctor(cwd, { lab: "preview", env: keyless, localAgents: noAgents })).ok).toBe(true);
    });
    await project(lab(), async cwd => {
      const result = await doctor(cwd, { lab: "preview", env: keyless, localAgents: noAgents });
      expect(result.ok).toBe(false);
      expect(result.checks.filter(check => !check.ok).map(check => check.name)).toEqual(["key OPENAI_API_KEY", "key E2B_API_KEY"]);
      expect(result.checks.find(check => check.name === "post-run analysis")?.message).toContain("Will be skipped");
    });
  });

  it("does not require an API key for an authenticated local participant, and explicitly skips analysis", async () => {
    await project(lab("local-agent"), async cwd => {
      const result = await doctor(cwd, { lab: "preview", env: { ...keyless, E2B_API_KEY: "synthetic-desktop-marker" }, localAgents: {
        which: async bin => bin === "codex" ? "/synthetic/codex" : undefined, exists: async () => false,
        authProbe: async () => ({ code: 0, stdout: "", stderr: "Logged in using ChatGPT\nprivate-account-marker" })
      } });
      expect(result.ok).toBe(true);
      expect(result.checks.find(check => check.name === "local participant authentication")?.ok).toBe(true);
      expect(result.checks.find(check => check.name === "post-run analysis")?.message).toContain("no automatic findings report");
      expect(JSON.stringify(result)).not.toMatch(/synthetic-desktop-marker|private-account-marker/);
    });
  });

  it("refuses installed but uncheckable authentication without pretending it is signed out", async () => {
    await project(lab("local-agent"), async cwd => {
      const result = await doctor(cwd, { lab: "preview", env: { ...keyless, E2B_API_KEY: "synthetic-desktop-marker" }, localAgents: {
        which: async bin => bin === "codex" ? "/synthetic/codex" : undefined, exists: async () => true,
        authProbe: async () => ({ code: null, stdout: "", stderr: "private-account-marker" })
      } });
      expect(result.ok).toBe(false);
      const check = result.checks.find(check => check.name === "local participant authentication");
      expect(check?.message).toContain("could not be checked");
      expect(check?.message).not.toContain("not signed in");
      expect(JSON.stringify(result)).not.toContain("private-account-marker");
    });
  });

  it("calls keys present without claiming remote validity", async () => {
    await project(lab(), async cwd => {
      const result = await doctor(cwd, { lab: "preview", env: { ...keyless, OPENAI_API_KEY: "synthetic-invalid-model", E2B_API_KEY: "synthetic-invalid-desktop" }, localAgents: noAgents });
      expect(result.ok).toBe(true);
      expect(result.checks.find(check => check.name === "key OPENAI_API_KEY")?.message).toContain("validity not tested");
      expect(result.checks.find(check => check.name === "check scope")?.message).toContain("no paid resources");
      expect(JSON.stringify(result)).not.toMatch(/synthetic-invalid/);
    });
  });

  it("does not claim the library-only local-app route can run through the CLI", async () => {
    await project(lab().replace("source: app-url", "source: local-app").replace("https://preview.example.test/", "http://127.0.0.1:3000/")
      .replace("target: e2b-desktop", "target: local").replace("policies:\n  allowPublicTargets: true", ""), async cwd => {
      const result = await doctor(cwd, { lab: "preview", env: keyless, localAgents: noAgents });
      expect(result.ok).toBe(false);
      expect(result.checks.find(check => check.name === "live route")?.message).toContain("caller-supplied executor");
    });
  });

  it("separates successful metadata parsing from unverified setup", async () => {
    await project(lab(), async cwd => {
      const result = await runLabPreflight({ cwd, lab: "preview", env: keyless });
      expect(result.ok).toBe(true);
      expect(result.checks.find(check => check.name === "reachability")?.message).toContain("Credentials, local login, dependencies and target reachability were not checked");
      expect(result.spend).toEqual({ e2bDesktop: false, model: false });
    });
  });

  it("refuses stale or unknown local login before touching the desktop provider", async () => {
    await project(lab("local-agent"), async cwd => {
      const resolved = await resolveLabManifest(cwd, "preview");
      if (!resolved.ok) throw new Error(resolved.error.message);
      const bin = path.join(cwd, "bin");
      await mkdir(bin);
      const command = path.join(bin, "codex");
      for (const [status, message] of [["Not logged in", "reports not signed in"], ["unknown private-account-marker", "could not be checked"]]) {
        await writeFile(command, `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(status)}); process.exit(1);\n`);
        await chmod(command, 0o700);
        let desktopLoads = 0;
        const outcome = await runLab(resolved.config, { cwd, cuaHooks: {
          env: { ...keyless, PATH: bin, E2B_API_KEY: "synthetic-desktop-marker" },
          loadDesktopModule: async () => { desktopLoads++; throw new Error("Must not reach desktop provider"); }
        } });
        if (outcome.backend !== "cua") throw new Error("Expected CUA route");
        expect(outcome.result.error?.message).toContain(message);
        expect(outcome.result.runId).toBe("not-created");
        expect(desktopLoads).toBe(0);
        expect(JSON.stringify(outcome)).not.toContain("private-account-marker");
      }
    });
  });
});
