import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runStudyWith } from "../../../src/run-study.js";
import { STUDY_SCHEMA, type StudyConfig } from "../../../src/study/types.js";
import { localCapacity } from "../../../src/substrates/local/capacity.js";
import { libraryConfig } from "../../helpers/library-config.js";
import { captureStderr } from "../../helpers/run-golden.js";

const GiB = 1024 ** 3;
const seams = vi.hoisted(() => ({
  capacity: vi.fn(),
  createDesktop: vi.fn(),
  prepareRuntime: vi.fn(),
}));
vi.mock("../../../src/substrates/local/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/substrates/local/runtime.js")>()),
  prepareLocalRuntime: seams.prepareRuntime,
  localRuntimeCapacity: seams.capacity,
}));
vi.mock("../../../src/substrates/local/firecracker-desktop.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/substrates/local/firecracker-desktop.js")
  >()),
  createLocalFirecrackerDesktop: seams.createDesktop,
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

describe("local desktop admission", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-local-capacity-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("refuses a study that needs more desktops than the Lima VM holds, before any desktop", async () => {
    seams.capacity.mockResolvedValue(localCapacity("lima-vm", { memoryBytes: 8 * GiB, cpus: 6 }));
    const runSession = vi.fn();
    const stderr = captureStderr();
    const outcome = await runStudyWith(
      localStudy(),
      { cwd, env: { OPENAI_API_KEY: "test-openai-key" } },
      { runSession },
    ).finally(stderr.stop);

    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error?.code).toBe("HUMANISH_COMPUTER_USE_LOCAL_CAPACITY_EXCEEDED");
    const message = outcome.result.error?.message ?? "";
    // How many it needs, how many fit and why.
    expect(message).toContain("3 participant desktops at once");
    expect(message).toContain("holds 2");
    expect(message).toContain("8 GiB and 6 CPUs");
    expect(message).toContain("3 GiB and 2 CPUs");
    // What to do, cloud desktops first.
    expect(message).toContain("source: local-tree");
    expect(message).toContain("target: e2b-desktop");
    expect(message).toContain("runtime setup --memory 10 --cpus 6");
    expect(message).toContain("concurrency: 2");
    expect(message.indexOf("e2b-desktop")).toBeLessThan(message.indexOf("runtime setup"));
    expect(seams.prepareRuntime).not.toHaveBeenCalled();
    expect(seams.createDesktop).not.toHaveBeenCalled();
    expect(runSession).not.toHaveBeenCalled();
  });

  it("admits the same study when it runs no more desktops at once than fit", async () => {
    seams.capacity.mockResolvedValue(localCapacity("lima-vm", { memoryBytes: 8 * GiB, cpus: 6 }));
    seams.createDesktop.mockRejectedValue(new Error("synthetic desktop start failure"));
    seams.prepareRuntime.mockResolvedValue({ image: "synthetic", runtimeRevision: "synthetic" });
    const stderr = captureStderr();
    const outcome = await runStudyWith(
      localStudy({ concurrency: 2 }),
      { cwd, env: { OPENAI_API_KEY: "test-openai-key" } },
      { runSession: vi.fn() },
    ).finally(stderr.stop);

    expect(outcome.result.error?.code).not.toBe("HUMANISH_COMPUTER_USE_LOCAL_CAPACITY_EXCEEDED");
    expect(seams.createDesktop).toHaveBeenCalled();
  });

  it("warns on a Linux host that holds fewer desktops than the study runs, and starts it", async () => {
    seams.capacity.mockResolvedValue(
      localCapacity("linux-host", { memoryBytes: 7 * GiB, cpus: 8 }),
    );
    seams.createDesktop.mockRejectedValue(new Error("synthetic desktop start failure"));
    seams.prepareRuntime.mockResolvedValue({ image: "synthetic", runtimeRevision: "synthetic" });
    const stderr = captureStderr();
    const outcome = await runStudyWith(
      localStudy(),
      { cwd, env: { OPENAI_API_KEY: "test-openai-key" } },
      { runSession: vi.fn() },
    ).finally(stderr.stop);

    expect(outcome.result.error?.code).not.toBe("HUMANISH_COMPUTER_USE_LOCAL_CAPACITY_EXCEEDED");
    expect(seams.createDesktop).toHaveBeenCalled();
    expect(stderr.text()).toContain("this machine holds 2");
  });
});
