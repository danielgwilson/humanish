import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildPayload,
  deriveStudyFacts,
  disabledByEnvironment,
  durationBucket,
  readTelemetryState,
  safeLabId,
  sendTelemetry,
  telemetryStatePath,
  writeTelemetryState,
  TELEMETRY_NOTICE
} from "../src/telemetry.js";

// Default-on collection is only honest if the promises are enforced rather than written down.
// humanish is stricter than the Next.js/Vercel convention it follows, because a lab id can name an
// unannounced product and a subject is somebody else's roadmap.

describe("what telemetry can possibly contain", () => {
  it("carries an allowlist and nothing else", () => {
    const payload = buildPayload({
      event: "cli_command",
      anonymousId: "anon-1",
      version: "9.9.9",
      platform: "linux",
      nodeVersion: "v24.0.0",
      env: {},
      properties: { command: "run", lab: "try-live", mode: "live", outcome: "passed", durationBucket: "1-5m", ok: true }
    });
    expect(Object.keys(payload.properties).sort()).toEqual(
      // studyParticipant joins the allowlist deliberately (#546): a boolean marking traffic from
      // a humanish study participant, so our own instrument stays separable from real adopters.
      // Same shape and same privacy profile as `ci`; it carries no identity and no free text.
      [
        "$geoip_disable", "ci", "command", "duration", "lab", "mode", "node", "ok", "os", "outcome",
        "studyParticipant", "version"
      ].sort()
    );
    // No exact duration: a millisecond timing is a fingerprint.
    expect(JSON.stringify(payload)).not.toMatch(/\d{4,}/);
  });

  it("asks the receiver not to derive a location, on every event", () => {
    // PostHog enriches events with GeoIP city/coordinates from the request's source address by
    // default. "Anonymous" was written in the doc while the dataset carried a postal code per
    // event. The opt-out rides the payload so no console setting can reintroduce it.
    const payload = buildPayload({ event: "cli_command", anonymousId: "a", version: "1.0.0", env: {} });
    expect(payload.properties.$geoip_disable).toBe(true);
  });

  it("forwards only humanish's own error codes, never a message", () => {
    const own = buildPayload({ event: "cli_command", anonymousId: "a", version: "1", env: {}, properties: { errorCode: "HUMANISH_CUA_LAB_KEYS_MISSING" } });
    expect(own.properties.error_code).toBe("HUMANISH_CUA_LAB_KEYS_MISSING");
    // A provider's error or an OS error is free text and can carry anything.
    const foreign = buildPayload({ event: "cli_command", anonymousId: "a", version: "1", env: {}, properties: { errorCode: "ENOENT: /Users/jane/acme-launch/lab.yaml" } });
    expect(foreign.properties.error_code).toBeUndefined();
    const lower = buildPayload({ event: "cli_command", anonymousId: "a", version: "1", env: {}, properties: { errorCode: "humanish_x" } });
    expect(lower.properties.error_code).toBeUndefined();
  });

  it("NEVER names a lab that is not one of ours", () => {
    // An adopter's lab id can be the name of a product they have not announced.
    expect(safeLabId("first-run")).toBe("first-run");
    expect(safeLabId("try-live")).toBe("try-live");
    expect(safeLabId("acme-secret-launch")).toBe("custom");
    expect(safeLabId("checkout-v2-redesign")).toBe("custom");
    expect(safeLabId(undefined)).toBeUndefined();
  });

  it("has no field that could carry a path, a subject, or a person", () => {
    const payload = buildPayload({ event: "cli_command", anonymousId: "a", version: "1.0.0", env: {} });
    const forbidden = ["cwd", "path", "dir", "repo", "url", "subject", "persona", "mission", "email", "user", "key", "token", "run_id", "runId"];
    const keys = Object.keys(payload.properties).map((k) => k.toLowerCase());
    for (const bad of forbidden) {
      expect(keys.some((k) => k.includes(bad)), `property containing "${bad}" must not exist`).toBe(false);
    }
  });

  it("identifies a machine only by a locally generated random id", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "humanish-telemetry-"));
    try {
      const first = await readTelemetryState({}, home);
      expect(first.anonymousId).toMatch(/^[0-9a-f-]{36}$/);
      // Tied to nothing: no hostname, no username, no machine id.
      expect(first.anonymousId).not.toContain(home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("turning it off", () => {
  it("honours DO_NOT_TRACK, the cross-tool standard", () => {
    expect(disabledByEnvironment({ DO_NOT_TRACK: "1" })).toBe(true);
    expect(disabledByEnvironment({ HUMANISH_TELEMETRY_DISABLED: "1" })).toBe(true);
    // A blank or falsey value is not an opt-out — it is an unset variable with a value.
    expect(disabledByEnvironment({ DO_NOT_TRACK: "0" })).toBe(false);
    expect(disabledByEnvironment({ DO_NOT_TRACK: "" })).toBe(false);
    expect(disabledByEnvironment({})).toBe(false);
  });

  it("persists an opt-out, and remembers the notice was shown", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "humanish-telemetry-"));
    try {
      await writeTelemetryState({ enabled: false, anonymousId: "anon-x", noticed: true }, {}, home);
      const state = await readTelemetryState({}, home);
      expect(state.enabled).toBe(false);
      expect(state.noticed).toBe(true);
      // Written under the user's config, never into the project being studied.
      expect(telemetryStatePath({}, home)).toContain(path.join(".config", "humanish"));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("ignores a relative XDG_CONFIG_HOME, so state never becomes cwd-relative", () => {
    // The same rule the key store follows: a relative value would put per-user state inside
    // whichever project happened to be open.
    expect(telemetryStatePath({ XDG_CONFIG_HOME: "relative/path" }, "/home/dev"))
      .toBe(path.join("/home/dev", ".config", "humanish", "telemetry.json"));
  });
});

describe("it can never hurt the command that triggered it", () => {
  it("swallows a transport failure", async () => {
    await expect(sendTelemetry(
      { event: "cli_command", distinct_id: "a", properties: {} },
      { fetchFn: (async () => { throw new Error("network down"); }) as unknown as typeof fetch }
    )).resolves.toBeUndefined();
  });

  it("gives up rather than hanging — the request carries an abort signal", async () => {
    // Real fetch rejects when the signal fires; this fake proves the signal is actually passed,
    // which is the part we control.
    let sawSignal = false;
    const slow = ((_url: string, init: { signal?: AbortSignal }) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }) as unknown as typeof fetch;
    await expect(sendTelemetry({ event: "cli_command", distinct_id: "a", properties: {} }, { fetchFn: slow }))
      .resolves.toBeUndefined();
    expect(sawSignal).toBe(true);
  }, 10_000);
});

describe("the notice", () => {
  it("says what is collected, what is not, and how to stop it", () => {
    expect(TELEMETRY_NOTICE).toContain("anonymous");
    expect(TELEMETRY_NOTICE).toContain("never sends");
    expect(TELEMETRY_NOTICE).toContain("humanish telemetry disable");
    expect(TELEMETRY_NOTICE).toContain("DO_NOT_TRACK");
  });
});

describe("durations are buckets", () => {
  it("cannot reconstruct a timing", () => {
    expect(durationBucket(400)).toBe("<1s");
    expect(durationBucket(45_000)).toBe("10-60s");
    expect(durationBucket(3_600_000)).toBe(">15m");
  });
});

describe("study-participant marking (#546)", () => {
  it("is false by default, so an ordinary run is not mislabelled", () => {
    const payload = buildPayload({
      event: "cli_command",
      anonymousId: "anon-1",
      version: "9.9.9",
      env: {},
      properties: { command: "run" }
    });
    expect(payload.properties.studyParticipant).toBe(false);
  });

  it("is true when a harness marks the environment", () => {
    const payload = buildPayload({
      event: "cli_command",
      anonymousId: "anon-1",
      version: "9.9.9",
      env: { HUMANISH_STUDY_PARTICIPANT: "1" },
      properties: { command: "run" }
    });
    expect(payload.properties.studyParticipant).toBe(true);
  });

  it("treats 0 and empty as unmarked, matching how every other flag here reads", () => {
    for (const value of ["", "0"]) {
      const payload = buildPayload({
        event: "cli_command",
        anonymousId: "anon-1",
        version: "9.9.9",
        env: { HUMANISH_STUDY_PARTICIPANT: value },
        properties: { command: "run" }
      });
      expect(payload.properties.studyParticipant).toBe(false);
    }
  });
});

// 1,359 `run` / `lab run` events in the first two days of telemetry, and not one carried a mode
// or an outcome. The vocabulary existed; nothing populated it. These pin the derivation that
// reads the facts off the result document every command already writes.
describe("what a study reports about itself", () => {
  it("reads mode, starter lab, outcome, and brain off a single-lane computer-use result", () => {
    expect(deriveStudyFacts({
      schema: "humanish.cua-actor-lab-result.v1",
      ok: true,
      labId: "try-live",
      actor: "openai-computer-use",
      dryRun: false,
      session: { status: "passed", completionReason: "goal_satisfied", reason: "done", screenshots: 12 }
    })).toEqual({ mode: "live", lab: "try-live", outcome: "passed", brain: "provider-key" });
  });

  it("rolls a fan-out up to all/some/none passed, never per-lane detail", () => {
    const base = { labId: "cua-browser", actor: "openai-computer-use", dryRun: false, ok: true };
    expect(deriveStudyFacts({ ...base, laneSummary: { total: 3, passed: 3 } }).outcome).toBe("all_passed");
    expect(deriveStudyFacts({ ...base, laneSummary: { total: 3, passed: 1 } }).outcome).toBe("some_passed");
    expect(deriveStudyFacts({ ...base, laneSummary: { total: 3, passed: 0 } }).outcome).toBe("none_passed");
  });

  it("reports a dry run as brain none, whatever actor would have run it", () => {
    expect(deriveStudyFacts({ labId: "first-run", actor: "openai-computer-use", dryRun: true, ok: true }))
      .toEqual({ mode: "dry-run", lab: "first-run", outcome: "ok", brain: "none" });
  });

  it("names the failure by our own code, and only ours", () => {
    expect(deriveStudyFacts({
      ok: false, labId: "try-live", dryRun: false,
      error: { code: "HUMANISH_CUA_LAB_KEYS_MISSING", message: "OPENAI_API_KEY is not set" }
    })).toEqual({ mode: "live", lab: "try-live", outcome: "error", errorCode: "HUMANISH_CUA_LAB_KEYS_MISSING" });
    const foreign = deriveStudyFacts({ ok: false, dryRun: false, error: { code: "ECONNREFUSED", message: "x" } });
    expect(foreign.errorCode).toBeUndefined();
    expect(foreign.outcome).toBe("error");
  });

  it("NEVER names an adopter's lab, and never forwards free-text status", () => {
    const facts = deriveStudyFacts({
      labId: "acme-checkout-v2", dryRun: false, ok: true,
      session: { status: "Finished after the user typed their password" }
    });
    expect(facts.lab).toBe("custom");
    expect(facts.outcome).toBeUndefined();
    expect(JSON.stringify(facts)).not.toContain("acme");
    expect(JSON.stringify(facts)).not.toContain("password");
  });

  it("reads the plain run result and the preflight result too", () => {
    expect(deriveStudyFacts({ schema: "humanish.run-result.v1", ok: true, mode: "dry-run", runId: "r", cwd: "/x", warnings: [] }))
      .toEqual({ mode: "dry-run", outcome: "ok" });
    expect(deriveStudyFacts({ schema: "humanish.lab-preflight-result.v1", ok: false, lab: "try-live", labId: "try-live", error: { code: "HUMANISH_LAB_PREFLIGHT_E2B_REQUIRED", message: "m" } }))
      .toEqual({ lab: "try-live", outcome: "error", errorCode: "HUMANISH_LAB_PREFLIGHT_E2B_REQUIRED" });
  });

  it("says nothing about a result that carries no study", () => {
    expect(deriveStudyFacts({ schema: "humanish.doctor-result.v1", ok: true, cwd: "/x", checks: [] })).toEqual({});
    expect(deriveStudyFacts("not an object")).toEqual({});
    expect(deriveStudyFacts(null)).toEqual({});
  });
});
