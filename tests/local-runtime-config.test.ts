import { describe, expect, it } from "vitest";
import { parseLabConfig } from "../src/lab-config.js";
import { labKeyRequirements } from "../src/doctor-lab.js";

const base = { schema: "humanish.lab.v2", id: "local-browser", subject: { source: "app-url", appUrl: "http://localhost:3000/" },
  actors: [{ type: "local-agent", localAgent: "codex", count: 2 }], execution: { target: "local" }, scenario: { mode: "live" } };

describe("local browser lab configuration", () => {
  it("uses account analysis and the supported desktop without provider keys", () => {
    const parsed = parseLabConfig(base);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.config).toMatchObject({ actors: [{ model: "gpt-6-astra", reasoningEffort: "low" }],
      review: { analysis: { provider: "codex" } }, execution: { desktop: { resolution: [960, 720] } } });
    expect(labKeyRequirements(parsed.config, "cua", false, () => false)).toEqual({ desktop: false, keys: [] });
  });
  it("requires only the model API key for local API participants", () => {
    const parsed = parseLabConfig({ ...base, actors: [{ type: "openai-computer-use" }] });
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(labKeyRequirements(parsed.config, "cua", false, () => false)).toEqual({ desktop: false, keys: ["OPENAI_API_KEY"] });
    expect(parsed.config.review?.analysis).toBeUndefined();
  });
  it("preserves explicit analysis opt-out and hosted routing", () => {
    const local = parseLabConfig({ ...base, review: { analysis: false } });
    expect(local.ok && local.config.review?.analysis).toBe(false);
    const hosted = parseLabConfig({ ...base, execution: { target: "e2b-desktop" } });
    if (!hosted.ok) throw new Error(hosted.error.message);
    expect(hosted.config.review?.analysis).toBeUndefined();
    expect(hosted.config.execution?.desktop).toBeUndefined();
    expect(labKeyRequirements(hosted.config, "cua", false, () => false).keys).toEqual(["E2B_API_KEY"]);
  });
  it.each([
    { execution: { target: "local", timeoutMs: 20 * 60_000 + 1 } },
    { execution: { target: "local", desktop: { resolution: [1440, 950] } } },
    { subject: { source: "app-url", appUrl: "http://localhost/" } },
    { actors: [{ type: "local-agent", localAgent: "claude" }] }
  ])("refuses unsupported local declarations before a run", change => {
    expect(parseLabConfig({ ...base, ...change }).ok).toBe(false);
  });
});
