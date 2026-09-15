import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";

/** Internal orchestration test double, never a fabricated provider response. */
export function automaticAnalysisBoundary() {
  return vi.fn(async (cwd: string, runId: string) => {
    const root = path.join(cwd, ".humanish", "runs", runId);
    const status = JSON.parse(await readFile(path.join(root, "status.json"), "utf8"));
    expect(status).toMatchObject({ runId, state: "finished" });
    const source = JSON.parse(await readFile(path.join(root, "run.json"), "utf8"));
    expect(source.mode).toBe("live");
    // Several producers finish status before these trailing artifacts are published.
    for (const file of ["review.json", "review.md", "events.ndjson"]) {
      expect((await readFile(path.join(root, file))).length).toBeGreaterThan(0);
    }
    return { state: "skipped" as const, reason: "synthetic_no_provider" };
  });
}
