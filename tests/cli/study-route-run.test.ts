import { describe, expect, it, vi } from "vitest";

import { runRoute, type RouteRun } from "../../src/cli/commands/study-route-run.js";
import type { StudyConfig } from "../../src/study/types.js";
import { prepareStudy, type StudyOutcome } from "../../src/run-study.js";

// runRoute calls afterRun once runStudyWith has returned or thrown, before presentation. The run
// command ends its signal handling there, so a presentation that owns shutdown (watch's Observer
// and tunnel) is not cut short by the run's exit-on-signal handler.
vi.mock("../../src/run-study.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/run-study.js")>()),
  prepareStudy: vi.fn(),
}));

const config = {} as StudyConfig;
// prepareStudy is mocked, so the route's runStudyWith options are never read.
const options = {} as RouteRun["options"];
const outcome = { route: "preview" } as unknown as StudyOutcome;

describe("runRoute's afterRun", () => {
  it("runs after the run returns and before presentation", async () => {
    const order: string[] = [];
    vi.mocked(prepareStudy).mockResolvedValue({
      ok: true,
      run: async () => {
        order.push("run");
        return outcome;
      },
    } as unknown as Awaited<ReturnType<typeof prepareStudy>>);
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
    vi.mocked(prepareStudy).mockResolvedValue({
      ok: true,
      run: async () => {
        order.push("run");
        throw new Error("synthetic route failure");
      },
    } as unknown as Awaited<ReturnType<typeof prepareStudy>>);
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
