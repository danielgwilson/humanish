import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { starterFiles } from "../../src/lab/init-templates.js";

import {
  buildPayload,
  deriveRunFacts,
  disabledByEnvironment,
  durationBucket,
  readTelemetryState,
  safeStudyId,
  sendTelemetry,
  telemetryStatePath,
  writeTelemetryState,
  TELEMETRY_NOTICE,
} from "../../src/cli/telemetry.js";

// Default-on collection is acceptable only if the promises are enforced rather than written down.
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
      properties: {
        command: "run",
        study: "try-live",
        mode: "live",
        outcome: "passed",
        durationBucket: "1-5m",
        ok: true,
      },
    });
    expect(Object.keys(payload.properties).sort()).toEqual(
      // studyParticipant joins the allowlist deliberately: a boolean marking traffic from
      // a humanish study participant, so our own instrument stays separable from real adopters.
      // Same shape and same privacy profile as `ci`; it carries no identity and no free text.
      [
        "$geoip_disable",
        "$process_person_profile",
        "ci",
        "command",
        "duration",
        "lab",
        "study",
        "mode",
        "node",
        "ok",
        "os",
        "outcome",
        "studyParticipant",
        "version",
      ].sort(),
    );
    // No exact duration: a millisecond timing is a fingerprint.
    expect(JSON.stringify(payload)).not.toMatch(/\d{4,}/);
    // Until 0.109, the study goes out as `study` and as `lab`, its 0.107 name, with one value.
    expect(payload.properties.study).toBe("try-live");
    expect(payload.properties.lab).toBe("try-live");
  });

  it("asks the receiver not to derive a location, on every event", () => {
    // PostHog enriches events with GeoIP city/coordinates from the request's source address by
    // default. "Anonymous" was written in the doc while the dataset carried a postal code per
    // event. The opt-out rides the payload so no console setting can reintroduce it.
    const payload = buildPayload({
      event: "cli_command",
      anonymousId: "a",
      version: "1.0.0",
      env: {},
    });
    expect(payload.properties.$geoip_disable).toBe(true);
    // And no person profile: there is no person, only a random machine id.
    expect(payload.properties.$process_person_profile).toBe(false);
  });

  it("forwards only humanish's own error codes, never a message", () => {
    const own = buildPayload({
      event: "cli_command",
      anonymousId: "a",
      version: "1",
      env: {},
      properties: { errorCode: "HUMANISH_COMPUTER_USE_KEYS_MISSING" },
    });
    expect(own.properties.error_code).toBe("HUMANISH_COMPUTER_USE_KEYS_MISSING");
    // A provider's error or an OS error is free text and can carry anything.
    const foreign = buildPayload({
      event: "cli_command",
      anonymousId: "a",
      version: "1",
      env: {},
      properties: { errorCode: "ENOENT: no such file or directory, open acme-launch/lab.yaml" },
    });
    expect(foreign.properties.error_code).toBeUndefined();
    const lower = buildPayload({
      event: "cli_command",
      anonymousId: "a",
      version: "1",
      env: {},
      properties: { errorCode: "humanish_x" },
    });
    expect(lower.properties.error_code).toBeUndefined();
  });

  it("never names a study that is not one of ours", () => {
    // An adopter's lab id can be the name of a product they have not announced.
    expect(safeStudyId("first-run")).toBe("first-run");
    expect(safeStudyId("try-live")).toBe("try-live");
    expect(safeStudyId("acme-secret-launch")).toBe("custom");
    expect(safeStudyId("checkout-v2-redesign")).toBe("custom");
    expect(safeStudyId(undefined)).toBeUndefined();
  });

  it("names every lab that humanish init writes", () => {
    const initLabIds = starterFiles
      .filter((file) => file.path.startsWith("humanish/studies/"))
      .map((file) => /^id: (\S+)$/m.exec(file.contents)?.[1]);
    expect(initLabIds).toContain("local-browser");
    for (const id of initLabIds) expect(safeStudyId(id)).toBe(id);
    // The removed OSS meta-lab's id is no longer ours.
    expect(safeStudyId("oss")).toBe("custom");
  });

  it("has no field that could carry a path, a subject, or a person", () => {
    const payload = buildPayload({
      event: "cli_command",
      anonymousId: "a",
      version: "1.0.0",
      env: {},
    });
    const forbidden = [
      "cwd",
      "path",
      "dir",
      "repo",
      "url",
      "subject",
      "persona",
      "mission",
      "email",
      "user",
      "key",
      "token",
      "run_id",
      "runId",
    ];
    const keys = Object.keys(payload.properties).map((k) => k.toLowerCase());
    for (const bad of forbidden) {
      expect(
        keys.some((k) => k.includes(bad)),
        `property containing "${bad}" must not exist`,
      ).toBe(false);
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
    // A blank or falsey value is not an opt-out: it is an unset variable with a value.
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
    expect(telemetryStatePath({ XDG_CONFIG_HOME: "relative/path" }, "/home/dev")).toBe(
      path.join("/home/dev", ".config", "humanish", "telemetry.json"),
    );
  });
});

describe("it can never hurt the command that triggered it", () => {
  it("swallows a transport failure", async () => {
    await expect(
      sendTelemetry(
        { event: "cli_command", distinct_id: "a", properties: {} },
        {
          fetchFn: (async () => {
            throw new Error("network down");
          }) as unknown as typeof fetch,
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("gives up rather than hanging: the request carries an abort signal", async () => {
    // Real fetch rejects when the signal fires; this fake proves the signal is actually passed,
    // which is the part we control.
    let sawSignal = false;
    const slow = ((_url: string, init: { signal?: AbortSignal }) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }) as unknown as typeof fetch;
    await expect(
      sendTelemetry({ event: "cli_command", distinct_id: "a", properties: {} }, { fetchFn: slow }),
    ).resolves.toBeUndefined();
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

describe("study-participant marking", () => {
  it("is false by default, so an ordinary run is not mislabelled", () => {
    const payload = buildPayload({
      event: "cli_command",
      anonymousId: "anon-1",
      version: "9.9.9",
      env: {},
      properties: { command: "run" },
    });
    expect(payload.properties.studyParticipant).toBe(false);
  });

  it("is true when a harness marks the environment", () => {
    const payload = buildPayload({
      event: "cli_command",
      anonymousId: "anon-1",
      version: "9.9.9",
      env: { HUMANISH_STUDY_PARTICIPANT: "1" },
      properties: { command: "run" },
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
        properties: { command: "run" },
      });
      expect(payload.properties.studyParticipant).toBe(false);
    }
  });
});

// 1,359 `run` / `lab run` events in the first two days of telemetry, and not one carried a mode
// or an outcome. The vocabulary existed; nothing populated it. These pin the derivation that
// reads the facts off the result document every command already writes.
describe("what a study reports about itself", () => {
  it("reads mode, starter lab, outcome, and brain off a single-participant computer-use result", () => {
    expect(
      deriveRunFacts({
        schema: "humanish.study-result.v1",
        route: "computer-use",
        ok: true,
        labId: "try-live",
        actor: "openai-computer-use",
        dryRun: false,
        session: {
          status: "passed",
          completionReason: "goal_satisfied",
          reason: "done",
          screenshots: 12,
        },
      }),
    ).toEqual({ mode: "live", study: "try-live", outcome: "passed", brain: "provider-key" });
  });

  it("rolls a fan-out up to all/some/none passed, never per-participant detail", () => {
    const base = { labId: "cua-browser", actor: "openai-computer-use", dryRun: false, ok: true };
    expect(deriveRunFacts({ ...base, laneSummary: { total: 3, passed: 3 } }).outcome).toBe(
      "all_passed",
    );
    expect(deriveRunFacts({ ...base, laneSummary: { total: 3, passed: 1 } }).outcome).toBe(
      "some_passed",
    );
    expect(deriveRunFacts({ ...base, laneSummary: { total: 3, passed: 0 } }).outcome).toBe(
      "none_passed",
    );
  });

  it("reports a dry run as brain none, whatever actor would have run it", () => {
    expect(
      deriveRunFacts({
        labId: "first-run",
        actor: "openai-computer-use",
        dryRun: true,
        ok: true,
      }),
    ).toEqual({ mode: "dry-run", study: "first-run", outcome: "ok", brain: "none" });
  });

  it("names the failure by our own code, and only ours", () => {
    expect(
      deriveRunFacts({
        ok: false,
        labId: "try-live",
        dryRun: false,
        error: { code: "HUMANISH_COMPUTER_USE_KEYS_MISSING", message: "OPENAI_API_KEY is not set" },
      }),
    ).toEqual({
      mode: "live",
      study: "try-live",
      outcome: "error",
      errorCode: "HUMANISH_COMPUTER_USE_KEYS_MISSING",
    });
    const foreign = deriveRunFacts({
      ok: false,
      dryRun: false,
      error: { code: "ECONNREFUSED", message: "x" },
    });
    expect(foreign.errorCode).toBeUndefined();
    expect(foreign.outcome).toBe("error");
  });

  it("never names an adopter's study, and never forwards free-text status", () => {
    const facts = deriveRunFacts({
      labId: "acme-checkout-v2",
      dryRun: false,
      ok: true,
      session: { status: "Finished after the user typed their password" },
    });
    expect(facts.study).toBe("custom");
    expect(facts.outcome).toBeUndefined();
    expect(JSON.stringify(facts)).not.toContain("acme");
    expect(JSON.stringify(facts)).not.toContain("password");
  });

  it("reads the plain run result and the preflight result too", () => {
    expect(
      deriveRunFacts({
        schema: "humanish.run-result.v1",
        ok: true,
        mode: "dry-run",
        runId: "r",
        cwd: "/x",
        warnings: [],
      }),
    ).toEqual({ mode: "dry-run", outcome: "ok" });
    expect(
      deriveRunFacts({
        schema: "humanish.study-check.v1",
        ok: false,
        study: "try-live",
        studyId: "try-live",
        error: { code: "HUMANISH_STUDY_PREFLIGHT_E2B_REQUIRED", message: "m" },
      }),
    ).toEqual({
      study: "try-live",
      outcome: "error",
      errorCode: "HUMANISH_STUDY_PREFLIGHT_E2B_REQUIRED",
    });
  });

  it("says nothing about a result that carries no study", () => {
    expect(
      deriveRunFacts({ schema: "humanish.doctor-result.v1", ok: true, cwd: "/x", checks: [] }),
    ).toEqual({});
    expect(deriveRunFacts("not an object")).toEqual({});
    expect(deriveRunFacts(null)).toEqual({});
  });
});

describe("finite CUA diagnostics", () => {
  it("labels successful N1/N2 previews contract_proof_only, failed previews as errors, and leaves live rollup unchanged", () => {
    for (const total of [1, 2]) {
      const base = {
        schema: "humanish.study-result.v1",
        route: "computer-use",
        dryRun: true,
        ok: true,
        laneSummary: { total, passed: 0 },
        diagnostics: { category: "preview" },
      };
      expect(deriveRunFacts(base).outcome).toBe("contract_proof_only");
      expect(
        deriveRunFacts({ ...base, ok: false, error: { code: "HUMANISH_COMPUTER_USE_FAILED" } })
          .outcome,
      ).toBe("error");
      if (total > 1)
        expect(deriveRunFacts({ ...base, dryRun: false, ok: false }).outcome).toBe("none_passed");
    }
  });

  it("reads only the finite summary, never a first-participant cause or raw failure text", () => {
    expect(
      deriveRunFacts({
        schema: "humanish.study-result.v1",
        route: "computer-use",
        diagnostics: { category: "mixed", stopCause: "mixed" },
        session: { stopCause: "provider_output_limit" },
        reason: "private.example",
        lanes: [{ id: "secret" }],
      }),
    ).toEqual({ diagnosticCategory: "mixed", stopCause: "mixed" });
    expect(
      deriveRunFacts({
        schema: "humanish.study-result.v1",
        route: "computer-use",
        diagnostics: { category: "private.example", stopCause: "secret reason" },
      }),
    ).toEqual({});
    expect(
      deriveRunFacts({
        schema: "another-result",
        diagnostics: { category: "mixed", stopCause: "mixed" },
      }),
    ).toEqual({});
    expect(
      deriveRunFacts({
        schema: "humanish.study-result.v1",
        route: "terminal",
        diagnostics: { category: "mixed", stopCause: "mixed" },
      }),
    ).toEqual({});
  });

  it("names the study from studyId, and from the deprecated labId when studyId is absent", () => {
    const result = { schema: "humanish.study-result.v1", route: "terminal", ok: true };
    expect(deriveRunFacts({ ...result, studyId: "first-run", labId: "other" }).study).toBe(
      "first-run",
    );
    expect(deriveRunFacts({ ...result, labId: "first-run" }).study).toBe("first-run");
  });

  it("rejects injected values again at the final payload boundary", () => {
    const build = (diagnosticCategory: string, stopCause: string) =>
      buildPayload({
        event: "cli_command",
        anonymousId: "a",
        version: "1",
        env: {},
        properties: { diagnosticCategory, stopCause },
      }).properties;
    expect(build("session_interrupted", "adapter_limit")).toMatchObject({
      diagnostic_category: "session_interrupted",
      stop_cause: "adapter_limit",
    });
    expect(build("mixed", "mixed")).toMatchObject({
      diagnostic_category: "mixed",
      stop_cause: "mixed",
    });
    const unknown = build("private.example", "private.example/secret");
    expect(unknown.diagnostic_category).toBeUndefined();
    expect(unknown.stop_cause).toBeUndefined();
    expect(JSON.stringify(unknown)).not.toContain("private.example");
  });
});
