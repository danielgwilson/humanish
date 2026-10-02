import { describe, expect, it, vi } from "vitest";

import { defaultSubjectPhaseSink } from "../../src/subject/steps.js";

describe("the subject phase line on stderr", () => {
  it("names the computer-use route, and the participant when several run", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const event = {
      at: "2026-10-02T00:00:00.000Z",
      type: "cua-lab.subject.install.completed",
      ok: true,
      durationMs: 5,
      message: "subject dependencies installed",
    };

    defaultSubjectPhaseSink(event, { id: "lane-02", count: 2 });
    defaultSubjectPhaseSink(event, { id: "lane-01", count: 1 });

    expect(write.mock.calls.map(([text]) => text)).toEqual([
      "humanish computer-use [lane-02]: subject dependencies installed (5ms)\n",
      "humanish computer-use: subject dependencies installed (5ms)\n",
    ]);
  });
});
