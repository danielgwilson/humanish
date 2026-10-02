import { describe, expect, it } from "vitest";
import {
  PUBLIC_TARGET_CWD,
  RUN_BUNDLE_SCHEMA,
  bundleArtifacts,
  bundleHead,
} from "../../src/run/bundle.js";

describe("bundleHead", () => {
  const source = { capturedAt: "2026-10-01T00:00:00.000Z" } as never;
  const createdAt = "2026-10-01T00:00:00.000Z";

  it("starts every bundle with the same fields in the saved order, artifactRoot before lab", () => {
    const head = bundleHead(
      { runId: "run-1", mode: "live", createdAt, lab: { id: "lab-1" } as never },
      { participants: 2, source },
    );
    expect(Object.keys(head)).toEqual([
      "schema",
      "runId",
      "mode",
      "simCount",
      "createdAt",
      "cwd",
      "artifactRoot",
      "lab",
      "source",
    ]);
    expect(head).toMatchObject({
      schema: RUN_BUNDLE_SCHEMA,
      simCount: 2,
      cwd: PUBLIC_TARGET_CWD,
      artifactRoot: ".humanish/runs/run-1",
    });
  });

  it("omits lab when the run has none and keeps a caller's cwd and artifact root", () => {
    const head = bundleHead(
      { runId: "run-1", mode: "dry-run", createdAt },
      { participants: 1, cwd: "/srv/project", artifactRoot: ".humanish/runs/dryrun-1", source },
    );
    expect("lab" in head).toBe(false);
    expect(head).toMatchObject({ cwd: "/srv/project", artifactRoot: ".humanish/runs/dryrun-1" });
  });

  it("saves publication restrictions right after the schema, and omits them when absent", () => {
    const head = bundleHead(
      { runId: "run-1", mode: "live", createdAt },
      { publication: { restrictions: ["real-communications"] }, participants: 1, source },
    );
    expect(Object.keys(head).slice(0, 3)).toEqual(["schema", "publication", "runId"]);
    expect(head.publication).toEqual({ restrictions: ["real-communications"] });
    expect(
      "publication" in
        bundleHead({ runId: "run-1", mode: "live", createdAt: "x" }, { participants: 1, source }),
    ).toBe(false);
  });

  it("names the same run files for every bundle, as a fresh object each time", () => {
    expect(bundleArtifacts()).toEqual({
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md",
      observerData: "observer/observer-data.json",
      events: "events.ndjson",
    });
    expect(bundleArtifacts()).not.toBe(bundleArtifacts());
  });
});
