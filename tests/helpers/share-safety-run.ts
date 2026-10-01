// A computer-use dry run that verifies share_ready until a test adds a file to its folder, and a
// safe-mode run library to check what serve hands out.
import path from "node:path";

import { parseLabConfig } from "../../src/lab/config.js";
import { runLab } from "../../src/lab/engine.js";
import { LAB_CONFIG_SCHEMA, type LabConfig } from "../../src/lab/types.js";
import { serveObserverLibrary, type ServeLibraryServer } from "../../src/observer/serve.js";

export function shareSafetyDryRunConfig(): LabConfig {
  const parsed = parseLabConfig({
    schema: LAB_CONFIG_SCHEMA,
    id: "unscanned-artifact",
    title: "Unscanned adapter artifact",
    subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
    actors: [
      { type: "openai-computer-use", persona: "first-time-visitor", mission: "Explore and stop." },
    ],
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
    scenario: { mode: "dry-run" },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

export async function shareSafetyDryRun(cwd: string): Promise<{ runId: string; runDir: string }> {
  const outcome = await runLab(shareSafetyDryRunConfig(), { cwd });
  if (outcome.backend !== "cua") throw new Error(`unexpected backend ${outcome.backend}`);
  const runId = outcome.result.runId;
  return { runId, runDir: path.join(cwd, ".humanish", "runs", runId) };
}

export async function startSafeLibrary(cwd: string): Promise<ServeLibraryServer> {
  const started = await serveObserverLibrary(cwd, {
    port: 0,
    safe: true,
    expose: false,
    edgeAuthed: false,
  });
  if (!started.ok) throw new Error(started.error.message);
  return started.server;
}
