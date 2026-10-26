// A hosted participant's zoom frames, on fake hosted desktops ($0). The image a
// zoom showed the participant is a frame of the run bundle beside its screenshots: written under
// screenshots/, kept as lossless WebP or as a blurred PNG under the study's redaction, listed in
// the stream's screenshots, and checked by verify like every other frame.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runCuaActorSession } from "../../../src/actors/computer-use/actor.js";
import type { CuaProvider } from "../../../src/actors/computer-use/loop.js";
import { OPENAI_RESPONSES_CU_CAPABILITIES } from "../../../src/actors/computer-use/openai-provider.js";
import { decodeWebp } from "../../../src/evidence/webp.js";
import { runStudyWith } from "../../../src/run-study.js";
import { loadRunBundle } from "../../../src/run/locate.js";
import { parseStudy } from "../../../src/study/config.js";
import { verifyRun } from "../../../src/verify/verify.js";
import { lab } from "../../admission/fixtures.js";
import { makeFanoutModule } from "../../helpers/fanout-desktop.js";
import { makeTestTempDir } from "../../helpers/temp-dir.js";

const ENV = { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" };

/** A participant that zooms on part of the 16x16 fake screen, then ends. */
function zoomingProvider(): CuaProvider {
  let turns = 0;
  return {
    id: "synthetic-provider",
    requiresFrame: true,
    capabilities: OPENAI_RESPONSES_CU_CAPABILITIES,
    nextTurn: async () => {
      turns += 1;
      return turns === 1
        ? {
            actions: [{ kind: "zoom", region: { x: 2, y: 3, width: 8, height: 4 } }],
            pendingSafetyChecks: [],
            done: false,
          }
        : { actions: [], pendingSafetyChecks: [], done: true, message: "Read it." };
    },
  };
}

async function runZooming(policies: Record<string, unknown> = {}) {
  const parsed = parseStudy(
    lab("cuAppUrl", {
      mode: "live",
      execution: { target: "e2b-desktop", timeoutMs: 60_000 },
      review: { analysis: false },
      ...(Object.keys(policies).length === 0 ? {} : { policies }),
    }),
  );
  if (!parsed.ok) throw new Error(parsed.error.message);
  const handle = makeFanoutModule({});
  const cwd = await makeTestTempDir("humanish-zoom-evidence-run-");
  const outcome = await runStudyWith(
    parsed.config,
    { cwd, env: ENV, open: false },
    {
      desktopModule: async () => handle.module,
      subjectPhaseSink: () => undefined,
      runSession: async (session) =>
        runCuaActorSession({ ...session, provider: zoomingProvider() }),
    },
  );
  if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
  const loaded = await loadRunBundle(cwd, outcome.result.runId);
  if (loaded === null) throw new Error("the run wrote no bundle");
  const [stream] = loaded.bundle.streams;
  if (stream?.actor === undefined) throw new Error("the run recorded no participant");
  const items = stream.actor.items;
  return { cwd, runId: outcome.result.runId, runDir: loaded.runDir, stream, items };
}

describe("a hosted participant's zoom frame in the run bundle", () => {
  it("is a lossless WebP of the zoomed region beside the screenshots, and verify passes", async () => {
    const { cwd, runId, runDir, stream, items } = await runZooming();
    const zoom = items.find((item) => item.region !== undefined);
    expect(zoom).toMatchObject({
      kind: "ui_action",
      title: "zoom 8x4 at (2, 3)",
      region: { x: 2, y: 3, width: 8, height: 4 },
      screenshotRef: { path: "screenshots/zoom-001.webp", redaction: "none" },
    });
    const image = await decodeWebp(await readFile(path.join(runDir, zoom!.screenshotRef!.path)));
    expect([image.width, image.height]).toEqual([8, 4]);
    expect(stream.artifacts).toContainEqual(
      expect.objectContaining({ kind: "screenshot", path: "screenshots/zoom-001.webp" }),
    );
    const verified = await verifyRun(cwd, runId);
    expect(verified.ok).toBe(true);
  });

  it("is blurred like the screenshots when the study blurs them", async () => {
    const { cwd, runId, items } = await runZooming({ redactScreenshots: true });
    const zoom = items.find((item) => item.region !== undefined);
    expect(zoom?.screenshotRef).toEqual({ path: "screenshots/zoom-001.png", redaction: "blurred" });
    const verified = await verifyRun(cwd, runId);
    expect(verified.ok).toBe(true);
    expect(verified.shareSafety.reasons.map((reason) => reason.code)).not.toContain(
      "RAW_SCREENSHOTS",
    );
  });
});
