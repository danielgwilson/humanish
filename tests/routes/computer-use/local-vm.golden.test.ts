import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CuaAction, CuaExecutor } from "../../../src/actors/computer-use/loop.js";
import type { FetchLike } from "../../../src/actors/computer-use/openai-provider.js";
import { runCuaActorSession } from "../../../src/actors/computer-use/actor.js";
import { runLab } from "../../../src/run-lab.js";
import type { LabConfig } from "../../../src/lab/types.js";
import { ownDesktopAllocation } from "../../../src/substrates/desktop-session.js";
import type { LocalFirecrackerDesktop } from "../../../src/substrates/local/firecracker-desktop.js";
import { automaticAnalysisBoundary } from "../../helpers/automatic-analysis-boundary.js";
import { captureStderr, runDirSnapshot } from "../../helpers/run-golden.js";

// The Firecracker VM and the runtime image are the only fakes: the study, its desktop lane, the
// participant loop and the bundle are the real local route.
const seams = vi.hoisted(() => ({
  actions: [] as CuaAction[],
  released: [] as string[],
}));
vi.mock("../../../src/substrates/local/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/substrates/local/runtime.js")>()),
  prepareLocalRuntime: async () => ({
    image: "synthetic-runtime-image",
    runtimeRevision: "synthetic-runtime-revision",
  }),
}));
vi.mock("../../../src/substrates/local/firecracker-desktop.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/substrates/local/firecracker-desktop.js")
  >()),
  createLocalFirecrackerDesktop: async (): Promise<LocalFirecrackerDesktop> => {
    const session = ownDesktopAllocation({
      resourceId: "fake-vm-001",
      release: async () => {
        seams.released.push("fake-vm-001");
        return { status: "released", reason: "terminated" };
      },
    }).open(fakeVmExecutor());
    return {
      ...session,
      finishRecording: async () => {
        throw new Error("This fake VM records nothing.");
      },
    };
  },
}));

function framePng(seed: number): Buffer {
  const png = new PNG({ width: 16, height: 16 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = (seed * 37 + i) % 256;
    png.data[i + 1] = (seed * 89 + i) % 256;
    png.data[i + 2] = (seed * 13 + i) % 256;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** A desktop whose frame changes with each action, so every turn shows progress. */
function fakeVmExecutor(): CuaExecutor {
  return {
    stallRecovery: "fail_closed",
    observe: async () => ({
      screenshot: framePng(seams.actions.length),
      stateSignature: `frame-${seams.actions.length}`,
    }),
    execute: async (action) => {
      seams.actions.push(action);
    },
  };
}

function scriptedFetch(responses: unknown[]): FetchLike {
  let i = 0;
  return async () => {
    const value = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(value),
      json: async () => value,
    };
  };
}

const TWO_TURN_SESSION = [
  {
    id: "resp_1",
    output: [{ type: "computer_call", call_id: "c1", actions: [{ type: "click", x: 11, y: 22 }] }],
  },
  {
    id: "resp_2",
    output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }],
  },
];

function localVmConfig(): LabConfig {
  return {
    schema: "humanish.lab.v2",
    id: "local-vm-golden",
    subject: { source: "app-url", appUrl: "http://127.0.0.1:4173/" },
    actors: [{ type: "openai-computer-use", mission: "Save a synthetic note." }],
    execution: { target: "local", timeoutMs: 60_000 },
    scenario: { mode: "live" },
  };
}

// Characterization: the complete run directory of a live local VM study on a fake VM, pinned so a
// refactor of the local route, its desktop lane or bundle assembly shows up as a diff.
// Regenerate with `pnpm vitest run tests/routes/computer-use/local-vm.golden.test.ts -u`.
describe("local VM run directory golden", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-local-vm-golden-"));
    seams.actions.length = 0;
    seams.released.length = 0;
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("live study with one participant on a fake VM", async () => {
    let clock = 0;
    const stderr = captureStderr();
    const outcome = await runLab(
      localVmConfig(),
      {
        cwd,
        automaticAnalysis: { run: automaticAnalysisBoundary() },
        env: { OPENAI_API_KEY: "test-openai-key" },
      },
      {
        now: () => (clock += 30_000),
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
      },
    ).finally(stderr.stop);
    expect(seams.actions).toEqual([{ kind: "click", x: 11, y: 22, button: "left" }]);
    expect(seams.released).toEqual(["fake-vm-001"]);
    const runId = outcome.result.runId;
    if (!runId) throw new Error("the run wrote no bundle");
    const snapshot = await runDirSnapshot(path.join(cwd, ".humanish", "runs", runId), {
      result: outcome.result,
      stderr: stderr.text(),
      replace: [
        [runId, "[run]"],
        [cwd, "[cwd]"],
      ],
    });
    await expect(`${JSON.stringify(snapshot, null, 2)}\n`).toMatchFileSnapshot(
      "../../golden/routes/computer-use-local-vm-live.json",
    );
  });
});
