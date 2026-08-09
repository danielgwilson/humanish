// #412: verify must not fail a bundle its own writer produced.
//
// Lane records are digest-only by design, but `scenario.goal` keeps one lane's composed
// instructions verbatim, and `observer-data.json` carries a copy. An adopter whose authored lane
// text has to name a runtime world URL — an inbox on a route where the harness does not inject one
// — put an `*.e2b.app` address in it. That landed raw in both artifacts, the sensitive-text scanner
// matched it, and verify failed a bundle humanish itself wrote, with every lane passing.
//
// The only adopter-side workaround was writing the URL scheme-less to dodge the scanner, which
// nobody should do. So the writer redacts, exactly as the terminal lane already did.
import { describe, expect, it } from "vitest";

import { buildObserverData } from "../src/observer-data.js";
import { containsSensitive, redactText } from "../src/redaction.js";
import type { RunBundle } from "../src/run.js";

// A composed lane prompt of the shape the report describes: authored text naming a runtime inbox.
const LANE_PROMPT = [
  "Persona: skeptical-power-user.",
  "",
  "Sign up and verify your email.",
  "",
  "Lane focus: read your mail at https://8025-ixyzsandbox123.e2b.app/inbox and follow the link."
].join("\n");

describe("scenario.goal redaction (#412)", () => {
  it("the raw prompt is exactly what the scanner rejects", () => {
    // Establishes the premise: without redaction this text fails the public-safety gate.
    expect(containsSensitive(LANE_PROMPT)).toBe(true);
  });

  it("redaction clears the gate while keeping the prompt readable", () => {
    const stored = redactText(LANE_PROMPT);
    expect(containsSensitive(stored)).toBe(false);
    // The runtime URL is gone...
    expect(stored).not.toContain("ixyzsandbox123.e2b.app");
    // ...and everything an operator needs to understand what was asked survives.
    expect(stored).toContain("Persona: skeptical-power-user.");
    expect(stored).toContain("Sign up and verify your email.");
  });

  it("the observer copy inherits the redaction rather than needing its own", () => {
    const bundle = {
      schema: "humanish.run-bundle.v1",
      runId: "cua-test",
      mode: "live",
      simCount: 1,
      createdAt: "2026-08-09T00:00:00.000Z",
      cwd: ".",
      artifactRoot: ".humanish/runs/cua-test",
      source: { packageName: "humanish", humanishSource: "present", git: null },
      persona: { id: "p", name: "P", source: "test", sourceDigest: "d" },
      // What the writer stores after this fix.
      scenario: { id: "s", title: "T", goal: redactText(LANE_PROMPT), source: "test", sourceDigest: "d" },
      lifecycle: [],
      simulations: [],
      streams: [],
      events: [],
      artifacts: [],
      redaction: { status: "passed", screenshots: "raw" },
      feedbackCandidates: [],
      review: { schema: "humanish.review.v1", verdict: "pass", summary: "s", gaps: [] }
    } as unknown as RunBundle;

    const data = buildObserverData(bundle);
    expect(JSON.stringify(data)).not.toContain("ixyzsandbox123.e2b.app");
    expect(containsSensitive(JSON.stringify(data.run.scenario))).toBe(false);
  });
});
