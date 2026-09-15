// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { recordingSource, recordingState } from "../lib/recording-source";
import { pushHash, replaceHash } from "../lib/route";

afterEach(() => window.history.replaceState(null, "", "/"));
describe("recording return navigation", () => {
  const finding = { runId: "study", kind: "finding" as const, findingId: "F1" };
  const fallback = { runId: "study", kind: "participants" as const };
  it("preserves a concern evidence return only while that study has a concern review", () => {
    const concerns = { runId: "study", kind: "concerns" as const };
    expect(recordingSource(recordingState(concerns), "study", [], true)).toEqual(concerns);
    expect(recordingSource(recordingState(concerns), "study")).toEqual(fallback);
    expect(recordingSource(recordingState({ ...concerns, runId: "other" }), "study", [], true)).toEqual(fallback);
  });
  it("uses Participants for copied links, foreign studies, and removed findings", () => {
    expect(recordingSource(null, "study", ["F1"])).toEqual(fallback);
    expect(recordingSource(recordingState({ ...finding, runId: "other" }), "study", ["F1"])).toEqual(fallback);
    expect(recordingSource(recordingState(finding), "study", ["F2"])).toEqual(fallback);
    expect(recordingSource(recordingState(finding), "study", ["F1"])).toEqual(finding);
  });
  it("preserves the entry source while scrubbing and replaces it when the same frame opens elsewhere", () => {
    pushHash("#/lane/participant/f/1", recordingState(finding));
    const entries = window.history.length;
    replaceHash("#/lane/participant/f/2");
    expect(window.history.length).toBe(entries);
    expect(recordingSource(window.history.state, "study", ["F1"])).toEqual(finding);
    pushHash("#/lane/participant/f/2", recordingState(fallback));
    expect(window.history.length).toBe(entries);
    expect(recordingSource(window.history.state, "study", ["F1"])).toEqual(fallback);
  });
  it("returns to the exact comparison configuration and refuses unrelated return destinations", () => {
    const comparison = { runId: "study", kind: "comparison" as const, hash: "#/compare?lane=a&lane=b&clock=elapsed&t=12" };
    expect(recordingSource(recordingState(comparison), "study")).toEqual(comparison);
    expect(recordingSource(recordingState({ ...comparison, hash: "https://example.com" }), "study")).toEqual(fallback);
    expect(recordingSource(recordingState({ ...comparison, hash: "#/compare?" + "x".repeat(2048) }), "study")).toEqual(fallback);
  });
});
