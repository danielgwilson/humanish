// What a registered screenshot must prove before a run grades share_ready: the PNG holds image
// data only, it sits where the harness writes frames, and a redaction claim covers it. Each case
// is a dry-run bundle whose first stream's trace registers one frame; the grade and `serve --safe`
// must agree.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ACTOR_TRACE_SCHEMA } from "../../src/actors/contract.js";
import { serveObserverLibrary, type ServeLibraryServer } from "../../src/observer/serve.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { verifyRun } from "../../src/verify/verify.js";
import { pngTextChunk, withPngChunk, withPngChunkData } from "../helpers/png-chunks.js";

// Concatenated so this file never holds a secret-shaped literal; the text scan detects it.
const SYNTHETIC_SECRET = "sk-" + "syntheticvalue1234567890abcdef";
const PNG_4X4 = PNG.sync.write(new PNG({ width: 4, height: 4 }));

interface FrameCase {
  /** Where the frame is written and what the trace's screenshotRef.path says. */
  path: string;
  bytes: Buffer;
  /** screenshotRef.redaction; undefined leaves the key out. */
  claim: unknown;
  /** The final trace's redaction.screenshots; undefined leaves redaction out. */
  posture: string | undefined;
  /** Register the frame on the partial live trace instead of the final one. */
  live?: boolean;
  grade: "share_ready" | "local_only" | "blocked";
  code?: string;
  message?: string;
}

const secretPng = (type: "tEXt" | "zTXt" | "iTXt") =>
  withPngChunk(PNG_4X4, type, pngTextChunk(type, `OPENAI_API_KEY=${SYNTHETIC_SECRET}`));
const SECRET_BYTES = Buffer.from(`OPENAI_API_KEY=${SYNTHETIC_SECRET}`);
// A full desktop-size frame: wider than any thumbnail the redactor writes.
const PNG_1280X720 = PNG.sync.write(new PNG({ width: 1280, height: 720 }));

/** A blurred-claim frame whose bytes carry the secret in an allowed chunk's payload. */
const allowedChunkCase = (type: string): FrameCase => ({
  path: "screenshots/frame.png",
  bytes: withPngChunk(PNG_4X4, type, SECRET_BYTES),
  claim: "blurred",
  posture: "blurred",
  grade: "local_only",
  code: "RAW_SCREENSHOTS",
});

const CASES: Record<string, FrameCase> = {
  "blurred frame (control)": {
    path: "screenshots/frame.png",
    bytes: PNG_4X4,
    claim: "blurred",
    posture: "blurred",
    grade: "share_ready",
  },
  "1d: blurred frame with a secret in a tEXt chunk": {
    path: "screenshots/frame.png",
    bytes: secretPng("tEXt"),
    claim: "blurred",
    posture: "blurred",
    grade: "blocked",
    code: "VERIFY_FAILED",
    message: "PNG carries a tEXt chunk",
  },
  "1d: blurred frame with a secret in a zTXt chunk": {
    path: "screenshots/frame.png",
    bytes: secretPng("zTXt"),
    claim: "blurred",
    posture: "blurred",
    grade: "blocked",
    code: "VERIFY_FAILED",
    message: "PNG carries a zTXt chunk",
  },
  "1d: blurred frame with a secret in an iTXt chunk": {
    path: "screenshots/frame.png",
    bytes: secretPng("iTXt"),
    claim: "blurred",
    posture: "blurred",
    grade: "blocked",
    code: "VERIFY_FAILED",
    message: "PNG carries a iTXt chunk",
  },
  "1c: trace registers an adapter-written PNG as blurred": {
    path: "adapter/frame.png",
    bytes: PNG_4X4,
    claim: "blurred",
    posture: "blurred",
    grade: "local_only",
    code: "UNSCANNED_ARTIFACT",
    message: "adapter/frame.png",
  },
  "2a: frame with no claim on a trace with no posture": {
    path: "screenshots/frame.png",
    bytes: PNG_4X4,
    claim: undefined,
    posture: undefined,
    grade: "local_only",
    code: "RAW_SCREENSHOTS",
  },
  "2b: frame claiming raw, outside the claim set, on a silent trace": {
    path: "screenshots/frame.png",
    bytes: PNG_4X4,
    claim: "raw",
    posture: undefined,
    grade: "local_only",
    code: "RAW_SCREENSHOTS",
  },
  "2b: frame claiming raw under a blurred posture": {
    path: "screenshots/frame.png",
    bytes: PNG_4X4,
    claim: "raw",
    posture: "blurred",
    grade: "local_only",
    code: "RAW_SCREENSHOTS",
  },
  "unclaimed frame on a live trace, which has no posture": {
    path: "screenshots/frame.png",
    bytes: PNG_4X4,
    claim: undefined,
    posture: undefined,
    live: true,
    grade: "local_only",
    code: "RAW_SCREENSHOTS",
  },
  ...Object.fromEntries(
    ["tRNS", "PLTE", "bKGD", "pHYs", "sBIT", "cHRM", "sRGB", "gAMA"].map((type) => [
      `1207 row 1: blurred claim, secret as the ${type} payload`,
      allowedChunkCase(type),
    ]),
  ),
  "1207 row 1b: secret as the IEND payload": {
    path: "screenshots/frame.png",
    bytes: withPngChunkData(PNG_4X4, "IEND", SECRET_BYTES),
    claim: "blurred",
    posture: "blurred",
    grade: "blocked",
    code: "VERIFY_FAILED",
    message: "PNG IEND chunk must be empty",
  },
  "1207 row 1b: secret after the 13 IHDR bytes": {
    path: "screenshots/frame.png",
    bytes: withPngChunkData(
      PNG_4X4,
      "IHDR",
      Buffer.concat([PNG_4X4.subarray(16, 29), SECRET_BYTES]),
    ),
    claim: "blurred",
    posture: "blurred",
    grade: "blocked",
    code: "VERIFY_FAILED",
    message: "PNG must start with a 13-byte IHDR chunk",
  },
  "1207 row 2: full-size frame claiming blurred": {
    path: "screenshots/frame.png",
    bytes: PNG_1280X720,
    claim: "blurred",
    posture: "blurred",
    grade: "local_only",
    code: "RAW_SCREENSHOTS",
  },
  "1207 row 2: full-size unclaimed frame under a blurred posture": {
    path: "screenshots/frame.png",
    bytes: PNG_1280X720,
    claim: undefined,
    posture: "blurred",
    grade: "local_only",
    code: "RAW_SCREENSHOTS",
  },
  "1207 row 2: frame claiming ocr_scrubbed, which no writer produces": {
    path: "screenshots/frame.png",
    bytes: PNG_4X4,
    claim: "ocr_scrubbed",
    posture: "blurred",
    grade: "local_only",
    code: "RAW_SCREENSHOTS",
  },
  "unclaimed frame under a blurred posture (bundles before per-frame claims)": {
    path: "screenshots/frame.png",
    bytes: PNG_4X4,
    claim: undefined,
    posture: "blurred",
    grade: "share_ready",
  },
};

/** Writes the frame and registers it on stream 0, replacing the dry run's actor. */
async function registerFrame(runDir: string, frame: FrameCase): Promise<void> {
  await mkdir(path.join(runDir, path.dirname(frame.path)), { recursive: true });
  await writeFile(path.join(runDir, frame.path), frame.bytes);
  const bundlePath = path.join(runDir, "run.json");
  const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as RunBundle;
  const screenshotRef = {
    path: frame.path,
    ...(frame.claim === undefined ? {} : { redaction: frame.claim }),
  };
  const items = [
    { id: "item-1", kind: "screenshot", lifecycle: "completed", title: "frame", screenshotRef },
  ];
  const stream = bundle.streams[0]!;
  if (frame.live) {
    delete stream.actor;
    Object.assign(stream, {
      liveActor: { schema: "humanish.live-actor.v1", updatedAt: "2026-10-01T00:00:00Z", items },
    });
  } else {
    Object.assign(stream, {
      actor: {
        schema: ACTOR_TRACE_SCHEMA,
        items,
        ...(frame.posture === undefined
          ? {}
          : { redaction: { status: "passed", screenshots: frame.posture, notes: "Synthetic." } }),
      },
    });
  }
  await writeFile(bundlePath, JSON.stringify(bundle));
}

const runIdOf = (index: number) => `screenshot-claim-${String(index).padStart(2, "0")}`;

describe("registered screenshot evidence and its redaction claim", () => {
  let cwd: string;

  beforeAll(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-screenshot-claims-"));
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    const frames = Object.values(CASES);
    for (const [index, frame] of frames.entries()) {
      await runDryRun({ cwd, dryRun: true, runId: runIdOf(index) });
      await registerFrame(path.join(cwd, ".humanish", "runs", runIdOf(index)), frame);
    }
  }, 60_000);

  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const entries = Object.entries(CASES).map(([name, frame], index) => ({
    name,
    frame,
    runId: runIdOf(index),
  }));

  it.each(entries)("$name grades $frame.grade", async ({ frame, runId }) => {
    const result = await verifyRun(cwd, runId);
    expect(result.shareSafety.status).toBe(frame.grade);
    if (frame.code !== undefined) {
      const reason = result.shareSafety.reasons.find((candidate) => candidate.code === frame.code);
      expect(reason).toBeDefined();
      if (frame.code === "VERIFY_FAILED") {
        const check = result.checks.find(
          (candidate) => candidate.name === "local evidence artifacts exist",
        );
        expect(check?.message).toContain(frame.message);
      } else if (frame.message !== undefined) {
        expect(reason?.message).toContain(frame.message);
      }
    }
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

    it.each(entries)(
      "$name: the frame is served only when share_ready",
      async ({ frame, runId }) => {
        const response = await fetch(new URL(`/_humanish/runs/${runId}/${frame.path}`, server.url));
        expect(response.status).toBe(frame.grade === "share_ready" ? 200 : 404);
        if (response.ok)
          expect(Buffer.from(await response.arrayBuffer()).includes(SYNTHETIC_SECRET)).toBe(false);
      },
    );
  });
});
