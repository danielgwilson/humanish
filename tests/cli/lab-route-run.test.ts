import { describe, expect, it, vi } from "vitest";

import { runRoute, type RouteRun } from "../../src/cli/commands/lab-route-run.js";
import type { LabConfig } from "../../src/study/types.js";
import { prepareLab, type LabOutcome } from "../../src/run-lab.js";

// runRoute calls afterRun once runLab has returned or thrown, before presentation. The run
// command ends its signal handling there, so a presentation that owns shutdown (watch's Observer
// and tunnel) is not cut short by the run's exit-on-signal handler.
vi.mock("../../src/run-lab.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/run-lab.js")>()),
  prepareLab: vi.fn(),
}));

const config = {} as LabConfig;
// prepareLab is mocked, so the route's runLab options are never read.
const options = {} as RouteRun["options"];
const outcome = { route: "preview" } as unknown as LabOutcome;

describe("runRoute's afterRun", () => {
  it("runs after the run returns and before presentation", async () => {
    const order: string[] = [];
    vi.mocked(prepareLab).mockResolvedValue({
      ok: true,
      run: async () => {
        order.push("run");
        return outcome;
      },
    } as unknown as Awaited<ReturnType<typeof prepareLab>>);
    const route: RouteRun = {
      options,
      present: async () => {
        order.push("present");
      },
    };
    await runRoute(config, route, undefined, () => order.push("afterRun"));
    expect(order).toEqual(["run", "afterRun", "present"]);
  });

  it("runs after the run throws and before the route handles the error", async () => {
    const order: string[] = [];
    vi.mocked(prepareLab).mockResolvedValue({
      ok: true,
      run: async () => {
        order.push("run");
        throw new Error("synthetic route failure");
      },
    } as unknown as Awaited<ReturnType<typeof prepareLab>>);
    const route: RouteRun = {
      options,
      present: async () => {
        order.push("present");
      },
      onRunError: async () => {
        order.push("onRunError");
      },
    };
    await runRoute(config, route, undefined, () => order.push("afterRun"));
    expect(order).toEqual(["run", "afterRun", "onRunError"]);
  });
});
