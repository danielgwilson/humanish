import { describe, expect, it } from "vitest";
import { parseStudy } from "../../../src/study/config.js";
import { planCliRun } from "../../../src/study/doctor.js";
import { requiredKeys } from "../../../src/study/requirements.js";
import { actorOf } from "../../../src/study/study-fields.js";
import type { StudyConfig } from "../../../src/study/types.js";

const base = {
  schema: "humanish.study.v3",
  id: "local-browser",
  route: "computer-use",
  mode: "live",
  subject: { source: "app-url", appUrl: "http://localhost:3000/" },
  actor: { type: "local-agent", localAgent: "codex" },
  participants: 2,
  execution: { target: "local" },
};

/** The provider keys doctor and the TUI report for a live run, read from the lab's plan. */
async function liveKeys(config: StudyConfig): Promise<string[]> {
  const planned = await planCliRun(config, process.cwd());
  if (!planned.ok) throw new Error(planned.refusal.message);
  return requiredKeys(planned.planned.plan.requirements, () => false);
}

describe("local browser lab configuration", () => {
  it("uses account analysis and the supported desktop without provider keys", async () => {
    const parsed = parseStudy(base);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(actorOf(parsed.config)).toMatchObject({ model: "gpt-6-astra", reasoningEffort: "low" });
    expect(parsed.config).toMatchObject({
      review: { analysis: { provider: "codex" } },
      execution: { desktop: { resolution: [960, 720] } },
    });
    expect(await liveKeys(parsed.config)).toEqual([]);
  });
  it("requires only the model API key for local API participants", async () => {
    const parsed = parseStudy({ ...base, actor: { type: "openai-computer-use" } });
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(await liveKeys(parsed.config)).toEqual(["OPENAI_API_KEY"]);
    expect(parsed.config.review?.analysis).toBeUndefined();
  });
  it("admits an external captured inbox without mailbox-provider credentials", async () => {
    const parsed = parseStudy({
      ...base,
      comms: { email: { external: { catchBaseUrl: "http://127.0.0.1:8025" } } },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.config.comms?.email?.kind).toBe("fake");
    expect(await liveKeys(parsed.config)).toEqual([]);
    for (const email of [
      { injectEnv: "MAIL_BASE_URL" },
      { kind: "real", connection: "agentmail" },
    ]) {
      expect(parseStudy({ ...base, comms: { email } }).ok).toBe(false);
    }
  });
  it("admits optional native camera and conversation without adding provider keys", async () => {
    const media = { camera: { source: "synthetic" }, microphone: { source: "speech" } };
    const parsed = parseStudy({
      ...base,
      execution: { target: "local", desktop: { media } },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.config.execution?.desktop?.media).toEqual(media);
    expect(await liveKeys(parsed.config)).toEqual([]);
  });
  it("rejects unsupported file devices and model providers before running", () => {
    for (const media of [
      { camera: { source: "camera.y4m" } },
      { microphone: { source: "voice.wav" } },
    ]) {
      expect(parseStudy({ ...base, execution: { target: "local", desktop: { media } } }).ok).toBe(
        false,
      );
    }
    const parsed = parseStudy({
      ...base,
      actor: { type: "openai-computer-use" },
      execution: { target: "local", desktop: { media: { microphone: { source: "speech" } } } },
    });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error.message).toContain("requires local-agent with Codex");
  });
  it("refuses a roster target the local runtime cannot reach, as it refuses the subject URL", () => {
    const roster = (second: string) => ({
      ...base,
      actor: { type: "openai-computer-use" },
      participants: [
        { id: "first-01", target: "http://127.0.0.1:3001/" },
        { id: "second-01", target: second },
      ],
    });
    expect(parseStudy(roster("http://localhost:3002/")).ok).toBe(true);
    const parsed = parseStudy(roster("http://127.0.0.1:80/"));
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error.message).toBe(
      "Local browser targets must use localhost or 127.0.0.1 on a port above 1023.",
    );
  });
  it("preserves explicit analysis opt-out and hosted routing", async () => {
    const local = parseStudy({ ...base, review: { analysis: false } });
    expect(local.ok && local.config.review?.analysis).toBe(false);
    const hosted = parseStudy({ ...base, execution: { target: "e2b-desktop" } });
    if (!hosted.ok) throw new Error(hosted.error.message);
    expect(hosted.config.review?.analysis).toBeUndefined();
    expect(hosted.config.execution?.desktop).toBeUndefined();
    expect(await liveKeys(hosted.config)).toEqual(["E2B_API_KEY"]);
  });
  it.each([
    { execution: { target: "local", timeoutMs: 20 * 60_000 + 1 } },
    { execution: { target: "local", desktop: { resolution: [1440, 950] } } },
    { subject: { source: "app-url", appUrl: "http://localhost/" } },
    { actor: { type: "local-agent", localAgent: "claude" } },
  ])("refuses unsupported local declarations before a run", (change) => {
    expect(parseStudy({ ...base, ...change }).ok).toBe(false);
  });
});
