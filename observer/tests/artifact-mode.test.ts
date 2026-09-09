// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isSnapshotArtifact } from "../lib/data";

describe("export boot marker", () => {
  const read = (html: string) => isSnapshotArtifact(new DOMParser().parseFromString(html, "text/html"));
  it("accepts only the explicit snapshot marker", () => {
    expect(read('<meta name="humanish-observer-mode" content="snapshot">')).toBe(true);
    expect(read('<meta name="humanish-observer-mode" content="live">')).toBe(false);
    expect(read('<meta name="humanish-observer-mode" content="unexpected">')).toBe(false);
    expect(read('<meta name="humanish-observer-mode">')).toBe(false);
  });
  it("leaves old unmarked artifacts and JSON fields in the normal protocol mode", () => {
    expect(read('<script id="observer-data" type="application/json">{"snapshot":true}</script>')).toBe(false);
    expect(read('<div id="humanish-local-only">LOCAL ONLY</div>')).toBe(false);
    expect(read("")).toBe(false);
  });
});
