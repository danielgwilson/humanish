import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runStudyWith } from "../../../src/run-study.js";
import { STUDY_SCHEMA, type StudyConfig } from "../../../src/study/types.js";
import { localCapacity, type LocalCapacity } from "../../../src/substrates/local/capacity.js";
import { libraryConfig } from "../../helpers/library-config.js";
import { captureStderr } from "../../helpers/run-golden.js";
import { ownDesktopAllocation } from "../../../src/substrates/desktop-session.js";
import { ComputerUseExecutorError } from "../../../src/actors/computer-use/executor-error.js";
import type { CuaExecutor } from "../../../src/actors/computer-use/loop.js";
import type { ParticipantDesktop } from "../../../src/routes/computer-use/participant-desktop.js";
import type { LocalVmInput } from "../../../src/routes/computer-use/types.js";
import { prepareLocalVmRun } from "../../../src/routes/computer-use/local-vm.js";

const GiB = 1024 ** 3;
const createDesktop = vi.hoisted(() => vi.fn());
vi.mock("../../../src/substrates/local/firecracker-desktop.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/substrates/local/firecracker-desktop.js")
  >()),
  createLocalFirecrackerDesktop: createDesktop,
}));

function localStudy(execution: Record<string, unknown> = {}): StudyConfig {
  return libraryConfig({
    schema: STUDY_SCHEMA,
    id: "local-three",
    route: "computer-use",
    mode: "live",
    subject: { source: "app-url", appUrl: "http://127.0.0.1:4173/" },
    actor: { type: "openai-computer-use", mission: "Save a synthetic note." },
    participants: 3,
    execution: { target: "local", timeoutMs: 60_000, ...execution },
  });
}

/** A local VM of this capacity whose desktops fail to start, so an admitted run stops there. */
function localVm(capacity: LocalCapacity) {
  const desktop = vi.fn((): ParticipantDesktop => ({
    prepare: async () => {
      throw new Error("synthetic desktop start failure");
    },
    openSession: async () => {
      throw new Error("synthetic desktop start failure");
    },
    finalize: async () => undefined,
    snapshot: () => ({
      released: false,
      streamUrlPresent: false,
      stateStepRecords: [],
      phaseRecords: [],
    }),
  }));
  const input: LocalVmInput = {
    desktop,
    capacity: async () => capacity,
    analysisRefusal: () => undefined,
  };
  return { desktop, input };
}

describe("local desktop admission", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-local-capacity-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("refuses a study that needs more desktops than the Lima VM holds, before any desktop", async () => {
    const vm = localVm(localCapacity("lima-vm", { memoryBytes: 8 * GiB, cpus: 6 }));
    const runSession = vi.fn();
    const stderr = captureStderr();
    const outcome = await runStudyWith(
      localStudy(),
      { cwd, env: { OPENAI_API_KEY: "test-openai-key" }, localVm: vm.input },
      { runSession },
    ).finally(stderr.stop);

    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error?.code).toBe("HUMANISH_COMPUTER_USE_LOCAL_CAPACITY_EXCEEDED");
    const message = outcome.result.error?.message ?? "";
    // How many it needs, how many fit and why.
    expect(message).toContain("3 participant desktops at once");
    expect(message).toContain("holds 2");
    expect(message).toContain("it has 8 GiB");
    expect(message).toContain("each desktop reserves 3 GiB");
    // What to do, cloud desktops first.
    expect(message).toContain("source: local-tree");
    expect(message).toContain("target: e2b-desktop");
    expect(message).toContain("runtime setup --memory 10");
    expect(message).toContain("concurrency: 2");
    expect(message.indexOf("e2b-desktop")).toBeLessThan(message.indexOf("runtime setup"));
    expect(vm.desktop).not.toHaveBeenCalled();
    expect(runSession).not.toHaveBeenCalled();
  });

  it("admits the same study when it runs no more desktops at once than fit", async () => {
    const vm = localVm(localCapacity("lima-vm", { memoryBytes: 8 * GiB, cpus: 6 }));
    const stderr = captureStderr();
    const outcome = await runStudyWith(
      localStudy({ concurrency: 2 }),
      { cwd, env: { OPENAI_API_KEY: "test-openai-key" }, localVm: vm.input },
      { runSession: vi.fn() },
    ).finally(stderr.stop);

    expect(outcome.result.error?.code).not.toBe("HUMANISH_COMPUTER_USE_LOCAL_CAPACITY_EXCEEDED");
    expect(vm.desktop).toHaveBeenCalled();
  });

  it("warns on a Linux host that holds fewer desktops than the study runs, and starts it", async () => {
    const vm = localVm(localCapacity("linux-host", { memoryBytes: 7 * GiB, cpus: 8 }));
    const stderr = captureStderr();
    const outcome = await runStudyWith(
      localStudy(),
      { cwd, env: { OPENAI_API_KEY: "test-openai-key" }, localVm: vm.input },
      { runSession: vi.fn() },
    ).finally(stderr.stop);

    expect(outcome.result.error?.code).not.toBe("HUMANISH_COMPUTER_USE_LOCAL_CAPACITY_EXCEEDED");
    expect(vm.desktop).toHaveBeenCalled();
    expect(stderr.text()).toContain("this machine holds 2");
  });
});

describe("a local desktop killed for memory", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-local-oom-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("says in the participant's outcome, the review and the run's error that memory ran out", async () => {
    createDesktop.mockImplementation(async () => ({
      ...ownDesktopAllocation({
        resourceId: "d".repeat(12),
        release: async () => ({ status: "released", reason: "terminated" }),
      }).open({ stallRecovery: "fail_closed" } as unknown as CuaExecutor),
      finishRecording: async () => {
        throw new Error("This fake desktop records nothing.");
      },
      killedForMemory: async () => true,
    }));
    // The study's own local VM, with a prepared runtime image so none is pulled, and a fixed size.
    const study = localStudy({ concurrency: 1 });
    const prepared = prepareLocalVmRun({
      cwd,
      config: study,
      assets: { image: "synthetic-image", runtimeRevision: "synthetic-revision" },
    });
    const stderr = captureStderr();
    const outcome = await runStudyWith(
      study,
      {
        cwd,
        env: { OPENAI_API_KEY: "test-openai-key" },
        localVm: {
          ...prepared.localVm,
          capacity: async () => localCapacity("lima-vm", { memoryBytes: 13 * GiB, cpus: 8 }),
        },
      },
      {
        // The browser closed under the participant: the desktop's transport failed mid-session.
        runSession: async () => {
          throw new ComputerUseExecutorError("transport_failed", "outcome_uncertain");
        },
      },
    ).finally(stderr.stop);
    await prepared.close();

    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error?.code).toBe("HUMANISH_COMPUTER_USE_DESKTOP_OUT_OF_MEMORY");
    expect(outcome.result.error?.message).toContain("ran out of memory");
    const result = outcome.result as {
      lanes?: { error?: { code: string; message: string } }[];
      participants?: { error?: { code: string; message: string } }[];
    };
    const participant = (result.participants ?? result.lanes)?.[0];
    expect(participant?.error).toMatchObject({
      code: "HUMANISH_COMPUTER_USE_DESKTOP_OUT_OF_MEMORY",
      message: expect.stringContaining("ran out of memory"),
    });
    const review = await readFile(
      path.join(cwd, ".humanish", "runs", outcome.result.runId!, "review.md"),
      "utf8",
    );
    expect(review).toContain("ran out of memory");
  });
});
