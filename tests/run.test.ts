import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ACTOR_TRACE_SCHEMA, type ActorTrace } from "../src/actor-contract.js";
import type { CuaLoopResult } from "../src/computer-use.js";
import { buildCuaBundle } from "../src/cua-actor-lab.js";
import { renderObserver } from "../src/observer.js";
import { createProgram } from "../src/program.js";
import { startCodexAppServerUi } from "../src/codex-app-server-ui.js";
import {
  PUBLIC_TARGET_CWD,
  RUN_BUNDLE_SCHEMA,
  buildRunSource,
  listRuns,
  readReview,
  runDryRun,
  verifyRun
} from "../src/run.js";

async function withFixtureCopy<T>(callback: (cwd: string) => Promise<T>): Promise<T> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mimetic-run-fixture-"));
  const tempApp = path.join(tempRoot, "minimal-app");

  try {
    await cp(path.resolve("fixtures/minimal-app"), tempApp, { recursive: true });
    return await callback(tempApp);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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

  await program.parseAsync(["node", "mimetic", ...args], { from: "node" });

  return {
    exitCode,
    stdout: stdout.join(""),
    stderr: stderr.join("")
  };
}

async function waitForFile(filePath: string, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await stat(filePath);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for ${filePath}`);
}

async function withHttpServer<T>(callback: (url: string) => Promise<T>): Promise<T> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Mimetic test app</title><main>browser surface proof</main>");
  });
  const url = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("HTTP server address was not available.");
      }
      resolve(`http://127.0.0.1:${address.port}/`);
    });
  });

  try {
    return await callback(url);
  } finally {
    await closeServer(server);
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function writeFakeBrowserCommand(cwd: string): Promise<string> {
  const browser = path.join(cwd, "fake-browser.cjs");
  await writeFile(
    browser,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const screenshotArg = process.argv.find((arg) => arg.startsWith('--screenshot='));",
      "if (process.argv.includes('--version')) {",
      "  process.stdout.write('Fake Chrome 1.0\\n');",
      "  process.exit(0);",
      "}",
      "if (!screenshotArg) {",
      "  process.stderr.write('missing screenshot arg\\n');",
      "  process.exit(2);",
      "}",
      "const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c6360f8cf000000040003027e7b040000000049454e44ae426082', 'hex');",
      "fs.writeFileSync(screenshotArg.slice('--screenshot='.length), png);",
      "process.exit(0);"
    ].join("\n"),
    "utf8"
  );
  await chmod(browser, 0o755);
  return browser;
}

async function writeMimeticBrowserScenario(cwd: string, scenarioText: string): Promise<void> {
  await mkdir(path.join(cwd, "mimetic", "personas"), { recursive: true });
  await mkdir(path.join(cwd, "mimetic", "scenarios"), { recursive: true });
  await writeFile(
    path.join(cwd, "mimetic/personas/synthetic-new-user.yaml"),
    [
      "schema: mimetic.persona.v1",
      "id: synthetic-new-user",
      "name: Synthetic New User",
      "summary: Public-safe fixture persona."
    ].join("\n") + "\n",
    "utf8"
  );
  await writeFile(path.join(cwd, "mimetic/scenarios/app-browser.yaml"), scenarioText, "utf8");
}

describe("dry-run bundles", () => {
  it("writes and verifies a synthetic run bundle", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "dryrun-test"
      });

      expect(run.ok).toBe(true);
      expect(run.runId).toBe("dryrun-test");
      expect(run.bundlePath).toBe(".mimetic/runs/dryrun-test/run.json");

      const bundleText = await readFile(path.join(cwd, ".mimetic/runs/dryrun-test/run.json"), "utf8");
      const bundle = JSON.parse(bundleText) as {
        cwd: string;
        schema: string;
        review: { verdict: string };
        simCount: number;
        simulations: unknown[];
        source: { git: { schema: string; status: string } };
      };
      expect(bundle.schema).toBe(RUN_BUNDLE_SCHEMA);
      expect(bundle.cwd).toBe(PUBLIC_TARGET_CWD);
      expect(bundleText).not.toContain(cwd);
      expect(bundle.simCount).toBe(1);
      expect(bundle.simulations).toHaveLength(1);
      expect(bundle.source.git.schema).toBe("mimetic.git-state.v1");
      expect(bundle.source.git.status).toBe("missing");
      expect(bundle.review.verdict).toBe("contract_proof_only");

      await expect(stat(path.join(cwd, ".mimetic/runs/latest.json"))).resolves.toBeTruthy();

      const verify = await verifyRun(cwd, "latest");
      expect(verify.ok).toBe(true);
      expect(verify.checks.every((check) => check.ok)).toBe(true);

      const observer = await renderObserver(cwd, "latest");
      expect(observer.ok).toBe(true);
      expect(observer.warnings.join("\n")).toContain("dry-run lanes do not claim product behavior proof");
      expect(observer.warnings.join("\n")).not.toContain("verified local evidence artifacts");

      const review = await readReview(cwd, "latest");
      expect("verdict" in review ? review.verdict : null).toBe("contract_proof_only");

      const runs = await listRuns(cwd);
      expect(runs.latest).toBe("dryrun-test");
      expect(runs.runs).toHaveLength(1);
    });
  });

  it("allows dry-run simulation counts above old magic caps", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "dryrun-sims-65",
        simCount: 65
      });

      expect(run.ok).toBe(true);
      expect(run.simCount).toBe(65);

      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".mimetic/runs/dryrun-sims-65/run.json"), "utf8")
      ) as { simCount: number; simulations: unknown[] };
      expect(bundle.simCount).toBe(65);
      expect(bundle.simulations).toHaveLength(65);
    });
  });

  it("fails closed on malformed run bundle shapes", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "malformed-run-shape"
      });
      expect(run.ok).toBe(true);

      const bundlePath = path.join(cwd, ".mimetic/runs/malformed-run-shape/run.json");
      const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
        streams?: unknown;
      };
      delete bundle.streams;
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      const verify = await verifyRun(cwd, "malformed-run-shape");
      expect(verify.ok).toBe(false);
      expect(verify.error?.code).toBe("MIMETIC_INVALID_RUN_BUNDLE");
      expect(verify.checks.find((check) => check.name === "run bundle shape")?.ok).toBe(false);
    });
  });

  it("fails closed on malformed source git provenance", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "malformed-run-source-git"
      });
      expect(run.ok).toBe(true);

      const bundlePath = path.join(cwd, ".mimetic/runs/malformed-run-source-git/run.json");
      const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
        source: { git: { schema?: string } };
      };
      bundle.source.git.schema = "mimetic.legacy-not-captured";
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      const verify = await verifyRun(cwd, "malformed-run-source-git");
      expect(verify.ok).toBe(false);
      expect(verify.error?.code).toBe("MIMETIC_INVALID_RUN_BUNDLE");
      expect(verify.checks.find((check) => check.name === "run bundle shape")?.ok).toBe(false);
    });
  });

  it("fails closed on unsafe git provenance values", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "malformed-run-git-values"
      });
      expect(run.ok).toBe(true);

      const bundlePath = path.join(cwd, ".mimetic/runs/malformed-run-git-values/run.json");
      const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
        source: { git: { head: { shortSha: unknown }; note: string } };
      };
      bundle.source.git.head.shortSha = "private/repo-name";
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      let verify = await verifyRun(cwd, "malformed-run-git-values");
      expect(verify.ok).toBe(false);
      expect(verify.error?.code).toBe("MIMETIC_INVALID_RUN_BUNDLE");
      expect(verify.checks.find((check) => check.name === "run bundle shape")?.ok).toBe(false);

      bundle.source.git.head.shortSha = null;
      bundle.source.git.note = "private branch and remote details";
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      verify = await verifyRun(cwd, "malformed-run-git-values");
      expect(verify.ok).toBe(false);
      expect(verify.error?.code).toBe("MIMETIC_INVALID_RUN_BUNDLE");
      expect(verify.checks.find((check) => check.name === "run bundle shape")?.ok).toBe(false);
    });
  });

  it("fails closed on malformed feedback candidates", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "malformed-feedback-candidate"
      });
      expect(run.ok).toBe(true);

      const bundlePath = path.join(cwd, ".mimetic/runs/malformed-feedback-candidate/run.json");
      const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
        feedbackCandidates: unknown[];
      };
      bundle.feedbackCandidates = [42];
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      const verify = await verifyRun(cwd, "malformed-feedback-candidate");
      expect(verify.ok).toBe(false);
      expect(verify.error?.code).toBe("MIMETIC_INVALID_RUN_BUNDLE");
      expect(verify.checks.find((check) => check.name === "run bundle shape")?.ok).toBe(false);
    });
  });

  it("fails closed on simulation and stream consistency mismatches", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "malformed-sim-streams"
      });
      expect(run.ok).toBe(true);

      const bundlePath = path.join(cwd, ".mimetic/runs/malformed-sim-streams/run.json");
      const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
        simCount: number;
        simulations: Array<{ id: string; streamIds: string[] }>;
        streams: Array<{ id: string; simId: string }>;
      };
      bundle.simCount = bundle.simulations.length + 1;
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      let verify = await verifyRun(cwd, "malformed-sim-streams");
      expect(verify.ok).toBe(false);
      expect(verify.error?.code).toBe("MIMETIC_INVALID_RUN_BUNDLE");
      expect(verify.checks.find((check) => check.name === "run bundle shape")?.ok).toBe(false);

      bundle.simCount = bundle.simulations.length;
      const firstStream = bundle.streams[0];
      expect(firstStream).toBeDefined();
      bundle.streams[0] = {
        ...firstStream!,
        simId: "missing-simulation"
      };
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      verify = await verifyRun(cwd, "malformed-sim-streams");
      expect(verify.ok).toBe(false);
      expect(verify.error?.code).toBe("MIMETIC_INVALID_RUN_BUNDLE");
      expect(verify.checks.find((check) => check.name === "run bundle shape")?.ok).toBe(false);
    });
  });

  it("keeps live runs fail-closed", async () => {
    await withFixtureCopy(async (cwd) => {
      const result = await runDryRun({ cwd });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("MIMETIC_LIVE_RUN_UNIMPLEMENTED");
      await expect(stat(path.join(cwd, ".mimetic"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("does not treat Codex flag names as OpenAI keys", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "flag-redaction-regression"
      });
      expect(run.ok).toBe(true);

      await writeFile(
        path.join(cwd, ".mimetic/runs/flag-redaction-regression/review.md"),
        "actor command: codex exec --ask-for-approval never\n",
        "utf8"
      );

      const verify = await verifyRun(cwd, "flag-redaction-regression");
      expect(verify.ok).toBe(true);
      expect(verify.checks.find((check) => check.name === "public-safety scan")?.ok).toBe(true);
    });
  });

  it("rejects browser profile artifacts in public proof runs", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "profile-artifact-regression"
      });
      expect(run.ok).toBe(true);

      const profileDir = path.join(cwd, ".mimetic/runs/profile-artifact-regression/profiles/desktop/Default");
      await mkdir(profileDir, { recursive: true });
      await writeFile(path.join(profileDir, "Preferences"), "{\"metadata_secret\":\"synthetic\"}\n", "utf8");

      const verify = await verifyRun(cwd, "profile-artifact-regression");
      expect(verify.ok).toBe(false);
      expect(verify.checks.find((check) => check.name === "public-safety scan")?.message)
        .toContain("profiles");
    });
  });

  it("scans non-bundle text artifacts for public-safety leaks", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "events-secret-regression"
      });
      expect(run.ok).toBe(true);

      await writeFile(
        path.join(cwd, ".mimetic/runs/events-secret-regression/events.ndjson"),
        `{\"message\":\"synthetic ${"sk-" + "testsecretvalue1234567890abcd"}\"}\n`,
        "utf8"
      );

      const verify = await verifyRun(cwd, "events-secret-regression");
      expect(verify.ok).toBe(false);
      expect(verify.checks.find((check) => check.name === "public-safety scan")?.message)
        .toContain("events.ndjson");
    });
  });

  it("rejects run bundles that persist raw local cwd paths", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "raw-cwd-regression"
      });
      expect(run.ok).toBe(true);

      const bundlePath = path.join(cwd, ".mimetic/runs/raw-cwd-regression/run.json");
      const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as { cwd: string };
      bundle.cwd = cwd;
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      const verify = await verifyRun(cwd, "raw-cwd-regression");
      expect(verify.ok).toBe(false);
      expect(verify.checks.find((check) => check.name === "run bundle shape")?.ok).toBe(false);
    });
  });

  it("rejects nonlocal stream artifact references in run bundles", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "nonlocal-artifact-regression"
      });
      expect(run.ok).toBe(true);

      const bundlePath = path.join(cwd, ".mimetic/runs/nonlocal-artifact-regression/run.json");
      const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
        streams: Array<{ artifacts: Array<{ label: string; path: string; kind: string }> }>;
      };
      bundle.streams[0]?.artifacts.push({
        label: "remote actor log",
        path: "/home/user/private-repo/actor.log",
        kind: "log"
      });
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      const verify = await verifyRun(cwd, "nonlocal-artifact-regression");
      expect(verify.ok).toBe(false);
      expect(verify.checks.find((check) => check.name === "local evidence artifacts exist")?.message)
        .toContain("nonlocal artifact");
    });
  });

  it("rejects local nested Mimetic proof references when the artifact is missing", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "missing-nested-proof-regression"
      });
      expect(run.ok).toBe(true);

      const bundlePath = path.join(cwd, ".mimetic/runs/missing-nested-proof-regression/run.json");
      const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
        streams: Array<{ ui?: { nestedObserverPath?: string } }>;
      };
      bundle.streams[0]!.ui = {
        ...(bundle.streams[0]?.ui ?? {}),
        nestedObserverPath: "nested-evidence/missing-nested-proof.json"
      };
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      const verify = await verifyRun(cwd, "missing-nested-proof-regression");
      expect(verify.ok).toBe(false);
      expect(verify.checks.find((check) => check.name === "local evidence artifacts exist")?.message)
        .toContain("nested-evidence/missing-nested-proof.json");
    });
  });

  it("rejects placeholder nested proof references as nonlocal evidence", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "placeholder-nested-proof-regression"
      });
      expect(run.ok).toBe(true);

      const bundlePath = path.join(cwd, ".mimetic/runs/placeholder-nested-proof-regression/run.json");
      const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
        streams: Array<{ ui?: { nestedObserverPath?: string } }>;
      };
      bundle.streams[0]!.ui = {
        ...(bundle.streams[0]?.ui ?? {}),
        nestedObserverPath: "[remote-nested-observer]"
      };
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      const verify = await verifyRun(cwd, "placeholder-nested-proof-regression");
      expect(verify.ok).toBe(false);
      expect(verify.checks.find((check) => check.name === "local evidence artifacts exist")?.message)
        .toContain("nonlocal nested observer reference");
    });
  });

  it("captures and verifies live browser app desktop/mobile evidence", async () => {
    await withFixtureCopy(async (cwd) => {
      await withHttpServer(async (appUrl) => {
        const previousBrowserCommand = process.env.MIMETIC_BROWSER_COMMAND;
        const previousBrowserPersonaDriver = process.env.MIMETIC_BROWSER_PERSONA_DRIVER;
        process.env.MIMETIC_BROWSER_COMMAND = await writeFakeBrowserCommand(cwd);
        process.env.MIMETIC_BROWSER_PERSONA_DRIVER = "fixture";

        try {
          const result = await runDryRun({
            appUrl,
            cwd,
            runId: "browser-app-test"
          });

          expect(result.ok).toBe(true);
          expect(result.mode).toBe("live");
          expect(result.simCount).toBe(2);

          const bundle = JSON.parse(
            await readFile(path.join(cwd, ".mimetic/runs/browser-app-test/run.json"), "utf8")
          ) as {
            mode: string;
            review: { verdict: string };
            scenario: { id: string; source: string };
            source: { git: { schema: string; status: string } };
            simulations: Array<{ mode: string; status: string; streamKind: string }>;
            streams: Array<{
              artifacts: Array<{ kind: string; path: string }>;
              embed: { kind: string; url: string };
              kind: string;
              status: string;
              ui: { appUrl: string; screenshotUrl: string };
              viewport: { isMobile?: boolean; width: number };
            }>;
          };

          expect(bundle.mode).toBe("live");
          expect(bundle.review.verdict).toBe("pass");
          expect(bundle.source.git.schema).toBe("mimetic.git-state.v1");
          expect(bundle.source.git.status).toBe("missing");
          expect(bundle.scenario).toEqual(expect.objectContaining({
            id: "browser-persona-two-step",
            source: "builtin:browser-persona-two-step"
          }));
          expect(bundle.simulations).toEqual([
            expect.objectContaining({ mode: "browser-sim", status: "passed", streamKind: "browser" }),
            expect.objectContaining({ mode: "browser-sim", status: "passed", streamKind: "browser" })
          ]);
          expect(bundle.streams.map((stream) => stream.kind)).toEqual(["browser", "browser"]);
          expect(bundle.streams.map((stream) => stream.viewport.width)).toEqual([1440, 390]);
          expect(bundle.streams[1]?.viewport.isMobile).toBe(true);
          expect(bundle.streams[0]?.embed.kind).toBe("screenshot");
          expect(bundle.streams[0]?.ui.appUrl).toBe(appUrl);
          expect(bundle.streams[0]?.ui.screenshotUrl).toBe("../screenshots/desktop-step-02-interact.png");
          expect(bundle.streams[0]?.artifacts.map((artifact) => artifact.path)).toContain("screenshots/desktop-step-01-load.png");
          expect(bundle.streams[0]?.artifacts.map((artifact) => artifact.path)).toContain("screenshots/desktop-step-02-interact.png");

          await expect(stat(path.join(cwd, ".mimetic/runs/browser-app-test/screenshots/desktop-step-01-load.png"))).resolves.toBeTruthy();
          await expect(stat(path.join(cwd, ".mimetic/runs/browser-app-test/screenshots/desktop-step-02-interact.png"))).resolves.toBeTruthy();
          await expect(stat(path.join(cwd, ".mimetic/runs/browser-app-test/screenshots/mobile-step-01-load.png"))).resolves.toBeTruthy();
          await expect(stat(path.join(cwd, ".mimetic/runs/browser-app-test/screenshots/mobile-step-02-interact.png"))).resolves.toBeTruthy();
          await expect(stat(path.join(cwd, ".mimetic/runs/browser-app-test/traces/desktop.json"))).resolves.toBeTruthy();
          await expect(stat(path.join(cwd, ".mimetic/runs/browser-app-test/events.ndjson"))).resolves.toBeTruthy();
          await expect(stat(path.join(cwd, ".mimetic/runs/browser-app-test/profiles"))).rejects.toBeTruthy();
          const desktopTrace = JSON.parse(
            await readFile(path.join(cwd, ".mimetic/runs/browser-app-test/traces/desktop.json"), "utf8")
          ) as { schema: string; steps: Array<{ status: string; screenshotPath: string }> };
          expect(desktopTrace.schema).toBe("mimetic.browser-persona-trace.v1");
          expect(desktopTrace.steps).toHaveLength(2);
          expect(desktopTrace.steps.map((step) => step.status)).toEqual(["passed", "passed"]);
          expect(desktopTrace.steps.map((step) => step.screenshotPath)).toEqual([
            "screenshots/desktop-step-01-load.png",
            "screenshots/desktop-step-02-interact.png"
          ]);

          const verify = await verifyRun(cwd, "latest");
          expect(verify.ok).toBe(true);
          expect(verify.checks.find((check) => check.name === "local evidence artifacts exist")?.ok).toBe(true);

          const observer = await renderObserver(cwd, "latest");
          expect(observer.ok).toBe(true);
          expect(observer.warnings.join("\n")).toContain("verified local evidence artifacts");
          expect(observer.warnings.join("\n")).not.toContain("dry-run lanes do not claim product behavior proof");

          bundle.streams[0]!.embed.url = "../screenshots/missing-embed.png";
          await writeFile(
            path.join(cwd, ".mimetic/runs/browser-app-test/run.json"),
            `${JSON.stringify(bundle, null, 2)}\n`,
            "utf8"
          );
          const missingEmbedVerify = await verifyRun(cwd, "latest");
          expect(missingEmbedVerify.ok).toBe(false);
          expect(missingEmbedVerify.checks.find((check) => check.name === "local evidence artifacts exist")?.message)
            .toContain("screenshots/missing-embed.png");
          bundle.streams[0]!.embed.url = "../screenshots/desktop-step-02-interact.png";
          await writeFile(
            path.join(cwd, ".mimetic/runs/browser-app-test/run.json"),
            `${JSON.stringify(bundle, null, 2)}\n`,
            "utf8"
          );

          await rm(path.join(cwd, ".mimetic/runs/browser-app-test/screenshots/mobile-step-02-interact.png"));
          const missingVerify = await verifyRun(cwd, "latest");
          expect(missingVerify.ok).toBe(false);
          expect(missingVerify.checks.find((check) => check.name === "local evidence artifacts exist")?.message)
            .toContain("screenshots/mobile-step-02-interact.png");
        } finally {
          if (previousBrowserCommand === undefined) {
            delete process.env.MIMETIC_BROWSER_COMMAND;
          } else {
            process.env.MIMETIC_BROWSER_COMMAND = previousBrowserCommand;
          }
          if (previousBrowserPersonaDriver === undefined) {
            delete process.env.MIMETIC_BROWSER_PERSONA_DRIVER;
          } else {
            process.env.MIMETIC_BROWSER_PERSONA_DRIVER = previousBrowserPersonaDriver;
          }
        }
      });
    });
  });

  it("uses executable browser scenario manifests for browser app proof traces", async () => {
    await withFixtureCopy(async (cwd) => {
      await withHttpServer(async (appUrl) => {
        await writeMimeticBrowserScenario(
          cwd,
          [
            "schema: mimetic.scenario.v1",
            "id: app-onboarding",
            "title: Fixture app onboarding",
            "persona: synthetic-new-user",
            "goal: Exercise the fixture app through app-specific browser checks.",
            "mode: browser",
            "browser:",
            "  startPath: /",
            "  steps:",
            "    - id: open-home",
            "      label: Open fixture home",
            "      action: goto",
            "      path: /",
            "      expect:",
            "        text: browser surface proof",
            "    - id: confirm-copy",
            "      label: Confirm visible copy",
            "      action: assertText",
            "      value: browser surface proof"
          ].join("\n") + "\n"
        );

        const previousBrowserCommand = process.env.MIMETIC_BROWSER_COMMAND;
        const previousBrowserPersonaDriver = process.env.MIMETIC_BROWSER_PERSONA_DRIVER;
        process.env.MIMETIC_BROWSER_COMMAND = await writeFakeBrowserCommand(cwd);
        process.env.MIMETIC_BROWSER_PERSONA_DRIVER = "fixture";

        try {
          const result = await runDryRun({
            appUrl,
            cwd,
            runId: "browser-app-manifest-test",
            simCount: 1
          });

          expect(result.ok).toBe(true);
          const bundle = JSON.parse(
            await readFile(path.join(cwd, ".mimetic/runs/browser-app-manifest-test/run.json"), "utf8")
          ) as {
            review: { gaps: string[]; verdict: string };
            scenario: { goal: string; id: string; source: string; title: string };
            simulations: Array<{ scenarioId: string }>;
            streams: Array<{ artifacts: Array<{ path: string }>; ui: { intent: string; screenshotUrl: string } }>;
          };
          expect(bundle.scenario).toEqual(expect.objectContaining({
            goal: "Exercise the fixture app through app-specific browser checks.",
            id: "app-onboarding",
            source: "mimetic/scenarios/app-browser.yaml",
            title: "Fixture app onboarding"
          }));
          expect(bundle.simulations[0]?.scenarioId).toBe("app-onboarding");
          expect(bundle.streams[0]?.ui.intent).toBe("Exercise the fixture app through app-specific browser checks.");
          expect(bundle.streams[0]?.ui.screenshotUrl).toBe("../screenshots/desktop-confirm-copy.png");
          expect(bundle.streams[0]?.artifacts.map((artifact) => artifact.path)).toContain("screenshots/desktop-open-home.png");
          expect(bundle.streams[0]?.artifacts.map((artifact) => artifact.path)).toContain("screenshots/desktop-confirm-copy.png");
          expect(bundle.review.gaps.join("\n")).toContain("mimetic/scenarios/app-browser.yaml");

          const desktopTrace = JSON.parse(
            await readFile(path.join(cwd, ".mimetic/runs/browser-app-manifest-test/traces/desktop.json"), "utf8")
          ) as {
            scenario: { id: string; source: string; stepCount: number };
            steps: Array<{ action: string; assertions?: Array<{ id: string; status: string }>; id: string; label: string; screenshotPath: string; status: string }>;
          };
          expect(desktopTrace.scenario).toEqual(expect.objectContaining({
            id: "app-onboarding",
            source: "mimetic/scenarios/app-browser.yaml",
            stepCount: 2
          }));
          expect(desktopTrace.steps).toEqual([
            expect.objectContaining({
              action: "goto",
              id: "open-home",
              label: "Open fixture home",
              screenshotPath: "screenshots/desktop-open-home.png",
              status: "passed"
            }),
            expect.objectContaining({
              action: "assertText",
              id: "confirm-copy",
              label: "Confirm visible copy",
              screenshotPath: "screenshots/desktop-confirm-copy.png",
              status: "passed"
            })
          ]);
          expect(desktopTrace.steps[0]?.assertions).toEqual([
            expect.objectContaining({ id: "text-present", status: "passed" })
          ]);

          const verify = await verifyRun(cwd, "latest");
          expect(verify.ok).toBe(true);
        } finally {
          if (previousBrowserCommand === undefined) {
            delete process.env.MIMETIC_BROWSER_COMMAND;
          } else {
            process.env.MIMETIC_BROWSER_COMMAND = previousBrowserCommand;
          }
          if (previousBrowserPersonaDriver === undefined) {
            delete process.env.MIMETIC_BROWSER_PERSONA_DRIVER;
          } else {
            process.env.MIMETIC_BROWSER_PERSONA_DRIVER = previousBrowserPersonaDriver;
          }
        }
      });
    });
  });

  it("allows a one-step executable browser scenario manifest", async () => {
    await withFixtureCopy(async (cwd) => {
      await withHttpServer(async (appUrl) => {
        await writeMimeticBrowserScenario(
          cwd,
          [
            "schema: mimetic.scenario.v1",
            "id: single-step-proof",
            "title: Single-step browser proof",
            "persona: synthetic-new-user",
            "goal: Load the fixture app and verify visible copy.",
            "mode: browser",
            "browser:",
            "  startPath: /",
            "  steps:",
            "    - id: open-home",
            "      label: Open fixture home",
            "      action: goto",
            "      path: /",
            "      expect:",
            "        text: browser surface proof"
          ].join("\n") + "\n"
        );

        const previousBrowserCommand = process.env.MIMETIC_BROWSER_COMMAND;
        const previousBrowserPersonaDriver = process.env.MIMETIC_BROWSER_PERSONA_DRIVER;
        process.env.MIMETIC_BROWSER_COMMAND = await writeFakeBrowserCommand(cwd);
        process.env.MIMETIC_BROWSER_PERSONA_DRIVER = "fixture";

        try {
          const result = await runDryRun({
            appUrl,
            cwd,
            runId: "browser-app-one-step-manifest",
            simCount: 1
          });

          expect(result.ok).toBe(true);
          const desktopTrace = JSON.parse(
            await readFile(path.join(cwd, ".mimetic/runs/browser-app-one-step-manifest/traces/desktop.json"), "utf8")
          ) as {
            scenario: { id: string; stepCount: number };
            steps: Array<{ id: string; status: string }>;
          };
          expect(desktopTrace.scenario).toEqual(expect.objectContaining({
            id: "single-step-proof",
            stepCount: 1
          }));
          expect(desktopTrace.steps).toEqual([
            expect.objectContaining({
              id: "open-home",
              status: "passed"
            })
          ]);
        } finally {
          if (previousBrowserCommand === undefined) {
            delete process.env.MIMETIC_BROWSER_COMMAND;
          } else {
            process.env.MIMETIC_BROWSER_COMMAND = previousBrowserCommand;
          }
          if (previousBrowserPersonaDriver === undefined) {
            delete process.env.MIMETIC_BROWSER_PERSONA_DRIVER;
          } else {
            process.env.MIMETIC_BROWSER_PERSONA_DRIVER = previousBrowserPersonaDriver;
          }
        }
      });
    });
  });

  it("fails closed for unparsable scenario YAML during browser app proof", async () => {
    await withFixtureCopy(async (cwd) => {
      await withHttpServer(async (appUrl) => {
        await writeMimeticBrowserScenario(
          cwd,
          [
            "schema: mimetic.scenario.v1",
            "id: unparsable-browser-scenario",
            "title: Unparsable browser scenario",
            "mode: browser",
            "browser:",
            "  steps:",
            "    - id: open-home",
            "      action: goto",
            "      expect:",
            "        text: \"unterminated"
          ].join("\n") + "\n"
        );

        const previousBrowserCommand = process.env.MIMETIC_BROWSER_COMMAND;
        const previousBrowserPersonaDriver = process.env.MIMETIC_BROWSER_PERSONA_DRIVER;
        process.env.MIMETIC_BROWSER_COMMAND = await writeFakeBrowserCommand(cwd);
        process.env.MIMETIC_BROWSER_PERSONA_DRIVER = "fixture";

        try {
          const result = await runDryRun({
            appUrl,
            cwd,
            runId: "browser-app-unparsable-manifest"
          });

          expect(result.ok).toBe(false);
          expect(result.error?.code).toBe("MIMETIC_BROWSER_APP_CAPTURE_FAILED");
          expect(result.error?.message).toContain("could not be parsed as YAML");
          await expect(stat(path.join(cwd, ".mimetic/runs/browser-app-unparsable-manifest/run.json"))).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
          if (previousBrowserCommand === undefined) {
            delete process.env.MIMETIC_BROWSER_COMMAND;
          } else {
            process.env.MIMETIC_BROWSER_COMMAND = previousBrowserCommand;
          }
          if (previousBrowserPersonaDriver === undefined) {
            delete process.env.MIMETIC_BROWSER_PERSONA_DRIVER;
          } else {
            process.env.MIMETIC_BROWSER_PERSONA_DRIVER = previousBrowserPersonaDriver;
          }
        }
      });
    });
  });

  it("fails closed for malformed executable browser scenario manifests", async () => {
    await withFixtureCopy(async (cwd) => {
      await withHttpServer(async (appUrl) => {
        await writeMimeticBrowserScenario(
          cwd,
          [
            "schema: mimetic.scenario.v1",
            "id: malformed-browser-scenario",
            "title: Malformed browser scenario",
            "goal: Prove malformed executable browser steps fail closed.",
            "mode: browser",
            "browser:",
            "  steps:",
            "    - id: missing-selector",
            "      label: Missing selector fill",
            "      action: fill",
            "      value: synthetic.user@example.test"
          ].join("\n") + "\n"
        );

        const previousBrowserCommand = process.env.MIMETIC_BROWSER_COMMAND;
        const previousBrowserPersonaDriver = process.env.MIMETIC_BROWSER_PERSONA_DRIVER;
        process.env.MIMETIC_BROWSER_COMMAND = await writeFakeBrowserCommand(cwd);
        process.env.MIMETIC_BROWSER_PERSONA_DRIVER = "fixture";

        try {
          const result = await runDryRun({
            appUrl,
            cwd,
            runId: "browser-app-malformed-manifest"
          });

          expect(result.ok).toBe(false);
          expect(result.error?.code).toBe("MIMETIC_BROWSER_APP_CAPTURE_FAILED");
          expect(result.error?.message).toContain("fill action requires selector");
          await expect(stat(path.join(cwd, ".mimetic/runs/browser-app-malformed-manifest/run.json"))).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
          if (previousBrowserCommand === undefined) {
            delete process.env.MIMETIC_BROWSER_COMMAND;
          } else {
            process.env.MIMETIC_BROWSER_COMMAND = previousBrowserCommand;
          }
          if (previousBrowserPersonaDriver === undefined) {
            delete process.env.MIMETIC_BROWSER_PERSONA_DRIVER;
          } else {
            process.env.MIMETIC_BROWSER_PERSONA_DRIVER = previousBrowserPersonaDriver;
          }
        }
      });
    });
  });

  it("rejects non-loopback app URLs for browser app proof", async () => {
    await withFixtureCopy(async (cwd) => {
      const result = await runDryRun({
        appUrl: "https://example.com/?token=secret",
        cwd,
        runId: "browser-app-invalid"
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("MIMETIC_INVALID_APP_URL");
    });
  });

  it("strips loopback app URL userinfo, query, and hash before durable browser proof artifacts", async () => {
    await withFixtureCopy(async (cwd) => {
      await withHttpServer(async (appUrl) => {
        const previousBrowserCommand = process.env.MIMETIC_BROWSER_COMMAND;
        const previousBrowserPersonaDriver = process.env.MIMETIC_BROWSER_PERSONA_DRIVER;
        process.env.MIMETIC_BROWSER_COMMAND = await writeFakeBrowserCommand(cwd);
        process.env.MIMETIC_BROWSER_PERSONA_DRIVER = "fixture";

        try {
          const pollutedUrl = appUrl.replace("http://", "http://synthetic-user:synthetic-pass@") + "?access_token=secret-token#private-fragment";
          const result = await runDryRun({
            appUrl: pollutedUrl,
            cwd,
            runId: "browser-app-url-sanitize"
          });

          expect(result.ok).toBe(true);

          const bundleText = await readFile(path.join(cwd, ".mimetic/runs/browser-app-url-sanitize/run.json"), "utf8");
          const desktopTraceText = await readFile(path.join(cwd, ".mimetic/runs/browser-app-url-sanitize/traces/desktop.json"), "utf8");
          const bundle = JSON.parse(bundleText) as { streams: Array<{ ui: { appUrl: string; route: string } }> };

          expect(bundle.streams[0]?.ui.appUrl).toBe(appUrl);
          expect(bundle.streams[0]?.ui.route).toBe(appUrl);
          for (const text of [bundleText, desktopTraceText]) {
            expect(text).not.toContain("synthetic-user");
            expect(text).not.toContain("synthetic-pass");
            expect(text).not.toContain("access_token");
            expect(text).not.toContain("secret-token");
            expect(text).not.toContain("private-fragment");
          }
        } finally {
          if (previousBrowserCommand === undefined) {
            delete process.env.MIMETIC_BROWSER_COMMAND;
          } else {
            process.env.MIMETIC_BROWSER_COMMAND = previousBrowserCommand;
          }
          if (previousBrowserPersonaDriver === undefined) {
            delete process.env.MIMETIC_BROWSER_PERSONA_DRIVER;
          } else {
            process.env.MIMETIC_BROWSER_PERSONA_DRIVER = previousBrowserPersonaDriver;
          }
        }
      });
    });
  });

  it("runs one explicit local Codex TUI actor with sanitized lifecycle evidence", async () => {
    await withFixtureCopy(async (cwd) => {
      const fakeActor = path.join(cwd, "fake-codex-actor.mjs");
      await writeFile(
        fakeActor,
        [
          "process.stdout.write('codex fixture actor started\\n');",
          "process.stdout.write('\\u001b[6n');",
          "process.stdin.setEncoding('latin1');",
          "const timeout = setTimeout(() => { process.stdout.write('terminal response missing\\n'); process.exit(1); }, 1000);",
          "process.stdin.on('data', (data) => {",
          "  if (!data.includes('\\u001b[24;120R')) return;",
          "  clearTimeout(timeout);",
          "  process.stdout.write('secret-like value ' + 'sk-' + 'testsecretvalue1234567890' + '\\n');",
          "  process.stdout.write(('MIMETIC_ACTOR_VERDICT=passed MIMETIC_ACTOR_NONCE=' + process.env.MIMETIC_ACTOR_VERDICT_NONCE).split('').join('\\u001b7\\u001b8') + '\\n');",
          "  process.exit(0);",
          "});"
        ].join("\n"),
        "utf8"
      );

      const result = await runDryRun({
        cwd,
        actor: "codex-tui",
        actorCommand: [process.execPath, fakeActor],
        runId: "codex-tui-test",
        simCount: 1,
        timeoutMs: 5_000
      });

      expect(result.ok).toBe(true);
      expect(result.mode).toBe("live");
      expect(result.runId).toBe("codex-tui-test");

      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".mimetic/runs/codex-tui-test/run.json"), "utf8")
      ) as {
        events: Array<{ type: string; message: string }>;
        mode: string;
        review: { verdict: string };
        simulations: Array<{ mode: string; status: string; streamKind: string }>;
        streams: Array<{
          completion: { status: string };
          kind: string;
          terminal: { tail: string };
          transport: string;
        }>;
      };

      expect(bundle.mode).toBe("live");
      expect(bundle.review.verdict).toBe("pass");
      expect(bundle.simulations).toEqual([
        expect.objectContaining({ mode: "tui-sim", status: "passed", streamKind: "tui" })
      ]);
      const corruptedMode = ["tbrowser", "sim"].join("-");
      expect(JSON.stringify(bundle)).not.toContain(corruptedMode);
      expect(bundle.streams).toEqual([
        expect.objectContaining({
          completion: expect.objectContaining({ status: "passed" }),
          kind: "tui",
          transport: "pty"
        })
      ]);
      expect(bundle.streams[0]?.terminal.tail).toContain("codex fixture actor started");
      expect(bundle.streams[0]?.terminal.tail).toContain("[REDACTED_SECRET]");
      expect(bundle.streams[0]?.terminal.tail).not.toContain(`sk-${"testsecretvalue"}`);
      expect(bundle.events.map((event) => event.type)).toContain("actor.spawned");
      expect(bundle.events.map((event) => event.type)).toContain("actor.prompt.submitted");
      expect(bundle.events.map((event) => event.type)).toContain("actor.verdict");
      expect(bundle.events.some((event) => event.message.includes(`sk-${"testsecretvalue"}`))).toBe(false);

      const transcript = await readFile(
        path.join(cwd, ".mimetic/runs/codex-tui-test/transcripts/codex-tui-sanitized.txt"),
        "utf8"
      );
      expect(transcript).toContain("MIMETIC_ACTOR_VERDICT=passed");
      expect(transcript).toContain("MIMETIC_ACTOR_NONCE=");
      expect(transcript).toContain("[REDACTED_SECRET]");
      expect(transcript).not.toContain(`sk-${"testsecretvalue"}`);

      const verify = await verifyRun(cwd, "latest");
      expect(verify.ok).toBe(true);
    });
  });

  it("honors a blocked local Codex TUI verdict marker even when the process exits cleanly", async () => {
    await withFixtureCopy(async (cwd) => {
      const fakeActor = path.join(cwd, "fake-codex-blocked-actor.mjs");
      await writeFile(
        fakeActor,
        "process.stdout.write('MIMETIC_ACTOR_VERDICT=blocked MIMETIC_ACTOR_NONCE=' + process.env.MIMETIC_ACTOR_VERDICT_NONCE + '\\n');\nsetInterval(() => {}, 1000);\n",
        "utf8"
      );

      const result = await runDryRun({
        cwd,
        actor: "codex-tui",
        actorCommand: [process.execPath, fakeActor],
        runId: "codex-tui-blocked-marker",
        simCount: 1,
        timeoutMs: 5_000
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("MIMETIC_LOCAL_CODEX_TUI_FAILED");

      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".mimetic/runs/codex-tui-blocked-marker/run.json"), "utf8")
      ) as {
        events: Array<{ type: string; message: string }>;
        review: { verdict: string };
        streams: Array<{ status: string; completion: { reason: string; status: string } }>;
      };
      expect(bundle.review.verdict).toBe("blocked");
      expect(bundle.streams[0]?.status).toBe("blocked");
      expect(bundle.streams[0]?.completion.reason).toContain("blocked verdict marker");
      expect(bundle.events.find((event) => event.type === "actor.verdict")?.message).toContain("blocked");
    });
  });

  it("ignores a bare local Codex TUI verdict marker that lacks the per-run nonce", async () => {
    await withFixtureCopy(async (cwd) => {
      const fakeActor = path.join(cwd, "fake-codex-tui-forged-verdict-actor.mjs");
      await writeFile(
        fakeActor,
        [
          "process.stdout.write('tui actor echoing an unauthenticated marker\\n');",
          "process.stdout.write('MIMETIC_ACTOR_VERDICT=passed\\n');",
          "process.exit(1);"
        ].join("\n"),
        "utf8"
      );

      const result = await runDryRun({
        cwd,
        actor: "codex-tui",
        actorCommand: [process.execPath, fakeActor],
        runId: "codex-tui-forged-marker",
        simCount: 1,
        timeoutMs: 5_000
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("MIMETIC_LOCAL_CODEX_TUI_FAILED");

      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".mimetic/runs/codex-tui-forged-marker/run.json"), "utf8")
      ) as {
        review: { verdict: string };
        streams: Array<{ status: string; completion: { reason: string; status: string } }>;
      };
      expect(bundle.review.verdict).toBe("fail");
      expect(bundle.streams[0]?.status).toBe("failed");
      expect(bundle.streams[0]?.completion.status).toBe("failed");
      expect(bundle.streams[0]?.completion.reason).not.toContain("verdict marker");
    });
  });

  it("publishes running Observer data while a local Codex TUI actor is active", async () => {
    await withFixtureCopy(async (cwd) => {
      const runId = "codex-tui-live-follow-test";
      const runRoot = path.join(cwd, ".mimetic/runs", runId);
      const fakeActor = path.join(cwd, "fake-codex-live-follow-actor.cjs");
      const startedFile = path.join(cwd, "actor-started");
      const releaseFile = path.join(cwd, "actor-release");
      await writeFile(
        fakeActor,
        [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(startedFile)}, 'started');`,
          "const timer = setInterval(() => {",
          `  if (!fs.existsSync(${JSON.stringify(releaseFile)})) return;`,
          "  clearInterval(timer);",
          "  process.stdout.write('MIMETIC_ACTOR_VERDICT=passed MIMETIC_ACTOR_NONCE=' + process.env.MIMETIC_ACTOR_VERDICT_NONCE + '\\n');",
          "}, 25);"
        ].join("\n"),
        "utf8"
      );

      const runPromise = runDryRun({
        cwd,
        actor: "codex-tui",
        actorCommand: [process.execPath, fakeActor],
        runId,
        simCount: 1,
        timeoutMs: 5_000
      });

      await waitForFile(startedFile);
      await waitForFile(path.join(runRoot, "observer/observer-data.json"));

      const runningBundle = JSON.parse(await readFile(path.join(runRoot, "run.json"), "utf8")) as {
        events: Array<{ type: string }>;
        lifecycle: Array<{ event: string }>;
        review: { verdict: string };
        streams: Array<{ artifacts: Array<{ path: string }>; status: string; completion: { status: string } }>;
      };
      expect(runningBundle.review.verdict).toBe("contract_proof_only");
      expect(runningBundle.lifecycle.map((entry) => entry.event)).toContain("actor.running");
      expect(runningBundle.events.map((event) => event.type)).toContain("actor.running");
      expect(runningBundle.streams[0]?.status).toBe("running");
      expect(runningBundle.streams[0]?.completion.status).toBe("running");
      expect(runningBundle.streams[0]?.artifacts.every((artifact) => !artifact.path.includes("transcripts/"))).toBe(true);

      const runningObserverData = JSON.parse(await readFile(path.join(runRoot, "observer/observer-data.json"), "utf8")) as {
        events: Array<{ type: string }>;
        streams: Array<{ status: string }>;
      };
      expect(runningObserverData.events.map((event) => event.type)).toContain("actor.running");
      expect(runningObserverData.streams[0]?.status).toBe("running");

      const runningLatest = JSON.parse(await readFile(path.join(cwd, ".mimetic/runs/latest.json"), "utf8")) as {
        runId: string;
        path: string;
      };
      expect(runningLatest.runId).toBe(runId);
      await expect(stat(path.join(cwd, runningLatest.path, "review.md"))).resolves.toBeTruthy();

      await writeFile(releaseFile, "go", "utf8");
      const result = await runPromise;
      expect(result.ok).toBe(true);

      const latest = JSON.parse(await readFile(path.join(cwd, ".mimetic/runs/latest.json"), "utf8")) as {
        runId: string;
        path: string;
      };
      expect(latest.runId).toBe(runId);
      await expect(stat(path.join(cwd, latest.path, "run.json"))).resolves.toBeTruthy();
      await expect(stat(path.join(cwd, latest.path, "review.md"))).resolves.toBeTruthy();

      const finalObserverData = JSON.parse(await readFile(path.join(runRoot, "observer/observer-data.json"), "utf8")) as {
        events: Array<{ type: string }>;
        streams: Array<{ artifacts: Array<{ path: string }>; status: string }>;
      };
      expect(finalObserverData.events.map((event) => event.type)).toContain("actor.verdict");
      expect(finalObserverData.streams[0]?.status).toBe("passed");
      expect(finalObserverData.streams[0]?.artifacts.some((artifact) => artifact.path.includes("transcripts/"))).toBe(true);
    });
  });

  it("exposes explicit local Codex TUI actor runs through the Commander CLI", async () => {
    await withFixtureCopy(async (cwd) => {
      const fakeActor = path.join(cwd, "fake-codex-cli.mjs");
      const previousCommand = process.env.MIMETIC_CODEX_ACTOR_COMMAND;
      await writeFile(
        fakeActor,
        "process.stdout.write('cli fixture actor passed\\n');\n",
        "utf8"
      );
      process.env.MIMETIC_CODEX_ACTOR_COMMAND = `${process.execPath} ${fakeActor}`;

      try {
        const result = await runCli([
          "run",
          "--actor",
          "codex-tui",
          "--sims",
          "1",
          "--timeout-ms",
          "5000",
          "--run-id",
          "codex-cli",
          "--cwd",
          cwd,
          "--json"
        ]);
        expect(result.exitCode).toBe(0);
        const envelope = JSON.parse(result.stdout) as { mode: string; ok: boolean; runId: string };
        expect(envelope.ok).toBe(true);
        expect(envelope.mode).toBe("live");
        expect(envelope.runId).toBe("codex-cli");

        const watch = await runCli([
          "watch",
          "--run",
          "codex-cli",
          "--detach",
          "--no-open",
          "--cwd",
          cwd,
          "--json"
        ]);
        expect(watch.exitCode).toBe(0);
        const observer = JSON.parse(watch.stdout) as { ok: boolean; observerPath: string };
        expect(observer.ok).toBe(true);
        expect(observer.observerPath).toBe(".mimetic/runs/codex-cli/observer/index.html");
      } finally {
        if (previousCommand === undefined) {
          delete process.env.MIMETIC_CODEX_ACTOR_COMMAND;
        } else {
          process.env.MIMETIC_CODEX_ACTOR_COMMAND = previousCommand;
        }
      }
    });
  });

  it("runs one explicit local Codex exec actor with sanitized lifecycle evidence", async () => {
    await withFixtureCopy(async (cwd) => {
      const fakeActor = path.join(cwd, "fake-codex-exec-actor.mjs");
      await writeFile(
        fakeActor,
        [
          "process.stdout.write('{\"type\":\"turn.started\"}\\n');",
          "process.stdout.write('exec actor inspected mimetic/config.ts\\n');",
          "process.stdout.write('secret-like value ' + 'sk-' + 'execsecretvalue1234567890' + '\\n');",
          "process.stdout.write('{\"type\":\"turn.completed\"}\\n');"
        ].join("\n"),
        "utf8"
      );

      const result = await runDryRun({
        cwd,
        actor: "codex-exec",
        actorCommand: [process.execPath, fakeActor],
        runId: "codex-exec-test",
        simCount: 1,
        timeoutMs: 5_000
      });

      expect(result.ok).toBe(true);
      expect(result.mode).toBe("live");
      expect(result.runId).toBe("codex-exec-test");

      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".mimetic/runs/codex-exec-test/run.json"), "utf8")
      ) as {
        events: Array<{ type: string; message: string }>;
        mode: string;
        review: { verdict: string };
        simulations: Array<{ status: string; streamKind: string }>;
        streams: Array<{
          completion: { status: string };
          kind: string;
          terminal: { tail: string };
          transport: string;
        }>;
      };

      expect(bundle.mode).toBe("live");
      expect(bundle.review.verdict).toBe("pass");
      expect(bundle.simulations).toEqual([expect.objectContaining({ status: "passed", streamKind: "terminal" })]);
      expect(bundle.streams).toEqual([
        expect.objectContaining({
          completion: expect.objectContaining({ status: "passed" }),
          kind: "terminal",
          transport: "snapshot"
        })
      ]);
      expect(bundle.streams[0]?.terminal.tail).toContain("exec actor inspected mimetic/config.ts");
      expect(bundle.streams[0]?.terminal.tail).toContain("[REDACTED_SECRET]");
      expect(bundle.streams[0]?.terminal.tail).not.toContain(`sk-${"execsecretvalue"}`);
      expect(bundle.events.map((event) => event.type)).toContain("actor.spawned");
      expect(bundle.events.map((event) => event.type)).toContain("actor.prompt.submitted");
      expect(bundle.events.map((event) => event.type)).toContain("actor.verdict");
      expect(bundle.events.some((event) => event.message.includes(`sk-${"execsecretvalue"}`))).toBe(false);

      const transcript = await readFile(
        path.join(cwd, ".mimetic/runs/codex-exec-test/transcripts/codex-exec-sanitized.jsonl"),
        "utf8"
      );
      expect(transcript).toContain("[REDACTED_SECRET]");
      expect(transcript).not.toContain(`sk-${"execsecretvalue"}`);

      const verify = await verifyRun(cwd, "latest");
      expect(verify.ok).toBe(true);
    });
  });

  it("ignores a bare local Codex exec verdict marker that lacks the per-run nonce", async () => {
    await withFixtureCopy(async (cwd) => {
      const fakeActor = path.join(cwd, "fake-codex-exec-forged-verdict-actor.mjs");
      await writeFile(
        fakeActor,
        [
          "process.stdout.write('exec actor echoing an unauthenticated marker\\n');",
          "process.stdout.write('MIMETIC_ACTOR_VERDICT=passed\\n');",
          "process.exit(1);"
        ].join("\n"),
        "utf8"
      );

      const result = await runDryRun({
        cwd,
        actor: "codex-exec",
        actorCommand: [process.execPath, fakeActor],
        runId: "codex-exec-forged-marker",
        simCount: 1,
        timeoutMs: 5_000
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("MIMETIC_LOCAL_CODEX_EXEC_FAILED");

      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".mimetic/runs/codex-exec-forged-marker/run.json"), "utf8")
      ) as {
        events: Array<{ type: string; message: string }>;
        review: { verdict: string };
        streams: Array<{ status: string; completion: { reason: string; status: string } }>;
      };
      expect(bundle.review.verdict).toBe("fail");
      expect(bundle.streams[0]?.status).toBe("failed");
      expect(bundle.streams[0]?.completion.status).toBe("failed");
      expect(bundle.streams[0]?.completion.reason).not.toContain("verdict marker");
      expect(bundle.events.find((event) => event.type === "actor.verdict")?.message).toContain("failed");
    });
  });

  it("honors a nonce-bearing local Codex exec verdict marker even when the process stays alive", async () => {
    await withFixtureCopy(async (cwd) => {
      const fakeActor = path.join(cwd, "fake-codex-exec-blocked-actor.mjs");
      await writeFile(
        fakeActor,
        "process.stdout.write('MIMETIC_ACTOR_VERDICT=blocked MIMETIC_ACTOR_NONCE=' + process.env.MIMETIC_ACTOR_VERDICT_NONCE + '\\n');\nsetInterval(() => {}, 1000);\n",
        "utf8"
      );

      const result = await runDryRun({
        cwd,
        actor: "codex-exec",
        actorCommand: [process.execPath, fakeActor],
        runId: "codex-exec-blocked-marker",
        simCount: 1,
        timeoutMs: 5_000
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("MIMETIC_LOCAL_CODEX_EXEC_FAILED");

      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".mimetic/runs/codex-exec-blocked-marker/run.json"), "utf8")
      ) as {
        events: Array<{ type: string; message: string }>;
        review: { verdict: string };
        streams: Array<{ status: string; completion: { reason: string; status: string } }>;
      };
      expect(bundle.review.verdict).toBe("blocked");
      expect(bundle.streams[0]?.status).toBe("blocked");
      expect(bundle.streams[0]?.completion.reason).toContain("blocked verdict marker");
      expect(bundle.events.find((event) => event.type === "actor.verdict")?.message).toContain("blocked");
    });
  });

  it("runs explicit local Codex exec fanout with per-lane sanitized lifecycle evidence", async () => {
    await withFixtureCopy(async (cwd) => {
      const fakeActor = path.join(cwd, "fake-codex-exec-fanout-actor.mjs");
      await writeFile(
        fakeActor,
        [
          "process.stdout.write('{\"type\":\"turn.started\"}\\n');",
          "process.stdout.write('exec fanout fixture inspected mimetic dogfood docs\\n');",
          "process.stdout.write('secret-like value ' + 'sk-' + 'fanoutsecretvalue1234567890' + '\\n');",
          "process.stdout.write('{\"type\":\"turn.completed\"}\\n');"
        ].join("\n"),
        "utf8"
      );

      const result = await runDryRun({
        cwd,
        actor: "codex-exec",
        actorCommand: [process.execPath, fakeActor],
        runId: "codex-exec-fanout-test",
        simCount: 4,
        timeoutMs: 5_000
      });

      expect(result.ok).toBe(true);
      expect(result.mode).toBe("live");
      expect(result.simCount).toBe(4);

      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".mimetic/runs/codex-exec-fanout-test/run.json"), "utf8")
      ) as {
        events: Array<{ type: string; message: string; simId?: string; streamId?: string }>;
        mode: string;
        review: { verdict: string; summary: string };
        simCount: number;
        simulations: Array<{ personaId: string; status: string; streamIds: string[]; streamKind: string }>;
        streams: Array<{
          artifacts: Array<{ path: string }>;
          completion: { status: string };
          id: string;
          kind: string;
          status: string;
          terminal: { tail: string };
          transport: string;
        }>;
      };

      expect(bundle.mode).toBe("live");
      expect(bundle.simCount).toBe(4);
      expect(bundle.review.verdict).toBe("pass");
      expect(bundle.review.summary).toContain("fanout lanes");
      expect(bundle.simulations).toHaveLength(4);
      expect(bundle.streams).toHaveLength(4);
      expect(bundle.simulations.map((simulation) => simulation.status)).toEqual([
        "passed",
        "passed",
        "passed",
        "passed"
      ]);
      expect(bundle.simulations.map((simulation) => simulation.streamKind)).toEqual([
        "terminal",
        "terminal",
        "terminal",
        "terminal"
      ]);
      expect(new Set(bundle.simulations.map((simulation) => simulation.personaId)).size).toBe(4);
      expect(bundle.streams.map((stream) => stream.id)).toEqual([
        "sim-01-codex-exec",
        "sim-02-codex-exec",
        "sim-03-codex-exec",
        "sim-04-codex-exec"
      ]);
      expect(bundle.streams.every((stream) => stream.kind === "terminal")).toBe(true);
      expect(bundle.streams.every((stream) => stream.transport === "snapshot")).toBe(true);
      expect(bundle.streams.every((stream) => stream.completion.status === "passed")).toBe(true);
      expect(bundle.streams.every((stream) => stream.terminal.tail.includes("[REDACTED_SECRET]"))).toBe(true);
      expect(bundle.events.filter((event) => event.type === "actor.spawned")).toHaveLength(4);
      expect(bundle.events.filter((event) => event.type === "actor.prompt.submitted")).toHaveLength(4);
      expect(bundle.events.filter((event) => event.type === "actor.verdict")).toHaveLength(4);
      expect(bundle.events.some((event) => event.message.includes(`sk-${"fanoutsecretvalue"}`))).toBe(false);

      for (const stream of bundle.streams) {
        const transcriptPath = stream.artifacts.find((artifact) => artifact.path.endsWith("-sanitized.jsonl"))?.path;
        const tracePath = stream.artifacts.find((artifact) => artifact.path.endsWith(".json") && artifact.path.startsWith("actors/"))?.path;
        expect(transcriptPath).toBeTruthy();
        expect(tracePath).toBeTruthy();
        const transcript = await readFile(path.join(cwd, ".mimetic/runs/codex-exec-fanout-test", transcriptPath ?? ""), "utf8");
        expect(transcript).toContain("[REDACTED_SECRET]");
        expect(transcript).not.toContain(`sk-${"fanoutsecretvalue"}`);
        await expect(stat(path.join(cwd, ".mimetic/runs/codex-exec-fanout-test", tracePath ?? ""))).resolves.toBeTruthy();
      }

      const verify = await verifyRun(cwd, "latest");
      expect(verify.ok).toBe(true);
    });
  });

  it("publishes running Observer data while local Codex exec actors are active", async () => {
    await withFixtureCopy(async (cwd) => {
      const fakeActor = path.join(cwd, "fake-codex-exec-slow-actor.mjs");
      const runRoot = path.join(cwd, ".mimetic/runs/codex-exec-live-follow-test");
      await writeFile(
        fakeActor,
        [
          "process.stdout.write('{\"type\":\"turn.started\"}\\n');",
          "process.stdout.write('slow exec actor started\\n');",
          "await new Promise((resolve) => setTimeout(resolve, 750));",
          "process.stdout.write('slow exec actor finished\\n');",
          "process.stdout.write('{\"type\":\"turn.completed\"}\\n');"
        ].join("\n"),
        "utf8"
      );

      const runPromise = runDryRun({
        cwd,
        actor: "codex-exec",
        actorCommand: [process.execPath, fakeActor],
        runId: "codex-exec-live-follow-test",
        simCount: 2,
        timeoutMs: 5_000
      });

      await waitForFile(path.join(runRoot, "observer/observer-data.json"));
      const runningBundle = JSON.parse(await readFile(path.join(runRoot, "run.json"), "utf8")) as {
        lifecycle: Array<{ event: string }>;
        review: { summary: string; verdict: string };
        simulations: Array<{ status: string }>;
        streams: Array<{ artifacts: Array<{ path: string }>; status: string }>;
      };
      const runningObserverData = JSON.parse(
        await readFile(path.join(runRoot, "observer/observer-data.json"), "utf8")
      ) as {
        events: Array<{ type: string }>;
        run: { status: string };
        summary: { active: number };
        streams: Array<{ status: string }>;
      };

      expect(runningBundle.review.verdict).toBe("contract_proof_only");
      expect(runningBundle.review.summary).toContain("in-progress Observer snapshot");
      expect(runningBundle.lifecycle.map((entry) => entry.event)).toContain("actor.running");
      expect(runningBundle.simulations.map((simulation) => simulation.status)).toEqual(["running", "running"]);
      expect(runningBundle.streams.map((stream) => stream.status)).toEqual(["running", "running"]);
      expect(runningBundle.streams.every((stream) => stream.artifacts.every((artifact) => !artifact.path.includes("transcripts/")))).toBe(true);
      expect(runningObserverData.run.status).toBe("contract_proof_only");
      expect(runningObserverData.summary.active).toBe(2);
      expect(runningObserverData.streams.map((stream) => stream.status)).toEqual(["running", "running"]);
      expect(runningObserverData.events.filter((event) => event.type === "actor.running")).toHaveLength(2);

      const result = await runPromise;
      expect(result.ok).toBe(true);

      const finalObserverData = JSON.parse(
        await readFile(path.join(runRoot, "observer/observer-data.json"), "utf8")
      ) as {
        events: Array<{ type: string }>;
        run: { status: string };
        summary: { active: number };
        streams: Array<{ artifacts: Array<{ path: string }>; status: string }>;
      };

      expect(finalObserverData.run.status).toBe("pass");
      expect(finalObserverData.summary.active).toBe(0);
      expect(finalObserverData.streams.map((stream) => stream.status)).toEqual(["passed", "passed"]);
      expect(finalObserverData.events.filter((event) => event.type === "actor.verdict")).toHaveLength(2);
      expect(finalObserverData.streams.every((stream) => stream.artifacts.some((artifact) => artifact.path.includes("transcripts/")))).toBe(true);

      const verify = await verifyRun(cwd, "latest");
      expect(verify.ok).toBe(true);
    });
  });

  it("runs local Codex exec lane counts above the old fanout cap", async () => {
    await withFixtureCopy(async (cwd) => {
      const result = await runDryRun({
        cwd,
        actor: "codex-exec",
        actorCommand: [process.execPath, "-e", "process.exit(0)"],
        runId: "codex-exec-five-lanes",
        simCount: 5,
        timeoutMs: 5_000
      });

      expect(result.ok).toBe(true);
      expect(result.simCount).toBe(5);

      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".mimetic/runs/codex-exec-five-lanes/run.json"), "utf8")
      ) as {
        lifecycle: Array<{ message: string }>;
        simCount: number;
        simulations: Array<{ status: string }>;
        streams: Array<{ completion: { status: string } }>;
      };

      expect(bundle.simCount).toBe(5);
      expect(bundle.lifecycle[0]?.message).toContain("max concurrency 4");
      expect(bundle.simulations).toHaveLength(5);
      expect(bundle.streams).toHaveLength(5);
      expect(bundle.simulations.every((simulation) => simulation.status === "passed")).toBe(true);
      expect(bundle.streams.every((stream) => stream.completion.status === "passed")).toBe(true);

      const verify = await verifyRun(cwd, "latest");
      expect(verify.ok).toBe(true);
    });
  });

  it("exposes explicit local Codex exec actor runs through the Commander CLI", async () => {
    await withFixtureCopy(async (cwd) => {
      const fakeActor = path.join(cwd, "fake-codex-exec-cli.mjs");
      const previousCommand = process.env.MIMETIC_CODEX_ACTOR_COMMAND;
      await writeFile(
        fakeActor,
        "process.stdout.write('cli exec fixture actor passed\\n');\n",
        "utf8"
      );
      process.env.MIMETIC_CODEX_ACTOR_COMMAND = `${process.execPath} ${fakeActor}`;

      try {
        const result = await runCli([
          "run",
          "--actor",
          "codex-exec",
          "--sims",
          "1",
          "--timeout-ms",
          "5000",
          "--run-id",
          "codex-exec-cli",
          "--cwd",
          cwd,
          "--json"
        ]);
        expect(result.exitCode).toBe(0);
        const envelope = JSON.parse(result.stdout) as { mode: string; ok: boolean; runId: string };
        expect(envelope.ok).toBe(true);
        expect(envelope.mode).toBe("live");
        expect(envelope.runId).toBe("codex-exec-cli");

        const watch = await runCli([
          "watch",
          "--run",
          "codex-exec-cli",
          "--detach",
          "--no-open",
          "--cwd",
          cwd,
          "--json"
        ]);
        expect(watch.exitCode).toBe(0);
        const observer = JSON.parse(watch.stdout) as { ok: boolean; observerPath: string };
        expect(observer.ok).toBe(true);
        expect(observer.observerPath).toBe(".mimetic/runs/codex-exec-cli/observer/index.html");
      } finally {
        if (previousCommand === undefined) {
          delete process.env.MIMETIC_CODEX_ACTOR_COMMAND;
        } else {
          process.env.MIMETIC_CODEX_ACTOR_COMMAND = previousCommand;
        }
      }
    });
  });

  it("persists Codex app-server UI state without raw prompt, key, or local paths", async () => {
    await withFixtureCopy(async (cwd) => {
      const fakeAppServer = path.join(cwd, "fake-codex-app-server-ui.mjs");
      const fakeApiKey = `sk-${"ui-state-testsecretvalue1234567890"}`;
      const previousOpenai = process.env.OPENAI_API_KEY;
      await writeFile(
        fakeAppServer,
        [
          "import readline from 'node:readline';",
          "const rl = readline.createInterface({ input: process.stdin });",
          "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
          "const thread = { id: 'thread-ui-public-safe-01', sessionId: 'session-ui-public-safe-01', model: 'test-model', cwd: process.cwd(), cliVersion: 'codex-cli-test' };",
          "const turn = { id: 'turn-ui-public-safe-01', status: 'inProgress' };",
          "rl.on('line', (line) => {",
          "  const msg = JSON.parse(line);",
          "  if (msg.method === 'initialize') send({ id: msg.id, result: { userAgent: 'fake-codex-app-server-ui' } });",
          "  if (msg.method === 'account/login/start') send({ id: msg.id, result: { type: 'apiKey' } });",
          "  if (msg.method === 'thread/start') { send({ id: msg.id, result: { thread } }); send({ method: 'thread/started', params: { thread } }); }",
          "  if (msg.method === 'turn/start') {",
          "    send({ id: msg.id, result: { turn } });",
          "    send({ method: 'turn/started', params: { threadId: thread.id, turn } });",
          "    send({ method: 'item/agentMessage/delta', params: { threadId: thread.id, turnId: turn.id, itemId: 'msg-ui-01', delta: 'UI state path check complete.' } });",
          "    send({ method: 'turn/completed', params: { threadId: thread.id, turn: { ...turn, status: 'completed' } } });",
          "    setTimeout(() => process.exit(0), 50);",
          "  }",
          "});"
        ].join("\n"),
        "utf8"
      );

      process.env.OPENAI_API_KEY = fakeApiKey;
      try {
        const controller = await startCodexAppServerUi({
          actorCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(fakeAppServer)}`,
          cwd,
          prompt: `Private UI prompt marker at ${cwd} with ${fakeApiKey}`,
          runRoot: ".mimetic/codex-app-server-ui-test",
          stateFile: ".mimetic/codex-app-server-ui-test/state.json",
          timeoutMs: 5_000
        });
        await controller.completion;
        const stateText = await readFile(path.join(cwd, ".mimetic/codex-app-server-ui-test/state.json"), "utf8");
        expect(stateText).toContain("[target-cwd]");
        expect(stateText).not.toContain(cwd);
        expect(stateText).not.toContain("Private UI prompt marker");
        expect(stateText).not.toContain(fakeApiKey);
        expect(stateText).toContain("promptDigest");
      } finally {
        if (previousOpenai === undefined) {
          delete process.env.OPENAI_API_KEY;
        } else {
          process.env.OPENAI_API_KEY = previousOpenai;
        }
      }
    });
  });

  it("runs an explicit Codex app-server actor with redacted protocol evidence", async () => {
    await withFixtureCopy(async (cwd) => {
      const fakeAppServer = path.join(cwd, "fake-codex-app-server.mjs");
      const fakeApiKey = `sk-${"testsecretvalue1234567890"}`;
      const fakeAwsAccessKey = `AKIA${"IOSFODNN7EXAMPLE"}`;
      const previousOpenai = process.env.OPENAI_API_KEY;
      await writeFile(
        fakeAppServer,
        [
          "import readline from 'node:readline';",
          "const rl = readline.createInterface({ input: process.stdin });",
          "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
          "let apiKeyLoginSeen = false;",
          "const thread = { id: 'thread-public-safe-01', sessionId: 'session-public-safe-01', preview: '', ephemeral: true, modelProvider: 'openai', createdAt: 1780680000, updatedAt: 1780680000, status: 'running', path: null, cwd: process.cwd(), cliVersion: 'codex-cli-test', source: 'app-server', threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [] };",
          "const turn = { id: 'turn-public-safe-01', items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: 1780680000, completedAt: null, durationMs: null };",
          "const finish = () => {",
          "  send({ method: 'serverRequest/resolved', params: { threadId: thread.id, requestId: 'approval-public-safe-01' } });",
          "  send({ method: 'item/agentMessage/delta', params: { threadId: thread.id, turnId: turn.id, itemId: 'msg-01', delta: 'Synthetic app-server agent message with secret ' + 'sk-' + 'testsecretvalue1234567890' } });",
          "  send({ method: 'item/reasoning/summaryTextDelta', params: { threadId: thread.id, turnId: turn.id, itemId: 'reason-01', summaryIndex: 0, delta: 'Checked the public-safe harness contract.' } });",
          "  send({ method: 'turn/plan/updated', params: { threadId: thread.id, turnId: turn.id, explanation: 'Synthetic plan', plan: [{ step: 'Inspect app-server proof', status: 'completed' }] } });",
          `  send({ method: 'item/started', params: { threadId: thread.id, turnId: turn.id, item: { type: 'commandExecution', id: 'cmd-01', command: 'node --version && echo ${fakeAwsAccessKey}', cwd: process.cwd(), processId: null, source: 'exec', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null }, startedAtMs: Date.now() } });`,
          "  send({ method: 'item/commandExecution/outputDelta', params: { threadId: thread.id, turnId: turn.id, itemId: 'cmd-01', delta: 'v24.0.0\\n' } });",
          `  send({ method: 'item/completed', params: { threadId: thread.id, turnId: turn.id, item: { type: 'commandExecution', id: 'cmd-01', command: 'node --version && echo ${fakeAwsAccessKey}', cwd: process.cwd(), processId: null, source: 'exec', status: 'completed', commandActions: [], aggregatedOutput: 'v24.0.0\\n', exitCode: 0, durationMs: 12 }, completedAtMs: Date.now() } });`,
          "  send({ method: 'turn/completed', params: { threadId: thread.id, turn: { ...turn, status: 'completed', completedAt: 1780680001, durationMs: 1000 } } });",
          "  setTimeout(() => process.exit(0), 50);",
          "};",
          "rl.on('line', (line) => {",
          "  const msg = JSON.parse(line);",
          "  if (msg.method === 'initialize') send({ id: msg.id, result: { userAgent: 'fake-codex-app-server', platformFamily: 'test', platformOs: 'test' } });",
          "  if (msg.method === 'account/login/start') { if (msg.params?.type !== 'apiKey' || typeof msg.params?.apiKey !== 'string' || !msg.params.apiKey.startsWith('sk-')) { send({ id: msg.id, error: { code: -32600, message: 'missing api key login' } }); return; } apiKeyLoginSeen = true; send({ id: msg.id, result: { type: 'apiKey' } }); }",
          "  if (msg.method === 'thread/start') { if (!apiKeyLoginSeen) { send({ id: msg.id, error: { code: -32600, message: 'api key login not seen' } }); return; } send({ id: msg.id, result: { thread } }); send({ method: 'thread/started', params: { thread } }); }",
          "  if (msg.method === 'turn/start') {",
          "    const input = msg.params?.input?.[0];",
          "    if (input?.type !== 'text' || !Array.isArray(input.text_elements)) { send({ id: msg.id, error: { code: -32600, message: 'invalid test input shape' } }); return; }",
          "    if (msg.params?.sandboxPolicy?.type !== 'readOnly' || msg.params.sandboxPolicy.networkAccess !== false) { send({ id: msg.id, error: { code: -32600, message: 'invalid test sandboxPolicy shape' } }); return; }",
          "    send({ id: msg.id, result: { turn } }); send({ method: 'turn/started', params: { threadId: thread.id, turn } }); send({ method: 'item/commandExecution/requestApproval', id: 'approval-public-safe-01', params: { threadId: thread.id, turnId: turn.id, itemId: 'cmd-01', reason: 'synthetic approval request', command: 'node --version', cwd: process.cwd() } });",
          "  }",
          "  if (msg.id === 'approval-public-safe-01') finish();",
          "});"
        ].join("\n"),
        "utf8"
      );

      process.env.OPENAI_API_KEY = fakeApiKey;

      let result;
      try {
        result = await runDryRun({
          cwd,
          actor: "codex-app-server",
          actorCommand: [process.execPath, fakeAppServer],
          runId: "codex-app-server-test",
          simCount: 1,
          timeoutMs: 5_000
        });
      } finally {
        if (previousOpenai === undefined) {
          delete process.env.OPENAI_API_KEY;
        } else {
          process.env.OPENAI_API_KEY = previousOpenai;
        }
      }

      expect(result.ok).toBe(true);
      expect(result.mode).toBe("live");
      expect(result.runId).toBe("codex-app-server-test");

      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".mimetic/runs/codex-app-server-test/run.json"), "utf8")
      ) as {
        events: Array<{ type: string; message: string }>;
        review: { verdict: string };
        simulations: Array<{ mode: string; status: string; streamKind: string }>;
        streams: Array<{
          artifacts: Array<{ kind: string; path: string }>;
          codex: {
            provider: string;
            state: string;
            threadId: string;
            trace: { counts: { approvals: number; commandOutputs: number; envelopes: number }; schema: string };
            tracePath: string;
            turnId: string;
          };
          actor?: {
            schema: string;
            provider: string;
            persona: { id: string; promptDigest: string; traitsApplied: string[] };
          };
          kind: string;
          transport: string;
        }>;
      };

      expect(bundle.review.verdict).toBe("pass");
      expect(bundle.simulations).toEqual([
        expect.objectContaining({ mode: "codex-app-sim", status: "passed", streamKind: "codex-ui" })
      ]);
      expect(bundle.streams[0]).toEqual(expect.objectContaining({
        kind: "codex-ui",
        transport: "app-server"
      }));
      expect(bundle.streams[0]?.codex.provider).toBe("codex-app-server");
      expect(bundle.streams[0]?.codex.state).toBe("completed");
      expect(bundle.streams[0]?.codex.threadId).toBe("thread-public-safe-01");
      expect(bundle.streams[0]?.codex.turnId).toBe("turn-public-safe-01");
      expect(bundle.streams[0]?.codex.trace.schema).toBe("mimetic.codex-app-server-trace.v1");
      expect(bundle.streams[0]?.codex.trace.counts.approvals).toBe(1);
      expect(bundle.streams[0]?.codex.trace.counts.commandOutputs).toBeGreaterThan(0);
      // Provider-neutral actor projection is populated alongside the raw codex evidence,
      // and carries the persona's applied traits.
      const actorTrace = bundle.streams[0]?.actor;
      expect(actorTrace?.schema).toBe("mimetic.actor-trace.v1");
      expect(actorTrace?.provider).toBe("codex-app-server");
      expect(actorTrace?.persona.id).toBeTruthy();
      expect(typeof actorTrace?.persona.promptDigest).toBe("string");
      expect(actorTrace?.persona.promptDigest.length).toBeGreaterThan(0);
      expect(Array.isArray(actorTrace?.persona.traitsApplied)).toBe(true);
      expect(actorTrace?.persona.traitsApplied.some((entry: string) => entry.startsWith("patience:"))).toBe(true);
      expect(actorTrace?.persona.traitsApplied.some((entry: string) => entry.startsWith("skill:"))).toBe(true);
      expect(bundle.streams[0]?.artifacts.some((artifact) => artifact.path === "codex-app-server/summary.json")).toBe(true);
      expect(bundle.events.map((event) => event.type)).toContain("codex-app-server.verdict");
      expect(JSON.stringify(bundle)).not.toContain(`sk-${"testsecretvalue"}`);
      expect(JSON.stringify(bundle)).toContain("[REDACTED_SECRET]");

      const trace = await readFile(
        path.join(cwd, ".mimetic/runs/codex-app-server-test/codex-app-server/summary.json"),
        "utf8"
      );
      const appServerEvents = await readFile(
        path.join(cwd, ".mimetic/runs/codex-app-server-test/codex-app-server/events.ndjson"),
        "utf8"
      );
      const transcript = await readFile(
        path.join(cwd, ".mimetic/runs/codex-app-server-test/codex-app-server/transcript.txt"),
        "utf8"
      );
      expect(trace).toContain("mimetic.codex-app-server-trace.v1");
      expect(trace).toContain("approval-public-safe-01");
      expect(trace).toContain("[REDACTED_SECRET]");
      expect(trace).not.toContain(`sk-${"testsecretvalue"}`);
      expect(trace).not.toContain(fakeAwsAccessKey);
      expect(trace).toContain("[target-cwd]");
      expect(trace).not.toContain(cwd);
      expect(appServerEvents).toContain("[REDACTED_PROMPT_TEXT]");
      expect(appServerEvents).toContain("textDigest");
      expect(appServerEvents).not.toContain("You are a Mimetic Codex app-server dogfood actor");
      expect(appServerEvents).not.toContain(cwd);
      expect(transcript).not.toContain(cwd);

      const verify = await verifyRun(cwd, "latest");
      expect(verify.ok).toBe(true);
      expect(verify.checks.find((check) => check.name === "codex app-server evidence")?.ok).toBe(true);
    });
  });

  it("blocks the default Codex TUI actor before spawn when workspace trust is missing", async () => {
    await withFixtureCopy(async (cwd) => {
      const codexHome = path.join(cwd, ".codex-home");
      const previousCodexHome = process.env.CODEX_HOME;
      const previousActorCommand = process.env.MIMETIC_CODEX_ACTOR_COMMAND;
      await mkdir(path.join(cwd, ".git"), { recursive: true });
      await writeFile(path.join(cwd, ".git/HEAD"), "ref: refs/heads/main\n", "utf8");
      await mkdir(codexHome, { recursive: true });
      delete process.env.MIMETIC_CODEX_ACTOR_COMMAND;
      process.env.CODEX_HOME = codexHome;

      try {
        const result = await runDryRun({
          cwd,
          actor: "codex-tui",
          runId: "codex-trust-blocked",
          simCount: 1,
          timeoutMs: 5_000
        });

        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe("MIMETIC_LOCAL_CODEX_TUI_FAILED");

        const bundle = JSON.parse(
          await readFile(path.join(cwd, ".mimetic/runs/codex-trust-blocked/run.json"), "utf8")
        ) as {
          events: Array<{ type: string }>;
          review: { verdict: string };
          streams: Array<{ status: string; terminal: { tail: string } }>;
        };
        expect(bundle.review.verdict).toBe("blocked");
        expect(bundle.streams[0]?.status).toBe("blocked");
        expect(bundle.streams[0]?.terminal.tail).toContain("Codex workspace trust preflight blocked");
        expect(bundle.events.map((event) => event.type)).toContain("actor.preflight.blocked");
        expect(bundle.events.map((event) => event.type)).toContain("actor.blocked");
        expect(bundle.events.map((event) => event.type)).not.toContain("actor.spawned");
        // #107 regression: the trust-preflight reason embeds the absolute
        // workspace path; it must be redacted before it reaches any persisted
        // bundle field (event, summary, completion reason, review, lifecycle).
        expect(JSON.stringify(bundle)).not.toContain(cwd);

        const verify = await verifyRun(cwd, "latest");
        expect(verify.ok).toBe(true);
      } finally {
        if (previousCodexHome === undefined) {
          delete process.env.CODEX_HOME;
        } else {
          process.env.CODEX_HOME = previousCodexHome;
        }
        if (previousActorCommand === undefined) {
          delete process.env.MIMETIC_CODEX_ACTOR_COMMAND;
        } else {
          process.env.MIMETIC_CODEX_ACTOR_COMMAND = previousActorCommand;
        }
      }
    });
  });

  it("blocks the default Codex TUI actor when only a trusted ancestor project is configured", async () => {
    await withFixtureCopy(async (cwd) => {
      const codexHome = path.join(cwd, ".codex-home");
      const fakeBin = path.join(cwd, "fake-bin");
      const fakeCodex = path.join(fakeBin, "codex");
      const spawnedSentinel = path.join(cwd, "fake-codex-spawned");
      const previousCodexHome = process.env.CODEX_HOME;
      const previousActorCommand = process.env.MIMETIC_CODEX_ACTOR_COMMAND;
      const previousPath = process.env.PATH;
      const trustedAncestor = path.dirname(cwd);
      await mkdir(path.join(cwd, ".git"), { recursive: true });
      await writeFile(path.join(cwd, ".git/HEAD"), "ref: refs/heads/main\n", "utf8");
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        path.join(codexHome, "config.toml"),
        `[projects."${trustedAncestor.replace(/["\\]/g, "\\$&")}"]\ntrust_level = "trusted"\n`,
        "utf8"
      );
      await writeFile(
        fakeCodex,
        `#!/usr/bin/env sh\ntouch ${JSON.stringify(spawnedSentinel)}\nprintf 'fake trusted codex tui started\\n'\nprintf 'MIMETIC_ACTOR_VERDICT=passed MIMETIC_ACTOR_NONCE=%s\\n' "$MIMETIC_ACTOR_VERDICT_NONCE"\n`,
        "utf8"
      );
      await chmod(fakeCodex, 0o755);
      delete process.env.MIMETIC_CODEX_ACTOR_COMMAND;
      process.env.CODEX_HOME = codexHome;
      process.env.PATH = previousPath ? `${fakeBin}${path.delimiter}${previousPath}` : fakeBin;

      try {
        const result = await runDryRun({
          cwd,
          actor: "codex-tui",
          runId: "codex-trusted-ancestor",
          simCount: 1,
          timeoutMs: 5_000
        });

        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe("MIMETIC_LOCAL_CODEX_TUI_FAILED");

        const bundle = JSON.parse(
          await readFile(path.join(cwd, ".mimetic/runs/codex-trusted-ancestor/run.json"), "utf8")
        ) as {
          events: Array<{ type: string }>;
          review: { verdict: string };
          streams: Array<{ status: string; terminal: { tail: string } }>;
        };
        expect(bundle.review.verdict).toBe("blocked");
        expect(bundle.streams[0]?.status).toBe("blocked");
        expect(bundle.streams[0]?.terminal.tail).toContain("exact Codex project root");
        expect(bundle.events.map((event) => event.type)).toContain("actor.preflight.blocked");
        expect(bundle.events.map((event) => event.type)).not.toContain("actor.spawned");
        await expect(stat(spawnedSentinel)).rejects.toMatchObject({ code: "ENOENT" });

        const verify = await verifyRun(cwd, "latest");
        expect(verify.ok).toBe(true);
      } finally {
        if (previousCodexHome === undefined) {
          delete process.env.CODEX_HOME;
        } else {
          process.env.CODEX_HOME = previousCodexHome;
        }
        if (previousActorCommand === undefined) {
          delete process.env.MIMETIC_CODEX_ACTOR_COMMAND;
        } else {
          process.env.MIMETIC_CODEX_ACTOR_COMMAND = previousActorCommand;
        }
        if (previousPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = previousPath;
        }
      }
    });
  });

  it("allows the default Codex TUI actor when the exact project root is trusted", async () => {
    await withFixtureCopy(async (cwd) => {
      const codexHome = path.join(cwd, ".codex-home");
      const fakeBin = path.join(cwd, "fake-bin");
      const fakeCodex = path.join(fakeBin, "codex");
      const previousCodexHome = process.env.CODEX_HOME;
      const previousActorCommand = process.env.MIMETIC_CODEX_ACTOR_COMMAND;
      const previousPath = process.env.PATH;
      await mkdir(path.join(cwd, ".git"), { recursive: true });
      await writeFile(path.join(cwd, ".git/HEAD"), "ref: refs/heads/main\n", "utf8");
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        path.join(codexHome, "config.toml"),
        `[projects."${cwd.replace(/["\\]/g, "\\$&")}"]\ntrust_level = "trusted"\n`,
        "utf8"
      );
      await writeFile(
        fakeCodex,
        "#!/usr/bin/env sh\nprintf 'fake exact trusted codex tui started\\n'\nprintf 'MIMETIC_ACTOR_VERDICT=passed MIMETIC_ACTOR_NONCE=%s\\n' \"$MIMETIC_ACTOR_VERDICT_NONCE\"\n",
        "utf8"
      );
      await chmod(fakeCodex, 0o755);
      delete process.env.MIMETIC_CODEX_ACTOR_COMMAND;
      process.env.CODEX_HOME = codexHome;
      process.env.PATH = previousPath ? `${fakeBin}${path.delimiter}${previousPath}` : fakeBin;

      try {
        const result = await runDryRun({
          cwd,
          actor: "codex-tui",
          runId: "codex-exact-trusted-root",
          simCount: 1,
          timeoutMs: 5_000
        });

        expect(result.ok).toBe(true);

        const bundle = JSON.parse(
          await readFile(path.join(cwd, ".mimetic/runs/codex-exact-trusted-root/run.json"), "utf8")
        ) as {
          events: Array<{ type: string }>;
          review: { verdict: string };
          streams: Array<{ status: string; terminal: { tail: string } }>;
        };
        expect(bundle.review.verdict).toBe("pass");
        expect(bundle.streams[0]?.status).toBe("passed");
        expect(bundle.streams[0]?.terminal.tail).toContain("fake exact trusted codex tui started");
        expect(bundle.events.map((event) => event.type)).toContain("actor.spawned");
        expect(bundle.events.map((event) => event.type)).not.toContain("actor.preflight.blocked");
      } finally {
        if (previousCodexHome === undefined) {
          delete process.env.CODEX_HOME;
        } else {
          process.env.CODEX_HOME = previousCodexHome;
        }
        if (previousActorCommand === undefined) {
          delete process.env.MIMETIC_CODEX_ACTOR_COMMAND;
        } else {
          process.env.MIMETIC_CODEX_ACTOR_COMMAND = previousActorCommand;
        }
        if (previousPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = previousPath;
        }
      }
    });
  });

  it("exposes run and verify through the Commander CLI", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runCli([
        "run",
        "--dry-run",
        "--run-id",
        "dryrun-cli",
        "--cwd",
        cwd,
        "--json"
      ]);
      expect(run.exitCode).toBe(0);
      const runResult = JSON.parse(run.stdout) as { ok: boolean; runId: string };
      expect(runResult.ok).toBe(true);
      expect(runResult.runId).toBe("dryrun-cli");

      const verify = await runCli(["verify", "--run", "latest", "--cwd", cwd, "--json"]);
      expect(verify.exitCode).toBe(0);
      const verifyResult = JSON.parse(verify.stdout) as { ok: boolean };
      expect(verifyResult.ok).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Verify hardening: the independent verifier upholds invariant 4 on its own.
// It re-derives the producer-side no-engagement judgment from bundle data
// alone (bundle.mode + the provider-neutral actor trace) instead of trusting
// the producer's self-attested verdict, and it surfaces the raw-screenshot
// posture so ok: true never reads as "share-ready". Fixtures are built with
// the real producer's bundle builder so the shape tracks the producer.
// ---------------------------------------------------------------------------

function cuaActorTrace(args: {
  screenshots?: ActorTrace["redaction"]["screenshots"];
  counts?: Record<string, number>;
  items?: ActorTrace["items"];
}): ActorTrace {
  return {
    schema: ACTOR_TRACE_SCHEMA,
    provider: "openai-responses-cu",
    protocol: "cua-loop",
    lane: "computer-use",
    persona: { id: "first-time-visitor", traitsApplied: [], promptDigest: "digest" },
    redaction: {
      status: "passed",
      screenshots: args.screenshots ?? "blurred",
      notes: "synthetic public-safe test trace"
    },
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:05.000Z",
    durationMs: 5_000,
    status: "passed",
    completionReason: "goal_satisfied",
    reason: "model reported a natural endpoint with no further action",
    ids: { model: "computer-use-preview" },
    counts: args.counts ?? { turns: 1, actions: 0, screenshots: 0, reasonings: 0, messages: 0, idleTurns: 0, noProgressTurns: 0 },
    items: args.items ?? [],
    capabilities: {
      headless: true,
      structuredTrace: true,
      lanes: ["computer-use"],
      producesScreenshots: true,
      byoModel: false,
      preGrantableApprovals: false,
      inProcessTools: false,
      license: "proprietary"
    }
  };
}

async function writeCuaRunFixture(
  cwd: string,
  runId: string,
  args: { dryRun: boolean; trace?: ActorTrace }
): Promise<void> {
  const session: CuaLoopResult | undefined = args.trace
    ? {
        status: args.trace.status,
        completionReason: args.trace.completionReason,
        reason: args.trace.reason,
        trace: args.trace
      }
    : undefined;
  const bundle = buildCuaBundle({
    actorId: "openai-computer-use",
    appUrl: "http://127.0.0.1:3000/",
    createdAt: "2026-01-01T00:00:00.000Z",
    dryRun: args.dryRun,
    labId: "verify-hardening-proof",
    mission: "Explore the app and stop.",
    persona: { id: "first-time-visitor", traitsApplied: [], promptDigest: "digest" },
    resolution: [1440, 960],
    runId,
    screenshots: [],
    ...(session ? { session, traceArtifactPath: "actor.json" } : {}),
    source: await buildRunSource({ cwd, mimeticSource: "present", packageName: "mimetic-cli" })
  });
  const runDir = path.join(cwd, ".mimetic", "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "run.json"), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  await writeFile(path.join(runDir, "review.json"), `${JSON.stringify(bundle.review, null, 2)}\n`, "utf8");
  await writeFile(path.join(runDir, "review.md"), `# ${bundle.scenario.title}\n\n- verdict: ${bundle.review.verdict}\n`, "utf8");
  await writeFile(path.join(runDir, "events.ndjson"), `${bundle.events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  if (session) {
    await writeFile(path.join(runDir, "actor.json"), `${JSON.stringify(session.trace, null, 2)}\n`, "utf8");
  }
}

describe("verify hardening (no-engagement + screenshot posture)", () => {
  it("FAILS a live goal_satisfied bundle whose actor trace has zero actions and zero messages (hollow run)", async () => {
    await withFixtureCopy(async (cwd) => {
      // Shape mirrors the preserved pre-0.6.1 hollow-run bundles: mode live, status passed,
      // completionReason goal_satisfied, counts and items empty of actions and messages.
      await writeCuaRunFixture(cwd, "hollow-live-regression", { dryRun: false, trace: cuaActorTrace({}) });

      const verify = await verifyRun(cwd, "hollow-live-regression");
      expect(verify.ok).toBe(false);
      expect(verify.error?.code).toBe("MIMETIC_INVALID_RUN_BUNDLE");
      const check = verify.checks.find((entry) => entry.name === "actor engagement");
      expect(check?.ok).toBe(false);
      expect(check?.message).toContain("zero actions and zero messages");
      // Blurred screenshots carry no raw-posture warning; the failure stands on its own.
      expect(verify.warnings).toEqual([]);
    });
  });

  it("passes an engaged live bundle and surfaces raw screenshots as a warning, not a failure", async () => {
    await withFixtureCopy(async (cwd) => {
      await writeCuaRunFixture(cwd, "raw-posture-live", {
        dryRun: false,
        trace: cuaActorTrace({
          screenshots: "raw",
          counts: { turns: 2, actions: 1, screenshots: 0, reasonings: 0, messages: 1, idleTurns: 0, noProgressTurns: 0 },
          items: [
            { id: "action-001", kind: "ui_action", lifecycle: "completed", title: "click (11, 22)" },
            { id: "message-001", kind: "message", lifecycle: "completed", title: "message", text: "Done." }
          ]
        })
      });

      const verify = await verifyRun(cwd, "raw-posture-live");
      expect(verify.ok).toBe(true);
      expect(verify.checks.find((entry) => entry.name === "actor engagement")?.ok).toBe(true);
      expect(verify.warnings).toHaveLength(1);
      expect(verify.warnings[0]).toContain("FULL-FIDELITY (raw)");
      expect(verify.warnings[0]).toContain("NOT publish-safe");

      // The CLI must show the posture in BOTH output modes.
      const json = await runCli(["verify", "--run", "raw-posture-live", "--cwd", cwd, "--json"]);
      expect(json.exitCode).toBe(0);
      expect((JSON.parse(json.stdout) as { warnings: string[] }).warnings[0]).toContain("FULL-FIDELITY (raw)");
      const human = await runCli(["verify", "--run", "raw-posture-live", "--cwd", cwd]);
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toContain("warning: Screenshots are FULL-FIDELITY (raw)");
    });
  });

  it("a single message with zero actions is engagement (look-and-report missions stay valid)", async () => {
    await withFixtureCopy(async (cwd) => {
      await writeCuaRunFixture(cwd, "message-only-live", {
        dryRun: false,
        trace: cuaActorTrace({
          counts: { turns: 1, actions: 0, screenshots: 0, reasonings: 0, messages: 1, idleTurns: 0, noProgressTurns: 0 },
          items: [{ id: "message-001", kind: "message", lifecycle: "completed", title: "message", text: "The heading reads: Example." }]
        })
      });

      const verify = await verifyRun(cwd, "message-only-live");
      expect(verify.ok).toBe(true);
      expect(verify.checks.find((entry) => entry.name === "actor engagement")?.ok).toBe(true);
    });
  });

  it("keeps passing dry-run/contract bundles that carry zero actions by design", async () => {
    await withFixtureCopy(async (cwd) => {
      await writeCuaRunFixture(cwd, "dryrun-contract-cua", { dryRun: true });

      const verify = await verifyRun(cwd, "dryrun-contract-cua");
      expect(verify.ok).toBe(true);
      expect(verify.checks.every((entry) => entry.ok)).toBe(true);
      expect(verify.warnings).toEqual([]);
    });
  });
});
