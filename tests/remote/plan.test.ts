import path from "node:path";

import { describe, expect, it } from "vitest";

import { planRemoteRun } from "../../src/remote/plan.js";
import { parseStudy } from "../../src/study/config.js";
import { planStudy } from "../../src/study/plan.js";
import type { StudyConfig } from "../../src/study/types.js";
import { lab, type BaseName, type Patch } from "../admission/fixtures.js";

const cwd = path.resolve("/synthetic/project");
const studyPath = path.join(cwd, "humanish/studies/remote.yaml");
const PUBLIC_APP = {
  subject: { source: "app-url", appUrl: "https://app.example.com/" },
  policies: { allowPublicTargets: true },
};
const HOUR = 60 * 60_000;

function study(base: BaseName, patch: Patch): StudyConfig {
  const parsed = parseStudy(lab(base, patch));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

function remote(
  config: StudyConfig,
  options: { ceilingMs?: number; studyPath?: string; concurrentSandboxes?: number } = {},
) {
  const planned = planStudy(config, { cwd, dryRun: false });
  if (!planned.ok) throw new Error(planned.refusal.message);
  return planRemoteRun({
    config,
    plan: planned.planned.plan,
    cwd,
    studyPath: options.studyPath ?? studyPath,
    ceilingMs: options.ceilingMs ?? 24 * HOUR,
    concurrentSandboxes: options.concurrentSandboxes ?? 20,
  });
}

describe("a computer-use study on hosted desktops with a public app", () => {
  it("runs remotely on its participants' provider with only the keys its plan reads", () => {
    const result = remote(
      study("cuAppUrl", {
        ...PUBLIC_APP,
        execution: { target: "modal-desktop", timeoutMs: 600_000 },
      }),
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.provider).toBe("modal");
    expect(result.plan.envNames).toContain("OPENAI_API_KEY");
    expect(result.plan.envNames).toEqual(
      expect.arrayContaining(["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "MODAL_ENVIRONMENT"]),
    );
    expect(result.plan.envNames).not.toContain("E2B_API_KEY");
    expect(result.plan.envNames).not.toContain("GH_TOKEN");
    expect(result.plan.uploads).toEqual(["humanish/studies/remote.yaml"]);
  });

  it("forwards the key of the vendor its participants run on", () => {
    const claude = (target: string) =>
      remote(
        study("cuAppUrl", {
          ...PUBLIC_APP,
          actor: { type: "computer-use", model: "claude-haiku-5-5" },
          review: { analysis: false },
          execution: { target, timeoutMs: 600_000 },
        }),
      );
    for (const target of ["e2b-desktop", "modal-desktop"]) {
      const result = claude(target);
      if (!result.ok) throw new Error(result.reason);
      expect(result.plan.envNames).toContain("ANTHROPIC_API_KEY");
      expect(result.plan.envNames).not.toContain("OPENAI_API_KEY");
    }
  });

  it("keeps its runner for setup, the last participant's end, analysis and teardown", () => {
    const config = study("cuAppUrl", {
      ...PUBLIC_APP,
      execution: { target: "e2b-desktop", timeoutMs: 600_000 },
    });
    const planned = planStudy(config, { cwd, dryRun: false });
    if (!planned.ok || planned.planned.plan.route !== "computer-use")
      throw new Error("not planned");
    const plan = planned.planned.plan;
    const result = remote(config);
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.provider).toBe("e2b");
    expect(result.plan.envNames).toContain("E2B_API_KEY");
    expect(result.plan.runnerMs).toBe(
      10 * 60_000 + plan.arrivals.lastEndMs + (plan.analysis?.config.timeoutMs ?? 0) + 15 * 60_000,
    );
  });

  it("is refused when its runner would outlive the provider's sandbox lifetime", () => {
    const result = remote(
      study("cuAppUrl", {
        ...PUBLIC_APP,
        execution: { target: "e2b-desktop", timeoutMs: 600_000 },
      }),
      { ceilingMs: HOUR / 2 },
    );
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("30 minutes E2B") });
  });
  it("is refused when its participants and the runner exceed the E2B account's sandboxes", () => {
    const config = study("cuAppUrl", {
      ...PUBLIC_APP,
      participants: ["a", "b", "c"].map((id) => ({ id, target: `https://app.example.com/${id}` })),
      execution: { target: "e2b-desktop", timeoutMs: 600_000, concurrency: 3 },
    });
    expect(remote(config, { concurrentSandboxes: 4 }).ok).toBe(true);
    expect(remote(config, { concurrentSandboxes: 3 })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("need 4 E2B sandboxes at once"),
    });
  });
});

describe("a study that needs this machine", () => {
  it.each([
    ["an app on this machine", study("cuAppUrl", {}), "points at this machine"],
    [
      "an app on a private network",
      study("cuAppUrl", {
        subject: { source: "app-url", appUrl: "http://192.168.1.20:8080/" },
        policies: { allowPublicTargets: true },
      }),
      "private network",
    ],
    ["a subject built here", study("cuClone", {}), "built or served from this machine"],
    [
      "a scorer module",
      study("cuAppUrl", { ...PUBLIC_APP, review: { scorer: { ref: "scorer.mjs" } } }),
      "scorer",
    ],
  ])("is refused for %s", (_name, config, reason) => {
    expect(remote(config)).toMatchObject({ ok: false, reason: expect.stringContaining(reason) });
  });

  it("is refused when the study file is outside the project", () => {
    const result = remote(study("cuAppUrl", PUBLIC_APP), { studyPath: "/elsewhere/remote.yaml" });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("outside") });
  });
});
