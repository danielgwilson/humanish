import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import type { ObserverData } from "../src/observer-data.js";
import { runDryRun } from "../src/run.js";
import { RUN_STATUS_SCHEMA } from "../src/run-status.js";

it("observe follows selected-run evidence and lifecycle over protected HTTP, then closes on Ctrl-C", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-observe-command-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    for (const runId of ["selected", "other"]) {
      expect((await runDryRun({ cwd, dryRun: true, runId })).ok).toBe(true);
    }
    const runRoot = path.join(cwd, ".humanish", "runs", "selected");
    const bundlePath = path.join(runRoot, "run.json");
    const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
    child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.resolve("src/cli.ts"), "observe", "--cwd", cwd, "--run", "selected", "--no-open", "--json"], {
      env: { ...process.env, HUMANISH_STRICT_KEYS: "1", HUMANISH_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const processUnderTest = child;
    let stdout = "";
    let stderr = "";
    processUnderTest.stdout!.setEncoding("utf8");
    processUnderTest.stderr!.setEncoding("utf8");
    processUnderTest.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      processUnderTest.once("error", reject);
      processUnderTest.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`observe did not attach: ${stderr}`)), 15_000);
      processUnderTest.stdout!.on("data", (chunk: string) => {
        stdout += chunk;
        try {
          const result = JSON.parse(stdout) as { ok: boolean; observerUrl?: string };
          if (result.ok && result.observerUrl) {
            clearTimeout(timeout);
            resolve(result.observerUrl);
          }
        } catch { /* Wait for the complete JSON envelope. */ }
      });
      void exited.then(({ code, signal }) => {
        clearTimeout(timeout);
        reject(new Error(`observe exited before attach (${code ?? signal}): ${stderr}`));
      }, reject);
    });
    for (const pathname of ["/observer/index.html", "/observer/observer-data.json", "/missing"]) {
      const response = await fetch(new URL(pathname, url));
      expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      await response.arrayBuffer();
    }
    const getData = async () => await (await fetch(new URL("observer-data.json", url))).json() as ObserverData;
    expect((await getData()).runtime?.state).toBe("finished");
    bundle.streams[0].label = "Updated saved capture";
    bundle.streams[0].embed = { kind: "iframe", url: "https://desktop.example/view", runtimeDesktop: true };
    await writeFile(bundlePath, JSON.stringify(bundle));
    const now = new Date().toISOString();
    await writeFile(path.join(runRoot, "status.json"), JSON.stringify({ schema: RUN_STATUS_SCHEMA, runId: "selected", state: "running", mode: "dry-run", pid: 999999, startedAt: now, updatedAt: now }));
    const updated = await getData();
    expect(updated.streams[0]?.label).toBe("Updated saved capture");
    expect(updated.streams[0]?.embed?.runtimeDesktop).toBeUndefined();
    expect(updated.runtime?.state).toBe("running");
    const history = await (await fetch(new URL("/_humanish/history.json", url))).json() as { runs: Array<{ runId: string }> };
    expect(history.runs.map((run) => run.runId)).toEqual(["selected"]);
    expect((await fetch(new URL("/_humanish/runs/other/observer/index.html", url))).status).toBe(404);
    processUnderTest.kill("SIGINT");
    const ended = await Promise.race([exited, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("observe did not close after SIGINT")), 5_000);
      timer.unref();
      void exited.finally(() => clearTimeout(timer));
    })]);
    expect(ended).toEqual({ code: 130, signal: null });
    expect(stderr).toContain("observe stopped");
    expect(JSON.parse(stdout).ok).toBe(true);
    await expect(fetch(url)).rejects.toThrow();
  } finally {
    child?.kill("SIGKILL");
    await rm(cwd, { recursive: true, force: true });
  }
}, 25_000);
