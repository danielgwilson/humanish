import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseLabConfig } from "../../src/lab/config.js";
import { runLab } from "../../src/lab/engine.js";
import { LAB_CONFIG_SCHEMA, type LabConfig } from "../../src/lab/types.js";
import type { BrowserLabScoringContext } from "../../src/lab/adapter-extension.js";
import { serveObserverLibrary, type ServeLibraryServer } from "../../src/observer/serve.js";
import type { RunAdapterArtifact } from "../../src/run/bundle.js";
import { verifyRun } from "../../src/verify/verify.js";

// Concatenated so this file never holds a secret-shaped literal; the text scan detects it.
const SYNTHETIC_SECRET = "sk-" + "syntheticvalue1234567890abcdef";
const PNG_4X4 = PNG.sync.write(new PNG({ width: 4, height: 4 }));
const STATE = Buffer.from(`${JSON.stringify({ env: `OPENAI_API_KEY=${SYNTHETIC_SECRET}` })}\n`);

interface AdapterFile {
  path: string;
  kind: RunAdapterArtifact["kind"];
  bytes: Buffer;
}

// verify reads extensions, not archive structure, so the zip case is the stored bytes behind a
// zip local-file signature.
const CASES: Record<string, AdapterFile> = {
  gzip: { path: "adapter/state.json.gz", kind: "state", bytes: gzipSync(STATE) },
  zip: {
    path: "adapter/state.zip",
    kind: "filesystem",
    bytes: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), STATE]),
  },
  png: { path: "adapter/product-state.png", kind: "screenshot", bytes: PNG_4X4 },
};

function dryRunConfig(): LabConfig {
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

/** A dry run whose adapter scorer writes one artifact into the run directory. */
async function runWithAdapterFile(cwd: string, file: AdapterFile): Promise<string> {
  const outcome = await runLab(dryRunConfig(), {
    cwd,
    scorer: {
      deriveArtifacts: async (ctx: BrowserLabScoringContext) => {
        await mkdir(path.join(ctx.runDir, path.dirname(file.path)), { recursive: true });
        await writeFile(path.join(ctx.runDir, file.path), file.bytes);
        return [
          {
            schema: "humanish.adapter-artifact.v1",
            namespace: "example",
            label: "Product state",
            path: file.path,
            kind: file.kind,
            note: "Synthetic adapter output.",
          },
        ];
      },
    },
  });
  if (outcome.backend !== "cua") throw new Error(`unexpected backend ${outcome.backend}`);
  return outcome.result.runId;
}

describe("verify does not grade an unreadable adapter artifact share_ready", () => {
  let cwd: string;
  const runIds = new Map<string, string>();

  beforeAll(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-unscanned-"));
    for (const [name, file] of Object.entries(CASES)) {
      runIds.set(name, await runWithAdapterFile(cwd, file));
    }
    runIds.set(
      "text",
      await runWithAdapterFile(cwd, {
        path: "adapter/state.json",
        kind: "state",
        bytes: Buffer.from('{"status":"ok"}\n'),
      }),
    );
    runIds.set(
      "text-secret",
      await runWithAdapterFile(cwd, { path: "adapter/state.json", kind: "state", bytes: STATE }),
    );
  }, 60_000);

  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it.each(Object.entries(CASES))(
    "grades a run with a %s adapter artifact local_only and names the file",
    async (name, file) => {
      const verified = await verifyRun(cwd, runIds.get(name)!);
      expect(verified.ok).toBe(true);
      expect(verified.shareSafety.status).toBe("local_only");
      const reason = verified.shareSafety.reasons.find(
        (candidate) => candidate.code === "UNSCANNED_ARTIFACT",
      );
      expect(reason?.message).toContain(file.path);
    },
  );

  it("keeps a text adapter artifact share_ready and blocks one that holds the secret", async () => {
    const clean = await verifyRun(cwd, runIds.get("text")!);
    expect(clean.shareSafety).toEqual({ status: "share_ready", reasons: [] });
    const leaked = await verifyRun(cwd, runIds.get("text-secret")!);
    expect(leaked.shareSafety.status).toBe("blocked");
  });

  describe("serve --safe", () => {
    let server: ServeLibraryServer;

    beforeAll(async () => {
      const started = await serveObserverLibrary(cwd, {
        port: 0,
        safe: true,
        expose: false,
        edgeAuthed: false,
      });
      if (!started.ok) throw new Error(started.error.message);
      server = started.server;
    });

    afterAll(async () => {
      await server.close();
    });

    it.each(Object.entries(CASES))("returns 404 for the %s artifact's run", async (name, file) => {
      const runId = runIds.get(name)!;
      for (const route of [file.path, "observer/index.html", "run.json"]) {
        const response = await fetch(new URL(`/_humanish/runs/${runId}/${route}`, server.url));
        expect(response.status).toBe(404);
      }
    });

    it("still serves a share_ready run's adapter artifact", async () => {
      const response = await fetch(
        new URL(`/_humanish/runs/${runIds.get("text")!}/adapter/state.json`, server.url),
      );
      expect(response.status).toBe(200);
    });
  });
});
