import { describe, expect, it } from "vitest";

import {
  concurrentSharedWorldValidationReason,
  sharedWorldValidationReason,
} from "../../src/study/validation.js";
import {
  resolveEntryUrl,
  isComputerUseComposition,
  isSharedWorldComposition,
  isProvisionedScriptedBrowserComposition,
  isScriptedBrowserComposition,
} from "../../src/study/routing.js";
import { declaredParticipantCount, participantList } from "../../src/study/study-fields.js";
import { STUDY_SCHEMA } from "../../src/study/types.js";
import { declaredParticipantIds } from "../../src/study/plan-participants.js";
import { parseStudy } from "../../src/study/config.js";
import { routeOf } from "../../src/study/plan.js";

type Raw = Record<string, unknown>;

// A copy of a study without some of its keys.
function without(raw: object, ...keys: string[]): Raw {
  const copy: Raw = { ...raw };
  for (const key of keys) delete copy[key];
  return copy;
}

// parseStudy's refusal of a study, as its message.
function refusal(raw: unknown): string {
  const result = parseStudy(raw);
  if (result.ok) throw new Error("expected the study to be refused");
  expect(result.error.code).toBe("HUMANISH_STUDY_INVALID");
  return result.error.message;
}

// A recipient address on the reserved test domain.
const address = (local: string) => [local, "example.test"].join("@");

describe("parseStudy (humanish.study.v3)", () => {
  it("refuses a clone lab whose actor can neither drive nor script the served app", () => {
    // The removed OSS meta-lab used this shape. It parsed, then failed at run start.
    for (const type of ["codex-app-server", "humanish-setup"]) {
      const result = parseStudy({
        schema: STUDY_SCHEMA,
        id: "codex-clone",
        route: "computer-use",
        subject: { source: "clone", repos: ["example-org/example-app"] },
        actor: { type },
        participants: 1,
        execution: { target: "e2b-desktop" },
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe("HUMANISH_STUDY_INVALID");
      expect(result.error.message).toContain(`Got "${type}"`);
    }
    // A terminal actor keeps its own, earlier refusal.
    const terminal = parseStudy({
      schema: STUDY_SCHEMA,
      id: "terminal-clone",
      route: "computer-use",
      subject: { source: "clone", repos: ["example-org/example-app"] },
      actor: { type: "codex-exec" },
      execution: { target: "e2b-desktop" },
    });
    expect(terminal.ok).toBe(false);
    if (!terminal.ok) expect(terminal.error.message).toMatch(/^terminal actors require/);
  });

  it("refuses codexAppServer on a computer-use clone study, which no route reads", () => {
    expect(
      refusal({
        schema: STUDY_SCHEMA,
        id: "cua-clone-codex-app-server",
        route: "computer-use",
        subject: {
          source: "clone",
          repos: ["example-org/example-app"],
          serve: { start: "pnpm start", url: "http://127.0.0.1:3000/" },
        },
        actor: { type: "openai-computer-use", mission: "Look around." },
        execution: { target: "e2b-desktop", desktop: { codexAppServer: true } },
      }),
    ).toBe(
      "route: computer-use does not read execution.desktop.codexAppServer (no current route reads it). Remove it.",
    );
  });

  it("parses a synthetic-shaped lab (this-repo + persona actor, dry-run)", () => {
    const result = parseStudy({
      schema: STUDY_SCHEMA,
      id: "first-run",
      route: "preview",
      mode: "dry-run",
      subject: { source: "this-repo" },
      actor: { type: "synthetic-persona" },
      participants: 4,
      defaults: { open: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.subject.source).toBe("this-repo");
    expect(result.config.actor?.type).toBe("synthetic-persona");
    expect(declaredParticipantCount(result.config)).toBe(4);
    expect(result.config.mode).toBe("dry-run");
    expect(result.warnings).toEqual([]);
  });

  it.each(["pi-agent-core", "claude-agent-sdk"])(
    "rejects the unregistered actor type %s on a route that ignores actor.type",
    (type) => {
      const result = parseStudy({
        schema: STUDY_SCHEMA,
        id: "first-run",
        route: "preview",
        mode: "dry-run",
        subject: { source: "this-repo" },
        actor: { type },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("HUMANISH_STUDY_INVALID");
      expect(result.error.message).toContain(`"${type}"`);
      expect(result.error.message).toContain("local-agent");
      // codex-app-server is registered, but no study route dispatches its "code" run kind.
      expect(result.error.message).not.toContain("codex-app-server");
    },
  );

  it("parses a comms:email:fake block (adopter-named injectEnv, port, declared recipients)", () => {
    const result = parseStudy({
      schema: STUDY_SCHEMA,
      id: "comms-lab",
      route: "computer-use",
      mode: "live",
      subject: {
        source: "clone",
        repos: ["example-org/user-app"],
        serve: { start: "pnpm start", url: "http://127.0.0.1:3000/" },
      },
      actor: { type: "openai-computer-use" },
      participants: 1,
      execution: { target: "e2b-desktop" },
      comms: {
        email: {
          kind: "fake",
          injectEnv: "RESEND_API_URL",
          port: 9100,
          recipients: [{ lane: "lane-01", address: address("user") }],
        },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.comms?.email).toEqual({
      kind: "fake",
      injectEnv: "RESEND_API_URL",
      port: 9100,
      recipients: [{ lane: "lane-01", address: address("user") }],
    });
  });

  it("comms recipients fail loud on unknown participants, fill per-participant when omitted, and warn on partial coverage", () => {
    const multiParticipant = (comms?: Record<string, unknown>) => ({
      schema: STUDY_SCHEMA,
      id: "comms-multi",
      route: "computer-use",
      mode: "live",
      subject: {
        source: "clone",
        repos: ["e/a"],
        serve: { start: "pnpm start", url: "http://127.0.0.1:3000/" },
      },
      actor: { type: "openai-computer-use", mission: "Sign up." },
      participants: [
        { id: "signup-01", instruction: "Sign up." },
        { id: "signup-02", instruction: "Sign up." },
        { id: "signup-03", instruction: "Sign up." },
      ],
      execution: { target: "e2b-desktop" },
      ...(comms === undefined ? {} : { comms }),
    });

    // A recipient naming a participant that does not exist is a hard error listing the real
    // participant ids: the single-participant example's `lane-01` copied into a study with a
    // participants list is the field failure this guards against (an unmatched `lane` silently
    // disabled the whole funnel for that participant).
    const unknownLane = parseStudy(
      multiParticipant({
        email: {
          injectEnv: "RESEND_API_URL",
          recipients: [{ lane: "lane-01", address: address("a") }],
        },
      }),
    );
    expect(unknownLane.ok).toBe(false);
    if (!unknownLane.ok) {
      expect(unknownLane.error.message).toContain('"lane-01"');
      expect(unknownLane.error.message).toContain("signup-01, signup-02, signup-03");
    }

    // Declared recipients covering zero participants with an address = a guaranteed-dead funnel →
    // error.
    const zeroCoverage = parseStudy(
      multiParticipant({
        email: { injectEnv: "RESEND_API_URL", recipients: [{ lane: "signup-01" }] },
      }),
    );
    expect(zeroCoverage.ok).toBe(false);
    if (!zeroCoverage.ok)
      expect(zeroCoverage.error.message).toContain("no participant with an address");

    // Omitted recipients fill one deterministic address per participant: all participants can do
    // email.
    const filled = parseStudy(multiParticipant({ email: { injectEnv: "RESEND_API_URL" } }));
    expect(filled.ok).toBe(true);
    if (filled.ok) {
      expect(filled.config.comms?.email?.recipients).toEqual([
        { lane: "signup-01", address: address("signup-01") },
        { lane: "signup-02", address: address("signup-02") },
        { lane: "signup-03", address: address("signup-03") },
      ]);
      expect(filled.warnings.filter((w) => w.includes("comms.email covers"))).toEqual([]);
    }

    // Partial coverage is legal but loud: the uncovered participants are named.
    const partial = parseStudy(
      multiParticipant({
        email: {
          injectEnv: "RESEND_API_URL",
          recipients: [{ lane: "signup-01", address: address("a") }],
        },
      }),
    );
    expect(partial.ok).toBe(true);
    if (partial.ok) {
      expect(partial.warnings.join("\n")).toContain("covers 1 of 3 participants");
      expect(partial.warnings.join("\n")).toContain("signup-02, signup-03");
    }
  });

  it("declaredParticipantIds mirrors the engine's participant ids, so recipient validation cannot drift", () => {
    const base = {
      schema: STUDY_SCHEMA,
      id: "lanes",
      route: "computer-use",
      mode: "dry-run",
      subject: {
        source: "clone",
        repos: ["e/a"],
        serve: { start: "pnpm start", url: "http://127.0.0.1:3000/" },
      },
      actor: { type: "openai-computer-use" },
      execution: { target: "e2b-desktop" },
    };
    const single = parseStudy({ ...base, participants: 1 });
    expect(single.ok).toBe(true);
    if (single.ok) expect(declaredParticipantIds(single.config)).toEqual(["lane-01"]);
    const counted = parseStudy({ ...base, participants: 3 });
    expect(counted.ok).toBe(true);
    if (counted.ok)
      expect(declaredParticipantIds(counted.config)).toEqual(["lane-01", "lane-02", "lane-03"]);
    const listed = parseStudy({ ...base, participants: [{ id: "host" }, { id: "guest" }] });
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(declaredParticipantIds(listed.config)).toEqual(["host", "guest"]);
  });

  it("defaults comms:email kind to fake and requires a valid injectEnv name", () => {
    const base = {
      schema: STUDY_SCHEMA,
      id: "c",
      route: "computer-use",
      mode: "live",
      subject: {
        source: "clone",
        repos: ["e/a"],
        serve: { start: "pnpm start", url: "http://127.0.0.1:3000/" },
      },
      actor: { type: "openai-computer-use" },
      participants: 1,
      execution: { target: "e2b-desktop" },
    };
    const ok = parseStudy({ ...base, comms: { email: { injectEnv: "RESEND_API_URL" } } });
    expect(ok.ok).toBe(true);
    // Omitted recipients are filled one per participant: a single-participant study gets
    // `lane-01` an address on the test domain, so the actor is told its address and the drain can
    // match the mail: email works out of the box.
    if (ok.ok)
      expect(ok.config.comms?.email).toEqual({
        kind: "fake",
        injectEnv: "RESEND_API_URL",
        recipients: [{ lane: "lane-01", address: address("lane-01") }],
      });

    // Fail-loud (never silently swallowed): missing injectEnv, an invalid env name, and real kind all reject.
    expect(parseStudy({ ...base, comms: { email: { kind: "fake" } } }).ok).toBe(false);
    expect(parseStudy({ ...base, comms: { email: { injectEnv: "not a var" } } }).ok).toBe(false);
    expect(
      parseStudy({
        ...base,
        comms: { email: { kind: "real", injectEnv: "RESEND_API_URL" } },
      }).ok,
    ).toBe(false);

    // linkOrigin escape hatch: a valid absolute origin parses; a non-URL rejects.
    const withOrigin = parseStudy({
      ...base,
      comms: { email: { injectEnv: "RESEND_API_URL", linkOrigin: "https://app.example.test" } },
    });
    expect(withOrigin.ok).toBe(true);
    if (withOrigin.ok)
      expect(withOrigin.config.comms?.email?.linkOrigin).toBe("https://app.example.test");
    expect(
      parseStudy({
        ...base,
        comms: { email: { injectEnv: "RESEND_API_URL", linkOrigin: "not a url" } },
      }).ok,
    ).toBe(false);

    // port is capped at 65534 (the catch reserves port+1 for the 0.0.0.0 inbox listener).
    expect(
      parseStudy({
        ...base,
        comms: { email: { injectEnv: "RESEND_API_URL", port: 65534 } },
      }).ok,
    ).toBe(true);
    expect(
      parseStudy({
        ...base,
        comms: { email: { injectEnv: "RESEND_API_URL", port: 65535 } },
      }).ok,
    ).toBe(false);
  });

  it("accepts a free-form actor.type on non-app-url routes (registry-resolved only where consumed)", () => {
    // The contract: on this-repo/clone routes actor.type is a free-form label and routing
    // ignores it. Only the app-url (computer-use) route resolves it against the actor registry,
    // because only there does the descriptor actually run the session.
    const result = parseStudy({
      schema: STUDY_SCHEMA,
      id: "future",
      route: "preview",
      subject: { source: "this-repo" },
      actor: { type: "some-actor-not-in-the-registry" },
    });
    expect(result.ok).toBe(true);
  });

  it("refuses each field its route does not read, by name, rather than ignoring it", () => {
    expect(
      refusal({
        schema: STUDY_SCHEMA,
        id: "forward",
        route: "preview",
        subject: { source: "this-repo" },
        actor: { type: "synthetic-persona", mission: "do a thing", persona: "p1" },
        review: { scoring: "custom" },
      }),
    ).toBe(
      "route: preview does not read actor.mission, actor.persona, review.scoring (reserved; no route reads it yet). Remove them.",
    );
  });

  const minimal = {
    schema: STUDY_SCHEMA,
    id: "x",
    route: "preview",
    subject: { source: "this-repo" },
    actor: { type: "a" },
  };
  it.each([
    ["wrong schema", { ...minimal, schema: "humanish.lab.v1" }],
    ["missing id", without(minimal, "id")],
    ["id with space", { ...minimal, id: "has space" }],
    ["id not starting alphanumeric", { ...minimal, id: ".hidden" }],
    ["no subject", without(minimal, "subject")],
    ["bad subject source", { ...minimal, subject: { source: "vm" } }],
    ["clone without repos", { ...minimal, subject: { source: "clone" } }],
    ["actor without type", { ...minimal, actor: {}, participants: 1 }],
    ["bad execution target", { ...minimal, execution: { target: "vm" } }],
    ["non-positive resolution", { ...minimal, execution: { desktop: { resolution: [0, -1] } } }],
    ["this-repo with execution.target", { ...minimal, execution: { target: "e2b-desktop" } }],
    ["this-repo with live mode", { ...minimal, mode: "live" }],
  ])("rejects invalid config: %s", (_label, input) => {
    const result = parseStudy(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_STUDY_INVALID");
  });

  describe("app-url (computer-use route)", () => {
    const validCua = {
      schema: STUDY_SCHEMA,
      id: "cua-browser",
      route: "computer-use",
      mode: "dry-run",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actor: {
        type: "openai-computer-use",
        persona: "first-time-visitor",
        mission: "Explore the app.",
        model: "gpt-5.5",
      },
      participants: { instruction: "Focus on onboarding." },
      execution: {
        target: "e2b-desktop",
        timeoutMs: 120000,
        desktop: { resolution: [1280, 800], sandboxTimeoutMs: 600000 },
      },
    };
    // validCua with another actor, and participants only when given.
    const cuaWith = (actor: Raw, participants?: unknown): Raw => ({
      ...without(validCua, "actor", "participants"),
      actor,
      ...(participants === undefined ? {} : { participants }),
    });

    it("parses a computer-use study with zero warnings: every set field is consumed on this route", () => {
      const result = parseStudy(validCua);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.subject).toEqual({
        source: "app-url",
        appUrl: "http://127.0.0.1:3000/",
      });
      expect(result.config.actor?.type).toBe("openai-computer-use");
      expect(result.warnings).toEqual([]);
    });

    it("consumes execution.concurrency on the computer-use route (no warning) and refuses it elsewhere", () => {
      // Consumed here (bounds in-flight fan-out participants) → zero warnings.
      const onCua = parseStudy({
        ...validCua,
        execution: { ...validCua.execution, concurrency: 2 },
      });
      expect(onCua.ok).toBe(true);
      if (!onCua.ok) return;
      expect(onCua.warnings).toEqual([]);

      // Refused on a route that does not consume it (regression guard).
      expect(
        refusal({
          schema: STUDY_SCHEMA,
          id: "synthetic-concurrency",
          route: "preview",
          subject: { source: "this-repo" },
          actor: { type: "synthetic-persona" },
          execution: { concurrency: 2 },
        }),
      ).toBe("route: preview does not read execution.concurrency. Remove it.");
    });

    it("refuses an id or label on the `{ count, instruction }` form, which every participant shares", () => {
      const cua = { type: "openai-computer-use" };
      expect(refusal(cuaWith(cua, { id: "lane-1", label: "Lane one" }))).toMatch(
        /^Unknown study field in `participants`: label\. /,
      );
      expect(refusal(cuaWith(cua, { id: "lane-1" }))).toBe(
        "`participants` as an object takes only `count` and `instruction`, and every participant gets them. To set `id`, write participants as a list.",
      );
    });

    it("refuses comms.email on an app-url subject: the in-sandbox catch has no sandbox to host", () => {
      const message = refusal({
        ...validCua,
        comms: {
          email: {
            injectEnv: "RESEND_API_URL",
            recipients: [{ lane: "lane-01", address: address("user") }],
          },
        },
      });
      expect(message).toMatch(/^route: computer-use does not read comms\.email /);
      expect(message).toContain("`subject.source: clone` or `local-tree`");
    });

    it("does not warn about comms.email on a clone subject, which the catch can host", () => {
      const result = parseStudy({
        schema: STUDY_SCHEMA,
        id: "clone-comms",
        route: "computer-use",
        subject: {
          source: "clone",
          repos: ["example-org/example-app"],
          serve: { start: "pnpm start", url: "http://127.0.0.1:3000/" },
        },
        actor: { type: "openai-computer-use", mission: "Explore." },
        execution: { target: "e2b-desktop" },
        comms: {
          email: {
            injectEnv: "RESEND_API_URL",
            recipients: [{ lane: "lane-01", address: address("user") }],
          },
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.warnings.some((warning) => warning.includes("comms.email"))).toBe(false);
    });

    it("parses actor-level and per-participant deterministic stopWhen guards", () => {
      const result = parseStudy(
        cuaWith(
          {
            type: "openai-computer-use",
            mission: "Exercise each lane.",
            stopWhen: { any: [{ id: "actor-done", textIncludes: "Saved" }] },
          },
          [
            { id: "lane-a", persona: "reviewer", instruction: "Review the item." },
            {
              id: "lane-b",
              persona: "approver",
              instruction: "Approve the item.",
              stopWhen: { any: [{ id: "lane-approved", urlPathEquals: "/done" }] },
            },
          ],
        ),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.actor?.stopWhen?.any[0]?.textIncludes).toBe("Saved");
      expect(participantList(result.config)?.[1]?.stopWhen?.any[0]?.urlPathEquals).toBe("/done");
      expect(result.warnings).toEqual([]);
    });

    it.each([
      ["empty any", { any: [] }],
      ["bad rule id", { any: [{ id: "bad id", textIncludes: "Saved" }] }],
      ["rule without condition", { any: [{ id: "done" }] }],
      ["bad urlPathEquals", { any: [{ urlPathEquals: "tasks" }] }],
      [
        "bad appState path",
        { any: [{ appStatePathEquals: { path: "bad/path", equals: "done" } }] },
      ],
      [
        "non-primitive equals",
        { any: [{ appStatePathEquals: { path: "status", equals: { value: "done" } } }] },
      ],
    ])("rejects invalid stopWhen: %s", (_label, stopWhen) => {
      const result = parseStudy(cuaWith({ type: "openai-computer-use", stopWhen }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("stopWhen");
    });

    it("parses an actor-level dwell window with defaults and a participant-level override", () => {
      const result = parseStudy(
        cuaWith(
          {
            type: "openai-computer-use",
            mission: "Join, stay a while, leave.",
            dwell: { when: { any: [{ id: "in-room", urlIncludes: "/room/" }] }, ms: 120_000 },
          },
          [
            { id: "lane-a", persona: "reviewer", instruction: "Join the room." },
            {
              id: "lane-b",
              persona: "approver",
              instruction: "Join the room.",
              dwell: { ms: 30_000, everyMs: 5_000, then: "stop" },
            },
          ],
        ),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.actor?.dwell).toEqual({
        when: { any: [{ id: "in-room", urlIncludes: "/room/" }] },
        ms: 120_000,
        everyMs: 10_000,
        then: "continue",
      });
      expect(participantList(result.config)?.[1]?.dwell).toEqual({
        ms: 30_000,
        everyMs: 5_000,
        then: "stop",
      });
      expect(participantList(result.config)?.[0]?.dwell).toBeUndefined();
    });

    it.each([
      ["not an object", 5000],
      ["ms missing", { everyMs: 1000 }],
      ["ms below a second", { ms: 500 }],
      ["ms above an hour", { ms: 3_600_001 }],
      ["everyMs above ms", { ms: 5_000, everyMs: 6_000 }],
      ["then unknown", { ms: 5_000, then: "pause" }],
      ["when invalid", { ms: 5_000, when: { any: [] } }],
    ])("rejects an invalid dwell window: %s", (_label, dwell) => {
      const result = parseStudy(cuaWith({ type: "openai-computer-use", dwell }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("dwell");
    });

    it("parses a synthetic camera and the permission policy", () => {
      const result = parseStudy({
        ...validCua,
        execution: {
          ...validCua.execution,
          desktop: { media: { camera: { source: "synthetic" } } },
        },
        policies: { mediaPermission: "granted" },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.execution?.desktop?.media).toEqual({ camera: { source: "synthetic" } });
      expect(result.config.policies?.mediaPermission).toBe("granted");
    });

    it("accepts a .y4m camera file and defaults the permission to the participant's own answer", () => {
      const result = parseStudy({
        ...validCua,
        execution: {
          ...validCua.execution,
          desktop: { media: { camera: { source: "./assets/participant.y4m" } } },
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.execution?.desktop?.media?.camera?.source).toBe(
        "./assets/participant.y4m",
      );
      expect(result.config.policies?.mediaPermission).toBeUndefined();
    });

    it.each([
      [
        "camera source with the wrong extension",
        { media: { camera: { source: "./cam.mp4" } } },
        "camera.source",
      ],
      ["camera without a source", { media: { camera: {} } }, "camera.source"],
      ["media with neither device", { media: {} }, "neither"],
      [
        "a microphone on the stock image",
        { media: { microphone: { source: "./room.wav" } } },
        "injection is unsupported",
      ],
    ])("rejects %s before any spend", (_label, desktop, needle) => {
      const result = parseStudy({ ...validCua, execution: { ...validCua.execution, desktop } });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain(needle);
    });

    it("rejects unimplemented microphone file injection even with a custom desktop template", () => {
      const result = parseStudy({
        ...validCua,
        execution: {
          ...validCua.execution,
          desktop: {
            template: "adopter-desktop-with-audio",
            media: { microphone: { source: "./room.wav" } },
          },
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error.message).toContain("Microphone source-file injection is unsupported");
    });

    it("rejects an unknown mediaPermission", () => {
      const result = parseStudy({ ...validCua, policies: { mediaPermission: "auto" } });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("mediaPermission");
    });

    it("refuses mission and model on routes that do not consume them", () => {
      expect(
        refusal({
          schema: STUDY_SCHEMA,
          id: "preview-with-prompt-fields",
          route: "preview",
          subject: { source: "this-repo" },
          actor: { type: "synthetic-persona", mission: "inert here", model: "inert" },
        }),
      ).toBe("route: preview does not read actor.mission, actor.model. Remove them.");
    });

    it.each([
      ["missing appUrl", { ...validCua, subject: { source: "app-url" } }],
      [
        "public URL",
        { ...validCua, subject: { source: "app-url", appUrl: "https://example.com/" } },
      ],
      [
        "non-http scheme",
        { ...validCua, subject: { source: "app-url", appUrl: "file:///tmp/index.html" } },
      ],
      ["not a URL", { ...validCua, subject: { source: "app-url", appUrl: "localhost:3000" } }],
      ["missing e2b-desktop target", { ...validCua, execution: { timeoutMs: 1000 } }],
      ["unregistered actor type", cuaWith({ type: "not-a-real-actor" })],
      ["registered but not computer-use", cuaWith({ type: "codex-app-server" })],
    ])("fails closed on cua mis-config: %s", (_label, input) => {
      const result = parseStudy(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("HUMANISH_STUDY_INVALID");
    });

    describe("multi-participant fan-out", () => {
      it.each(["misson", "runtme", "constructor"])(
        "rejects an unknown participant field %s before it can disappear",
        (key) => {
          const result = parseStudy(
            cuaWith({ type: "openai-computer-use" }, [{ id: "reader", [key]: "different" }]),
          );
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.error.code).toBe("HUMANISH_STUDY_INVALID");
          expect(result.error.message).toContain(
            "Unknown study field in `participants[0]`: " + key,
          );
        },
      );

      it("names all unknown participant fields at the declared entry index after groups expand", () => {
        const result = parseStudy(
          cuaWith({ type: "openai-computer-use" }, [
            { id: "reader", count: 2 },
            { id: "reviewer", count: 2, misson: "Review", runtme: null },
          ]),
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("HUMANISH_STUDY_INVALID");
        expect(result.error.message).toContain(
          "Unknown study fields in `participants[1]`: misson, runtme",
        );
        expect(result.error.message).not.toContain("participants[2]");
      });

      it.each(["single", "counted"] as const)(
        "keeps supported optional fields on a %s participant entry after closing the key set",
        (form) => {
          const shared = {
            actorType: "reader",
            surface: "queue",
            caseGroup: "case-01",
            persona: "curious-reviewer",
            device: "desktop",
            instruction: "Read the queue.",
            reasoningEffort: "low",
            stopWhen: { any: [{ textIncludes: "Done" }] },
            dwell: { ms: 1000, everyMs: 1000, then: "continue" },
            host: false,
          };
          const study = (entry: Raw): Raw => ({
            ...cuaWith({ type: "openai-computer-use" }, [
              { ...entry, id: "reader", ...(form === "counted" ? { count: 2 } : {}) },
            ]),
            execution: { target: "e2b-desktop", timeoutMs: 120000 },
          });
          const result = parseStudy(study(shared));
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const { host: _host, ...preserved } = shared;
          expect(participantList(result.config)).toEqual(
            form === "single"
              ? [{ ...preserved, id: "reader" }]
              : [
                  { ...preserved, id: "reader-01" },
                  { ...preserved, id: "reader-02" },
                ],
          );
          // A participant's entry path is read only in a shared world.
          expect(refusal(study({ ...shared, entry: "/queue" }))).toMatch(
            /^route: computer-use does not read participants\[\]\.entry /,
          );
        },
      );

      it("accepts a homogeneous count > 1 on the computer-use route (lifted rejection), default concurrency min(N,3)", () => {
        const result = parseStudy(cuaWith({ type: "openai-computer-use" }, 4));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(declaredParticipantCount(result.config)).toBe(4);
        expect(result.warnings).toEqual([]);
      });

      it("accepts a `participants` list (per-participant persona/device/instruction)", () => {
        const result = parseStudy({
          ...cuaWith({ type: "openai-computer-use", mission: "Explore the app." }, [
            {
              id: "mobile-newcomer",
              persona: "first-time-visitor",
              device: "mobile",
              instruction: "Sign up from a phone.",
            },
            {
              id: "desktop-power",
              persona: "power-user",
              device: "wide",
              instruction: "Find advanced settings.",
            },
          ]),
          execution: { target: "e2b-desktop", timeoutMs: 120000, concurrency: 2 },
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(participantList(result.config)).toHaveLength(2);
        expect(result.warnings).toEqual([]);
      });

      it("accepts explicit per-participant public targets when every participant declares one and the owner opts in", () => {
        const result = parseStudy({
          ...cuaWith({ type: "openai-computer-use", mission: "Exercise each declared target." }, [
            {
              id: "role-a",
              target: "https://role-a.preview.example.test/app",
              persona: "role-a",
            },
            {
              id: "role-b",
              target: "https://role-b.preview.example.test/app",
              persona: "role-b",
            },
          ]),
          subject: { source: "app-url", appUrl: "https://fallback.preview.example.test/" },
          policies: { allowPublicTargets: true },
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(participantList(result.config)?.map((entry) => entry.target)).toEqual([
          "https://role-a.preview.example.test/app",
          "https://role-b.preview.example.test/app",
        ]);
        expect(result.warnings).toEqual([]);
      });

      it("expands participant entries with a count into deterministic participants", () => {
        const result = parseStudy({
          ...cuaWith({ type: "openai-computer-use", mission: "Exercise each app surface." }, [
            {
              id: "viewer",
              count: 3,
              actorType: "viewer",
              surface: "review-queue",
              caseGroup: "case-001",
              persona: "curious-reviewer",
              device: "desktop",
              instruction: "Review one assigned item.",
            },
            {
              id: "manager",
              count: 1,
              actorType: "manager",
              surface: "dashboard",
              caseGroup: "case-001",
              persona: "operations-lead",
              device: "wide",
              instruction: "Check the dashboard summary.",
            },
          ]),
          execution: { target: "e2b-desktop", timeoutMs: 120000, concurrency: 2 },
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(participantList(result.config)?.map((entry) => entry.id)).toEqual([
          "viewer-01",
          "viewer-02",
          "viewer-03",
          "manager-01",
        ]);
        expect(
          participantList(result.config)?.map((entry) => [
            entry.actorType,
            entry.surface,
            entry.caseGroup,
            entry.device,
          ]),
        ).toEqual([
          ["viewer", "review-queue", "case-001", "desktop"],
          ["viewer", "review-queue", "case-001", "desktop"],
          ["viewer", "review-queue", "case-001", "desktop"],
          ["manager", "dashboard", "case-001", "wide"],
        ]);
        // The declared cap (2) is below the 4-participant list, and the parser says so out loud:
        // a green run in waves must never be mistaken for the all-live run the list promises.
        expect(result.warnings).toEqual([
          expect.stringContaining("execution.concurrency 2 caps a 4-participant roster"),
        ]);
      });

      const cua = { type: "openai-computer-use" };
      it.each([
        [
          "participants[].device XOR raw resolution",
          {
            ...cuaWith(cua, [{ id: "a", device: "mobile" }, { id: "b" }]),
            execution: { target: "e2b-desktop", desktop: { resolution: [1280, 800] } },
          },
        ],
        ["over the 100-participant limit (count)", cuaWith(cua, 101)],
        [
          "over the 100-participant limit (list)",
          cuaWith(
            cua,
            Array.from({ length: 101 }, (_v, i) => ({ id: `viewer-${i}` })),
          ),
        ],
        [
          "over the 100-participant limit (counted entry)",
          cuaWith(cua, [{ id: "viewer", count: 101 }]),
        ],
        ["duplicate lane ids", cuaWith(cua, [{ id: "dup" }, { id: "dup" }])],
        [
          "duplicate counted entry ids",
          cuaWith(cua, [
            { id: "dup", count: 1 },
            { id: "dup", count: 1 },
          ]),
        ],
        ["bad lane id shape", cuaWith(cua, [{ id: "Bad Id!" }, { id: "ok" }])],
        ["bad counted entry id shape", cuaWith(cua, [{ id: "Bad Id!", count: 1 }])],
        ["unknown lane device", cuaWith(cua, [{ id: "a", device: "phablet" }, { id: "b" }])],
        [
          "unknown counted entry device",
          cuaWith(cua, [{ id: "viewer", count: 1, device: "phablet" }]),
        ],
        [
          "bad lane target URL",
          cuaWith(cua, [
            { id: "a", target: "not-a-url" },
            { id: "b", target: "http://127.0.0.1:3001/" },
          ]),
        ],
        [
          "mixed target/no-target roster",
          cuaWith(cua, [{ id: "a", target: "http://127.0.0.1:3001/" }, { id: "b" }]),
        ],
        [
          "target mixed with shared-world entry",
          cuaWith(cua, [
            { id: "a", target: "http://127.0.0.1:3001/", entry: "/a" },
            { id: "b", target: "http://127.0.0.1:3002/" },
          ]),
        ],
        [
          "public lane target without allowPublicTargets",
          cuaWith(cua, [
            { id: "a", target: "https://role-a.preview.example.test/" },
            { id: "b", target: "https://role-b.preview.example.test/" },
          ]),
        ],
        [
          "allowPublicTargets + N>1",
          {
            ...cuaWith(cua, 2),
            subject: { source: "app-url", appUrl: "https://preview.example.com/" },
            policies: { allowPublicTargets: true },
          },
        ],
      ])("fails closed on fan-out mis-config: %s", (_label, input) => {
        const result = parseStudy(input);
        expect(result.ok, _label).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("HUMANISH_STUDY_INVALID");
      });

      it("refuses a `participants` list on a route that takes a count", () => {
        expect(
          refusal({
            schema: STUDY_SCHEMA,
            id: "synthetic-lanes",
            route: "preview",
            subject: { source: "this-repo" },
            actor: { type: "synthetic-persona" },
            participants: [{ id: "a" }, { id: "b" }],
          }),
        ).toBe("route: preview takes `participants` as a count, such as `participants: 4`.");
      });
    });

    it("names the registered computer-use actors in the unsupported-actor error", () => {
      const result = parseStudy(cuaWith({ type: "codex-app-server" }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("openai-computer-use");
      expect(result.error.message).toContain('"codex-app-server"');
    });

    it("accepts loopback variants (localhost, [::1]) and https", () => {
      for (const appUrl of [
        "http://localhost:8080/app",
        "https://127.0.0.1/",
        "http://[::1]:3000/",
      ]) {
        const result = parseStudy({ ...validCua, subject: { source: "app-url", appUrl } });
        expect(result.ok, appUrl).toBe(true);
      }
    });

    it("policies.allowPublicTargets demotes the loopback wall: a public appUrl parses with it, fails without it", () => {
      const publicTarget = {
        ...validCua,
        subject: { source: "app-url", appUrl: "https://preview-123.vercel.app/" },
      };
      // Without the policy: rejected (safe default).
      const blocked = parseStudy(publicTarget);
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.error.message).toContain("allowPublicTargets");
      // With the policy: the owner has declared the target; accepted.
      const allowed = parseStudy({
        ...publicTarget,
        policies: { allowPublicTargets: true },
      });
      expect(allowed.ok).toBe(true);
      if (allowed.ok) expect(allowed.config.subject.appUrl).toBe("https://preview-123.vercel.app/");
      // A garbage non-URL is still rejected even with the policy (shape gate holds).
      const garbage = parseStudy({
        ...publicTarget,
        subject: { source: "app-url", appUrl: "not a url" },
        policies: { allowPublicTargets: true },
      });
      expect(garbage.ok).toBe(false);
    });

    it("policies.redactScreenshots parses on the computer-use route with zero warnings (it is consumed)", () => {
      const result = parseStudy({ ...validCua, policies: { redactScreenshots: true } });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.policies?.redactScreenshots).toBe(true);
      expect(result.warnings).toEqual([]);
    });

    it("execution.desktop.device parses on the computer-use route with zero warnings (consumed)", () => {
      const result = parseStudy({
        ...validCua,
        execution: { target: "e2b-desktop", timeoutMs: 120000, desktop: { device: "mobile" } },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.execution?.desktop?.device).toBe("mobile");
      expect(result.warnings).toEqual([]);
    });

    it("execution.desktop.browser parses on the computer-use route with zero warnings (consumed)", () => {
      const result = parseStudy({
        ...validCua,
        execution: { target: "e2b-desktop", timeoutMs: 120000, desktop: { browser: "chrome" } },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.execution?.desktop?.browser).toBe("chrome");
      expect(result.warnings).toEqual([]);
    });

    it("execution.desktop.fidelity parses on the computer-use route with zero warnings, and rejects bad shapes", () => {
      const ok = parseStudy({
        ...validCua,
        execution: {
          target: "e2b-desktop",
          timeoutMs: 120000,
          desktop: {
            device: "mobile",
            fidelity: {
              mobileEmulation: true,
              deviceScaleFactor: 2,
              touch: true,
              userAgent: "Mozilla/5.0 (Linux; Android 14) Mobile",
            },
          },
        },
      });
      expect(ok.ok).toBe(true);
      if (!ok.ok) return;
      expect(ok.config.execution?.desktop?.fidelity).toEqual({
        mobileEmulation: true,
        deviceScaleFactor: 2,
        touch: true,
        userAgent: "Mozilla/5.0 (Linux; Android 14) Mobile",
      });
      expect(ok.warnings).toEqual([]);

      for (const [fidelity, needle] of [
        [{ touch: true }, "mobileEmulation"],
        [{ mobileEmulation: "yes" }, "mobileEmulation"],
        [{ mobileEmulation: true, deviceScaleFactor: 0 }, "deviceScaleFactor"],
        [{ mobileEmulation: true, deviceScaleFactor: 9 }, "deviceScaleFactor"],
        [{ mobileEmulation: true, touch: "on" }, "touch"],
        [{ mobileEmulation: true, userAgent: "   " }, "userAgent"],
      ] as const) {
        const bad = parseStudy({
          ...validCua,
          execution: { target: "e2b-desktop", timeoutMs: 120000, desktop: { fidelity } },
        });
        expect(bad.ok, JSON.stringify(fidelity)).toBe(false);
        if (bad.ok) continue;
        expect(bad.error.message).toContain(needle);
      }
    });

    it("rejects an unknown desktop browser", () => {
      const result = parseStudy({
        ...validCua,
        execution: { target: "e2b-desktop", timeoutMs: 120000, desktop: { browser: "safari" } },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("execution.desktop.browser");
      expect(result.error.message).toContain("chrome");
    });

    it("rejects an unknown device preset", () => {
      const result = parseStudy({
        ...validCua,
        execution: { target: "e2b-desktop", timeoutMs: 120000, desktop: { device: "foldable" } },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("execution.desktop.device");
      expect(result.error.message).toContain("mobile");
    });

    const scriptedLocal = (desktop: Raw): Raw => ({
      schema: STUDY_SCHEMA,
      id: "scripted-device",
      route: "scripted",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actor: { type: "scripted-browser" },
      scenario: "scripted-first-run",
      execution: { target: "local", desktop },
    });

    it("refuses execution.desktop.device on a non-computer-use route", () => {
      expect(refusal(scriptedLocal({ device: "mobile" }))).toBe(
        "route: scripted does not read execution.desktop.device. Remove it.",
      );
    });

    it("refuses execution.desktop.browser on a non-computer-use route", () => {
      expect(refusal({ ...scriptedLocal({ browser: "chrome" }), id: "scripted-browser" })).toBe(
        "route: scripted does not read execution.desktop.browser. Remove it.",
      );
    });

    it("execution.desktop.template parses + trims on the computer-use route with zero warnings (consumed; any string is a valid name/id)", () => {
      const result = parseStudy({
        ...validCua,
        execution: {
          target: "e2b-desktop",
          timeoutMs: 120000,
          desktop: { template: "  acme-desktop-with-runtimes  " },
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.execution?.desktop?.template).toBe("acme-desktop-with-runtimes");
      expect(result.warnings).toEqual([]);
    });

    it("rejects a blank/whitespace execution.desktop.template (set-but-empty is a mistake, not a template)", () => {
      const result = parseStudy({
        ...validCua,
        execution: { target: "e2b-desktop", timeoutMs: 120000, desktop: { template: "   " } },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("execution.desktop.template");
    });

    it("refuses execution.desktop.template on the local-app route (routes to cua but creates no desktop)", () => {
      const study = {
        schema: STUDY_SCHEMA,
        id: "local-app-template",
        route: "computer-use",
        subject: { source: "local-app", appUrl: "http://localhost:5173/" },
        actor: { type: "openai-computer-use", mission: "Drive the app." },
        execution: { target: "local", desktop: { template: "acme-desktop-with-runtimes" } },
      };
      // It routes to the computer-use route, but the in-process route launches no E2B desktop, so
      // the template can never be consumed here → it is refused, never silently ignored.
      const routed = parseStudy({ ...study, execution: { target: "local" } });
      expect(routed.ok && isComputerUseComposition(routed.config)).toBe(true);
      expect(refusal(study)).toMatch(
        /^route: computer-use does not read execution\.desktop\.template /,
      );
    });
  });

  describe("app-url (scripted-browser route)", () => {
    const validScripted = {
      schema: STUDY_SCHEMA,
      id: "scripted-demo",
      route: "scripted",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:5173/" },
      actor: { type: "scripted-browser", persona: "synthetic-new-user" },
      surfaces: ["desktop", "mobile"],
      scenario: "scripted-first-run",
      execution: { target: "local", timeoutMs: 60000 },
    };
    // validScripted as a computer-use study: no surfaces and no scenario.
    const asComputerUse = (actor: Raw): Raw => ({
      ...without(validScripted, "surfaces", "scenario"),
      route: "computer-use",
      actor,
    });

    it("parses a scripted study with zero warnings: every set field is consumed on this route", () => {
      const result = parseStudy(validScripted);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.actor?.type).toBe("scripted-browser");
      expect(result.config.scenario).toBe("scripted-first-run");
      expect(result.warnings).toEqual([]);
    });

    it("accepts an absent execution.target (absent means local on this route)", () => {
      const result = parseStudy({ ...validScripted, execution: { timeoutMs: 60000 } });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.warnings).toEqual([]);
    });

    it("accepts surfaces [desktop] and [desktop, mobile]", () => {
      for (const surfaces of [["desktop"], ["desktop", "mobile"]]) {
        const result = parseStudy({
          ...validScripted,
          actor: { type: "scripted-browser" },
          surfaces,
        });
        expect(result.ok, surfaces.join(", ")).toBe(true);
        if (result.ok) expect(result.config.surfaces?.length).toBe(surfaces.length);
      }
    });

    it.each([
      ["scripted actor on e2b-desktop", { ...validScripted, execution: { target: "e2b-desktop" } }],
      [
        "scripted actor on this-repo",
        { ...validScripted, subject: { source: "this-repo" }, execution: undefined },
      ],
      ["missing scenario (the steps ARE the actor)", { ...validScripted, scenario: undefined }],
      ["mode without scenario", { ...validScripted, scenario: undefined, mode: "live" }],
      [
        "policies.redactScreenshots: true (blur unimplemented here; no silent raw)",
        { ...validScripted, policies: { redactScreenshots: true } },
      ],
      [
        "policies.allowPublicTargets: true (driver enforces loopback per step)",
        { ...validScripted, policies: { allowPublicTargets: true } },
      ],
      [
        "public appUrl",
        { ...validScripted, subject: { source: "app-url", appUrl: "https://example.com/" } },
      ],
    ])("fails closed on scripted mis-config: %s", (_label, input) => {
      const result = parseStudy(input);
      expect(result.ok, _label).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("HUMANISH_STUDY_INVALID");
    });

    it("rejects subject.state on the scripted route (a clone-only field on an app-url subject)", () => {
      const result = parseStudy({
        ...validScripted,
        subject: {
          source: "app-url",
          appUrl: "http://127.0.0.1:5173/",
          state: { seed: [{ name: "seed", command: "pnpm db:seed" }] },
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("subject.state");
      expect(result.error.message).toContain("clone subjects");
    });

    it("accepts app-url × local for a computer-use desktop adapter", () => {
      const result = parseStudy(asComputerUse({ type: "openai-computer-use" }));
      expect(result.ok).toBe(true);
    });

    it("names the scripted-browser actors in the app-url × e2b-desktop unsupported-actor error", () => {
      const result = parseStudy({
        ...asComputerUse({ type: "codex-app-server" }),
        execution: { target: "e2b-desktop" },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("openai-computer-use");
      expect(result.error.message).toContain("scripted-browser");
    });

    it("refuses mission, model and participants on the scripted route (no model runs); persona, surfaces and timeoutMs are read", () => {
      expect(
        refusal({
          ...validScripted,
          actor: { type: "scripted-browser", persona: "p1", mission: "inert here", model: "inert" },
          surfaces: ["desktop"],
        }),
      ).toBe(
        "route: scripted does not read actor.mission (the scripted-browser actor runs no model), actor.model (the scripted-browser actor runs no model). Remove them.",
      );
      expect(
        refusal({
          ...without(validScripted, "surfaces"),
          actor: { type: "scripted-browser", persona: "p1" },
          participants: { instruction: "inert here" },
        }),
      ).toBe(
        "route: scripted takes no `participants`. It replays committed steps on `surfaces`: [desktop] or [desktop, mobile].",
      );
    });

    it("refuses scenario on non-scripted routes", () => {
      expect(
        refusal({
          schema: STUDY_SCHEMA,
          id: "synthetic-with-ref",
          route: "preview",
          subject: { source: "this-repo" },
          actor: { type: "synthetic-persona" },
          scenario: "scripted-first-run",
        }),
      ).toBe("route: preview does not read scenario. Remove it.");
    });

    it("refuses execution.desktop.* on the scripted route (device presets are the computer-use route's)", () => {
      expect(
        refusal({
          ...validScripted,
          execution: { target: "local", desktop: { device: "mobile" } },
        }),
      ).toBe("route: scripted does not read execution.desktop.device. Remove it.");
    });

    it("parses clone × e2b-desktop × scripted-browser as a provisioned synthetic scripted route", () => {
      const result = parseStudy({
        schema: STUDY_SCHEMA,
        id: "provisioned-scripted",
        route: "scripted",
        mode: "live",
        subject: {
          source: "clone",
          exposure: "synthetic",
          repos: ["example-org/example-app"],
          clone: { depth: 1 },
          serve: {
            install: "pnpm install --frozen-lockfile",
            build: "pnpm build",
            start: "pnpm start --host 0.0.0.0",
            url: "http://127.0.0.1:3000/",
          },
          env: ["GITHUB_TOKEN"],
          state: { seed: [{ name: "seed", command: "pnpm db:seed" }] },
        },
        actor: { type: "scripted-browser", persona: "workflow-reviewer" },
        surfaces: ["desktop"],
        scenario: "workflow-review-proof",
        execution: {
          target: "e2b-desktop",
          timeoutMs: 120000,
          desktop: { template: "adopter-ui-sim-base" },
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(isScriptedBrowserComposition(result.config)).toBe(true);
      expect(isProvisionedScriptedBrowserComposition(result.config)).toBe(true);
      expect(routeOf(result.config)).toBe("scripted");
      expect(result.warnings).toEqual([]);
    });

    it.each([
      [
        "missing synthetic exposure",
        { subject: { exposure: undefined } },
        "subject.exposure: synthetic",
      ],
      ["missing seed", { subject: { state: undefined } }, "subject.state.seed"],
      [
        "external state",
        {
          subject: {
            env: ["DATABASE_URL"],
            state: {
              seed: [{ name: "seed", command: "pnpm db:seed" }],
              external: ["DATABASE_URL"],
            },
          },
        },
        "cannot use `subject.state.external`",
      ],
      [
        "loopback-only start",
        { subject: { serve: { start: "pnpm start", url: "http://127.0.0.1:3000/" } } },
        "0.0.0.0",
      ],
      [
        "participants list",
        { participants: [{ id: "provider" }] },
        "route: scripted takes no `participants`",
      ],
    ])("fails closed on unsafe provisioned scripted config: %s", (_label, patch, expected) => {
      const base = {
        schema: STUDY_SCHEMA,
        id: "provisioned-scripted-invalid",
        route: "scripted",
        subject: {
          source: "clone",
          exposure: "synthetic",
          repos: ["example-org/example-app"],
          serve: { start: "pnpm start --host 0.0.0.0", url: "http://127.0.0.1:3000/" },
          state: { seed: [{ name: "seed", command: "pnpm db:seed" }] },
        },
        actor: { type: "scripted-browser" },
        scenario: "workflow-review-proof",
        execution: { target: "e2b-desktop" },
      };
      const typedPatch = patch as { subject?: Record<string, unknown> };
      const input = { ...base, ...patch, subject: { ...base.subject, ...typedPatch.subject } };
      const result = parseStudy(input);
      expect(result.ok, _label).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain(expected);
    });
  });

  describe("clone + serve (computer-use route)", () => {
    const validCloneCua = {
      schema: STUDY_SCHEMA,
      id: "cua-clone",
      route: "computer-use",
      mode: "live",
      subject: {
        source: "clone",
        repos: ["example-org/example-app"],
        clone: { depth: 2 },
        serve: {
          install: "pnpm install",
          build: "pnpm build",
          start: "pnpm start",
          url: "http://127.0.0.1:3000/",
          readyTimeoutMs: 60000,
        },
        env: ["DATABASE_URL", "GITHUB_TOKEN"],
      },
      actor: { type: "openai-computer-use", mission: "Explore." },
      execution: { target: "e2b-desktop", timeoutMs: 120000 },
    };

    it("parses configurable install/build timeouts on serve (monorepo-scale builds exceed the default)", () => {
      const result = parseStudy({
        ...validCloneCua,
        subject: {
          ...validCloneCua.subject,
          serve: {
            ...validCloneCua.subject.serve,
            installTimeoutMs: 1_200_000,
            buildTimeoutMs: 1_800_000,
          },
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.subject.serve?.installTimeoutMs).toBe(1_200_000);
      expect(result.config.subject.serve?.buildTimeoutMs).toBe(1_800_000);
      expect(result.warnings).toEqual([]);
    });

    it("serve.url stays loopback-only even with allowPublicTargets (the lab serves the clone in-sandbox)", () => {
      const result = parseStudy({
        ...validCloneCua,
        subject: {
          ...validCloneCua.subject,
          serve: { ...validCloneCua.subject.serve, url: "https://preview.vercel.app/" },
        },
        policies: { allowPublicTargets: true },
      });
      // allowPublicTargets governs app-url subjects, not where we serve a clone: serve.url must be loopback.
      expect(result.ok).toBe(false);
    });

    it("parses with zero warnings: serve, env, and clone.depth are all consumed on this route", () => {
      const result = parseStudy(validCloneCua);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.subject.serve?.start).toBe("pnpm start");
      expect(result.config.subject.env).toEqual(["DATABASE_URL", "GITHUB_TOKEN"]);
      expect(result.warnings).toEqual([]);
    });

    it("rejects clone.fanout on the computer-use route (declared behavior change) but accepts clone.keep/depth", () => {
      // clone.fanout is now a hard parse error on the computer-use route: fan-out is declared via
      // `participants`. No current route reads subject.clone.fanout.
      const rejected = parseStudy({
        ...validCloneCua,
        subject: { ...validCloneCua.subject, clone: { depth: 1, keep: true, fanout: 2 } },
      });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) return;
      expect(rejected.error.code).toBe("HUMANISH_STUDY_INVALID");
      expect(rejected.error.message).toContain("subject.clone.fanout");

      // clone.keep + depth alone parse clean (keep is honored on failure; depth is consumed).
      const accepted = parseStudy({
        ...validCloneCua,
        subject: { ...validCloneCua.subject, clone: { depth: 1, keep: true } },
      });
      expect(accepted.ok).toBe(true);
      if (!accepted.ok) return;
      expect(accepted.warnings).toEqual([]);
    });

    it("accepts a homogeneous count > 1 on the clone computer-use route (each participant clones the same repo)", () => {
      const result = parseStudy({
        ...validCloneCua,
        actor: { type: "openai-computer-use" },
        participants: 3,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(declaredParticipantCount(result.config)).toBe(3);
    });

    it.each([
      [
        "serve on app-url",
        {
          ...validCloneCua,
          subject: {
            source: "app-url",
            appUrl: "http://127.0.0.1:3000/",
            serve: validCloneCua.subject.serve,
          },
        },
      ],
      [
        "serve on this-repo",
        {
          ...without(validCloneCua, "execution", "mode"),
          subject: { source: "this-repo", serve: validCloneCua.subject.serve },
        },
      ],
      [
        "env on app-url",
        {
          ...validCloneCua,
          subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/", env: ["X_Y"] },
        },
      ],
      [
        "serve without start",
        {
          ...validCloneCua,
          subject: { ...validCloneCua.subject, serve: { url: "http://127.0.0.1:3000/" } },
        },
      ],
      [
        "serve without url",
        { ...validCloneCua, subject: { ...validCloneCua.subject, serve: { start: "pnpm start" } } },
      ],
      [
        "serve with public url",
        {
          ...validCloneCua,
          subject: {
            ...validCloneCua.subject,
            serve: { start: "pnpm start", url: "https://example.com/" },
          },
        },
      ],
      [
        "bad env name",
        { ...validCloneCua, subject: { ...validCloneCua.subject, env: ["lowercase-bad"] } },
      ],
      ["empty env list", { ...validCloneCua, subject: { ...validCloneCua.subject, env: [] } }],
      [
        "cua-clone without serve",
        { ...validCloneCua, subject: { source: "clone", repos: ["example-org/example-app"] } },
      ],
      [
        "two repos on cua-clone",
        { ...validCloneCua, subject: { ...validCloneCua.subject, repos: ["a/b", "c/d"] } },
      ],
      [
        "bad repo slug",
        { ...validCloneCua, subject: { ...validCloneCua.subject, repos: ["not a slug; rm -rf"] } },
      ],
      [
        "clone.fanout (declared behavior change: rejected on cua)",
        { ...validCloneCua, subject: { ...validCloneCua.subject, clone: { fanout: 2 } } },
      ],
      [
        "over the 100-participant limit",
        { ...validCloneCua, actor: { type: "openai-computer-use" }, participants: 101 },
      ],
    ])("fails closed on clone+serve mis-config: %s", (_label, input) => {
      const result = parseStudy(input);
      expect(result.ok, _label).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("HUMANISH_STUDY_INVALID");
    });
  });

  describe("subject.state (seed/migrate/fixtures, computer-use clone route)", () => {
    const validCloneCua = {
      schema: STUDY_SCHEMA,
      id: "cua-clone-state",
      route: "computer-use",
      mode: "live",
      subject: {
        source: "clone",
        repos: ["example-org/example-app"],
        serve: {
          install: "pnpm install",
          build: "pnpm build",
          start: "pnpm start",
          url: "http://127.0.0.1:3000/",
        },
        env: ["DATABASE_URL"],
      },
      actor: { type: "openai-computer-use", mission: "Explore." },
      execution: { target: "e2b-desktop", timeoutMs: 120000 },
    };
    const withState = (state: unknown) => ({
      ...validCloneCua,
      subject: { ...validCloneCua.subject, state },
    });

    it("parses a full state declaration (all three phases + external) with zero warnings on the computer-use route", () => {
      const result = parseStudy(
        withState({
          seed: [
            {
              name: "db-up",
              command: "sudo service postgresql start && pg_isready -t 30",
              when: "before-start",
            },
            { name: "db-migrate", command: "pnpm prisma migrate deploy", timeoutMs: 300000 },
            {
              name: "prebuild-fixtures",
              command: "node scripts/fixtures.js",
              when: "before-build",
            },
            {
              name: "admin-user",
              command: "curl -sf -X POST http://127.0.0.1:3000/api/test/bootstrap-admin",
              when: "after-ready",
            },
          ],
          external: ["DATABASE_URL"],
        }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.warnings).toEqual([]);
      expect(result.config.subject.state?.seed).toHaveLength(4);
      expect(result.config.subject.state?.seed?.[0]).toEqual({
        name: "db-up",
        command: "sudo service postgresql start && pg_isready -t 30",
        when: "before-start",
      });
      // `when` stays optional in the parsed config (the engine defaults it to before-start).
      expect(result.config.subject.state?.seed?.[1]).toEqual({
        name: "db-migrate",
        command: "pnpm prisma migrate deploy",
        timeoutMs: 300000,
      });
      expect(result.config.subject.state?.external).toEqual(["DATABASE_URL"]);
    });

    it("parses seed-only state (no external): the common synthetic-seed shape", () => {
      const result = parseStudy(
        withState({
          seed: [{ name: "fixtures", command: "pnpm prisma db seed" }],
        }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.warnings).toEqual([]);
    });

    it.each([
      [
        "state on app-url",
        {
          ...validCloneCua,
          subject: {
            source: "app-url",
            appUrl: "http://127.0.0.1:3000/",
            state: { seed: [{ name: "a", command: "true" }] },
          },
        },
      ],
      [
        "state on this-repo",
        {
          schema: STUDY_SCHEMA,
          id: "x",
          route: "preview",
          subject: { source: "this-repo", state: { seed: [{ name: "a", command: "true" }] } },
          actor: { type: "synthetic-persona" },
        },
      ],
      ["empty state object (would be inert)", withState({})],
      ["state not an object", withState("seed it")],
      ["seed not an array", withState({ seed: { name: "a", command: "true" } })],
      ["seed empty array", withState({ seed: [] })],
      ["step missing name", withState({ seed: [{ command: "true" }] })],
      ["step missing command", withState({ seed: [{ name: "a" }] })],
      ["step name uppercase", withState({ seed: [{ name: "Db-Up", command: "true" }] })],
      ["step name with underscore", withState({ seed: [{ name: "db_up", command: "true" }] })],
      ["step name leading dash", withState({ seed: [{ name: "-up", command: "true" }] })],
      ["step name over 40 chars", withState({ seed: [{ name: "a".repeat(41), command: "true" }] })],
      [
        "duplicate step names",
        withState({
          seed: [
            { name: "a", command: "true" },
            { name: "a", command: "false" },
          ],
        }),
      ],
      ["bad when", withState({ seed: [{ name: "a", command: "true", when: "after-start" }] })],
      ["zero timeoutMs", withState({ seed: [{ name: "a", command: "true", timeoutMs: 0 }] })],
      [
        "non-numeric timeoutMs",
        withState({ seed: [{ name: "a", command: "true", timeoutMs: "soon" }] }),
      ],
      ["external empty list", withState({ external: [] })],
      ["external value-shaped entry", withState({ external: ["lowercase-not-a-name"] })],
      ["external name not in subject.env", withState({ external: ["REDIS_URL"] })],
      [
        "external without subject.env at all",
        {
          ...validCloneCua,
          subject: {
            ...validCloneCua.subject,
            env: undefined,
            state: { external: ["DATABASE_URL"] },
          },
        },
      ],
    ])("fails closed on state mis-config: %s", (_label, input) => {
      const result = parseStudy(input);
      expect(result.ok, _label).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("HUMANISH_STUDY_INVALID");
    });

    it("names the provisioned-channel rule when external is not backed by subject.env", () => {
      const result = parseStudy(withState({ external: ["REDIS_URL"] }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("subject.env");
      expect(result.error.message).toContain("provisioned channel");
    });
  });
});

// Rung 1: the local-app subject.source; an already-running local dev server driven
// in-process via a custom CuaExecutor (no clone, no E2B desktop). Parse-validated fail-closed.
describe("parseStudy (local-app subject)", () => {
  const validLocalApp = {
    schema: STUDY_SCHEMA,
    id: "local-app-state",
    route: "computer-use",
    mode: "live",
    subject: { source: "local-app", appUrl: "http://localhost:5173/" },
    actor: {
      type: "openai-computer-use",
      persona: "pixel-pat",
      mission: "Drive the app via its state contract.",
    },
  };

  it("parses a local-app + computer-use actor and routes to the computer-use route", () => {
    const result = parseStudy(validLocalApp);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.subject).toEqual({
      source: "local-app",
      appUrl: "http://localhost:5173/",
    });
    expect(isComputerUseComposition(result.config)).toBe(true);
    expect(isScriptedBrowserComposition(result.config)).toBe(false);
    expect(routeOf(result.config)).toBe("computer-use");
    // The actor prompt fields are consumed on this route (composeInstructions): no inert warning.
    expect(result.warnings).toEqual([]);
  });

  it("accepts execution.target: local explicitly (and absent), routing to cua either way", () => {
    const explicit = parseStudy({
      ...validLocalApp,
      execution: { target: "local", timeoutMs: 60000 },
    });
    expect(explicit.ok).toBe(true);
    if (explicit.ok) expect(routeOf(explicit.config)).toBe("computer-use");
  });

  it("accepts loopback variants (127.0.0.1, [::1], https)", () => {
    for (const appUrl of ["http://127.0.0.1:3000/", "https://localhost/", "http://[::1]:5173/"]) {
      const result = parseStudy({
        ...validLocalApp,
        subject: { source: "local-app", appUrl },
      });
      expect(result.ok, appUrl).toBe(true);
    }
  });

  it.each([
    ["missing appUrl", { ...validLocalApp, subject: { source: "local-app" } }],
    [
      "public URL (always loopback on this route)",
      { ...validLocalApp, subject: { source: "local-app", appUrl: "https://example.com/" } },
    ],
    [
      "non-http scheme",
      { ...validLocalApp, subject: { source: "local-app", appUrl: "file:///tmp/x.html" } },
    ],
    [
      "e2b-desktop target (the whole point is to skip the desktop)",
      { ...validLocalApp, execution: { target: "e2b-desktop" } },
    ],
    ["non-cua actor (codex-app-server)", { ...validLocalApp, actor: { type: "codex-app-server" } }],
    ["scripted-browser actor", { ...validLocalApp, actor: { type: "scripted-browser" } }],
    ["unregistered actor type", { ...validLocalApp, actor: { type: "not-a-real-actor" } }],
    [
      "fan-out count",
      { ...validLocalApp, actor: { type: "openai-computer-use" }, participants: 2 },
    ],
    [
      "allowPublicTargets (no public target on this route)",
      { ...validLocalApp, policies: { allowPublicTargets: true } },
    ],
    [
      "clone-only field serve",
      {
        ...validLocalApp,
        subject: {
          source: "local-app",
          appUrl: "http://localhost:5173/",
          serve: { start: "pnpm dev", url: "http://localhost:5173/" },
        },
      },
    ],
    [
      "clone-only field env",
      {
        ...validLocalApp,
        subject: { source: "local-app", appUrl: "http://localhost:5173/", env: ["DATABASE_URL"] },
      },
    ],
    [
      "clone-only field state",
      {
        ...validLocalApp,
        subject: {
          source: "local-app",
          appUrl: "http://localhost:5173/",
          state: { seed: [{ name: "s", command: "x" }] },
        },
      },
    ],
    [
      "clone-only field repos",
      {
        ...validLocalApp,
        subject: { source: "local-app", appUrl: "http://localhost:5173/", repos: ["a/b"] },
      },
    ],
  ])("fails closed on local-app mis-config: %s", (_label, input) => {
    const result = parseStudy(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_STUDY_INVALID");
  });

  it("the e2b-desktop rejection names the right remedy (app-url for the hosted desktop route)", () => {
    const result = parseStudy({ ...validLocalApp, execution: { target: "e2b-desktop" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("app-url");
    expect(result.error.message.toLowerCase()).toContain("e2b-desktop");
  });
});

interface StudyOverrides {
  subject?: Record<string, unknown>;
  actor?: Record<string, unknown>;
  participants?: unknown;
  execution?: Record<string, unknown>;
}

const SHARED_WORLD_PARTICIPANTS = [
  {
    id: "role-author",
    actorType: "author",
    surface: "studio",
    caseGroup: "case-001",
    persona: "author",
    entry: "/compose",
    instruction: "Create a note.",
  },
  {
    id: "role-reviewer",
    actorType: "reviewer",
    surface: "queue",
    caseGroup: "case-001",
    persona: "reviewer",
    entry: "/inbox",
    instruction: "Review the note.",
  },
];

// --- Shared-world topology parser matrix ------------------------------------------------
function validSharedWorld(overrides?: StudyOverrides): Record<string, unknown> {
  return {
    schema: STUDY_SCHEMA,
    id: "shared-world-proof",
    route: "shared-world",
    subject: {
      source: "clone",
      repos: ["example-org/collab-app"],
      env: ["DATABASE_URL"],
      exposure: "synthetic",
      serve: { start: "pnpm start -H 0.0.0.0", url: "http://127.0.0.1:3000/" },
      state: {
        seed: [{ name: "migrate", command: "pnpm db:migrate" }],
        checkpoint: [{ name: "notes-count", command: "echo count" }],
      },
      ...overrides?.subject,
    },
    actor: overrides?.actor ?? { type: "openai-computer-use", mission: "Use the shared app." },
    participants: overrides?.participants ?? SHARED_WORLD_PARTICIPANTS,
    execution: overrides?.execution ?? { target: "e2b-desktop", timeoutMs: 60000 },
  };
}

// The same shared-world composition, but driven from the operator's own packed working tree
// (subject.source: local-tree) instead of a clone - the follow-up to the local-tree keystone
// that lets shared-world accept a local-tree subject alongside clone.
function validSharedWorldLocalTree(overrides?: StudyOverrides): Record<string, unknown> {
  return {
    schema: STUDY_SCHEMA,
    id: "shared-world-local-tree-proof",
    route: "shared-world",
    subject: {
      source: "local-tree",
      env: ["DATABASE_URL"],
      exposure: "synthetic",
      serve: { start: "pnpm start -H 0.0.0.0", url: "http://127.0.0.1:3000/" },
      state: {
        seed: [{ name: "migrate", command: "pnpm db:migrate" }],
        checkpoint: [{ name: "notes-count", command: "echo count" }],
      },
      ...overrides?.subject,
    },
    actor: overrides?.actor ?? { type: "openai-computer-use", mission: "Use the shared app." },
    participants: overrides?.participants ?? SHARED_WORLD_PARTICIPANTS,
    execution: overrides?.execution ?? { target: "e2b-desktop", timeoutMs: 60000 },
  };
}

describe("shared-world topology routing + cross-validation", () => {
  const actor = { type: "openai-computer-use" };

  it("parses a valid shared-world lab, routes to the shared-world backend, no warnings", () => {
    const result = parseStudy(validSharedWorld());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.route).toBe("shared-world");
    expect(isSharedWorldComposition(result.config)).toBe(true);
    expect(routeOf(result.config)).toBe("shared-world");
    expect(sharedWorldValidationReason(result.config)).toBeNull();
    expect(result.warnings).toEqual([]);
    // The participants list is the role list (no parallel roles[] field).
    expect(participantList(result.config)?.map((entry) => entry.id)).toEqual([
      "role-author",
      "role-reviewer",
    ]);
    expect(
      participantList(result.config)?.map((entry) => [
        entry.actorType,
        entry.surface,
        entry.caseGroup,
      ]),
    ).toEqual([
      ["author", "studio", "case-001"],
      ["reviewer", "queue", "case-001"],
    ]);
    expect(result.config.subject.state?.checkpoint?.map((probe) => probe.name)).toEqual([
      "notes-count",
    ]);
  });

  it("accepts subject.source: local-tree: parses, routes to shared-world, no warnings", () => {
    const result = parseStudy(validSharedWorldLocalTree());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.subject.source).toBe("local-tree");
    expect(result.config.route).toBe("shared-world");
    expect(isSharedWorldComposition(result.config)).toBe(true);
    expect(routeOf(result.config)).toBe("shared-world");
    expect(sharedWorldValidationReason(result.config)).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it("local-tree + concurrency>1 also routes to the concurrent shared-world backend", () => {
    const result = parseStudy(
      validSharedWorldLocalTree({
        subject: {
          exposure: "synthetic",
          serve: { start: "pnpm start -H 0.0.0.0", url: "http://127.0.0.1:3000/" },
        },
        execution: { target: "e2b-desktop", timeoutMs: 60000, concurrency: 2 },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isSharedWorldComposition(result.config)).toBe(true);
    expect(routeOf(result.config)).toBe("shared-world");
    expect(concurrentSharedWorldValidationReason(result.config)).toBeNull();
  });

  it("local-tree shared-world still rejects subject.repos/subject.clone (local-tree never carries git slugs)", () => {
    const withRepos = parseStudy(validSharedWorldLocalTree({ subject: { repos: ["a/b"] } }));
    expect(withRepos.ok).toBe(false);
    if (!withRepos.ok) expect(withRepos.error.message).toContain("subject.repos");
    const withClone = parseStudy(validSharedWorldLocalTree({ subject: { clone: { depth: 1 } } }));
    expect(withClone.ok).toBe(false);
    if (!withClone.ok) expect(withClone.error.message).toContain("subject.clone");
  });

  it("execution.desktop.browser parses on shared-world with zero warnings", () => {
    const result = parseStudy(
      validSharedWorld({
        execution: {
          target: "e2b-desktop",
          timeoutMs: 60000,
          desktop: { browser: "chrome" },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(routeOf(result.config)).toBe("shared-world");
    expect(result.config.execution?.desktop?.browser).toBe("chrome");
    expect(result.warnings).toEqual([]);
  });

  it("rejects malformed participant grouping metadata instead of persisting arbitrary labels", () => {
    const result = parseStudy(
      validSharedWorld({
        actor,
        participants: [
          { id: "role-a", actorType: "person with spaces", entry: "/compose" },
          { id: "role-b", actorType: "reviewer", entry: "/inbox" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("actorType");
  });

  it("expands participant entries with a count before shared-world validation", () => {
    const result = parseStudy(
      validSharedWorld({
        participants: [
          {
            id: "author",
            count: 2,
            actorType: "author",
            surface: "studio",
            caseGroup: "case-001",
            persona: "writer",
            entry: "/compose",
            instruction: "Create a note.",
          },
          {
            id: "reviewer",
            count: 1,
            actorType: "reviewer",
            surface: "queue",
            caseGroup: "case-001",
            persona: "reviewer",
            entry: "/inbox",
            instruction: "Review the note.",
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isSharedWorldComposition(result.config)).toBe(true);
    expect(sharedWorldValidationReason(result.config)).toBeNull();
    expect(
      participantList(result.config)?.map((entry) => [
        entry.id,
        entry.actorType,
        entry.surface,
        entry.caseGroup,
        entry.entry,
      ]),
    ).toEqual([
      ["author-01", "author", "studio", "case-001", "/compose"],
      ["author-02", "author", "studio", "case-001", "/compose"],
      ["reviewer-01", "reviewer", "queue", "case-001", "/inbox"],
    ]);
  });

  it("the same composition declared as route: computer-use refuses the shared-world fields, proving route is the switch", () => {
    const sw = validSharedWorld();
    const message = refusal({ ...sw, route: "computer-use" });
    // entry, the checkpoint and the exposure statement are read only in a shared world.
    expect(message).toMatch(/^route: computer-use does not read participants\[\]\.entry /);
    expect(message).toContain("subject.state.checkpoint");
    expect(message).toContain("subject.exposure");
    // Without them, the same composition runs independent computer-use participants.
    const subject = without(sw.subject as Raw, "exposure");
    subject.state = { seed: [{ name: "migrate", command: "pnpm db:migrate" }] };
    const result = parseStudy({
      ...sw,
      route: "computer-use",
      subject,
      participants: SHARED_WORLD_PARTICIPANTS.map((entry) => without(entry, "entry")),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isSharedWorldComposition(result.config)).toBe(false);
    expect(isComputerUseComposition(result.config)).toBe(true);
    expect(routeOf(result.config)).toBe("computer-use");
  });

  it.each([
    ["missing serve", validSharedWorld({ subject: { serve: undefined } })],
    [
      "roster < 2 roles",
      validSharedWorld({ actor, participants: [{ id: "only-role", entry: "/x" }] }),
    ],
    [
      "wrong source (this-repo)",
      {
        schema: STUDY_SCHEMA,
        id: "sw-src",
        route: "shared-world",
        subject: { source: "this-repo" },
        actor: { type: "synthetic-persona" },
        participants: [{ id: "a" }, { id: "b" }],
      },
    ],
    [
      "wrong source (app-url)",
      {
        schema: STUDY_SCHEMA,
        id: "sw-src-app-url",
        route: "shared-world",
        subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
        actor: { type: "openai-computer-use", mission: "x" },
        participants: [{ id: "solo" }],
        execution: { target: "e2b-desktop" },
      },
    ],
    [
      "wrong source (local-app), refused first for its participants list",
      {
        schema: STUDY_SCHEMA,
        id: "sw-src-local-app",
        route: "shared-world",
        subject: { source: "local-app", appUrl: "http://127.0.0.1:3000/" },
        actor: { type: "openai-computer-use", mission: "x" },
        participants: [{ id: "a" }, { id: "b" }],
      },
    ],
    [
      "wrong source (terminal-product)",
      {
        schema: STUDY_SCHEMA,
        id: "sw-src-terminal",
        route: "shared-world",
        subject: {
          source: "terminal-product",
          product: { name: "widgetsmith", publicSurfaces: ["https://example.com/x"] },
        },
        actor: { type: "codex-exec" },
        participants: [{ id: "a" }, { id: "b" }],
      },
    ],
    ["wrong target (no e2b-desktop)", validSharedWorld({ execution: { timeoutMs: 60000 } })],
    [
      "missing checkpoint",
      validSharedWorld({
        subject: { state: { seed: [{ name: "migrate", command: "pnpm db:migrate" }] } },
      }),
    ],
    [
      "entry not same-origin with serve.url",
      validSharedWorld({
        actor,
        participants: [
          { id: "role-a", entry: "http://evil.example.com/x" },
          { id: "role-b", entry: "/inbox" },
        ],
      }),
    ],
  ])("fails closed on shared-world mis-config: %s", (_label, input) => {
    const result = parseStudy(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_STUDY_INVALID");
  });

  it("each fail-closed reason names its requirement precisely", () => {
    const noServe = parseStudy(validSharedWorld({ subject: { serve: undefined } }));
    expect(noServe.ok).toBe(false);
    if (!noServe.ok) expect(noServe.error.message).toContain("subject.serve");
    const oneRole = parseStudy(
      validSharedWorld({ actor, participants: [{ id: "only", entry: "/x" }] }),
    );
    expect(oneRole.ok).toBe(false);
    if (!oneRole.ok) expect(oneRole.error.message).toContain("list of at least 2");
    const noCheckpoint = parseStudy(
      validSharedWorld({
        subject: { state: { seed: [{ name: "migrate", command: "pnpm db:migrate" }] } },
      }),
    );
    expect(noCheckpoint.ok).toBe(false);
    if (!noCheckpoint.ok) expect(noCheckpoint.error.message).toContain("subject.state.checkpoint");
    const badEntry = parseStudy(
      validSharedWorld({
        actor,
        participants: [
          { id: "role-a", entry: "http://evil.example.com/x" },
          { id: "role-b", entry: "/inbox" },
        ],
      }),
    );
    expect(badEntry.ok).toBe(false);
    if (!badEntry.ok) expect(badEntry.error.message).toContain("same-origin");
  });

  it("entry validation accepts same-origin paths + absolute loopback URLs, rejects cross-origin/non-loopback", () => {
    expect(resolveEntryUrl("http://127.0.0.1:3000/", "/compose")).toBe(
      "http://127.0.0.1:3000/compose",
    );
    expect(resolveEntryUrl("http://127.0.0.1:3000/", "http://127.0.0.1:3000/inbox")).toBe(
      "http://127.0.0.1:3000/inbox",
    );
    expect(resolveEntryUrl("http://127.0.0.1:3000/", undefined)).toBe("http://127.0.0.1:3000/");
    expect(resolveEntryUrl("http://127.0.0.1:3000/", "http://127.0.0.1:4000/x")).toBeNull(); // different port → cross-origin
    expect(resolveEntryUrl("http://127.0.0.1:3000/", "http://example.com/x")).toBeNull(); // cross-origin
  });

  it("rejects a malformed checkpoint (missing command / duplicate name / value-shaped redact)", () => {
    const noCommand = parseStudy(
      validSharedWorld({ subject: { state: { checkpoint: [{ name: "c1" }] } } }),
    );
    expect(noCommand.ok).toBe(false);
    const dupName = parseStudy(
      validSharedWorld({
        subject: {
          state: {
            checkpoint: [
              { name: "c1", command: "echo a" },
              { name: "c1", command: "echo b" },
            ],
          },
        },
      }),
    );
    expect(dupName.ok).toBe(false);
    if (!dupName.ok) expect(dupName.error.message).toContain("unique");
    const badRedact = parseStudy(
      validSharedWorld({
        subject: {
          state: { checkpoint: [{ name: "c1", command: "echo a", redact: "not-a-list" }] },
        },
      }),
    );
    expect(badRedact.ok).toBe(false);
  });

  it("refuses subject.topology, which route replaced, and the other routes parse as before", () => {
    // A topology on an app-url computer-use study names its replacement.
    expect(
      refusal({
        schema: STUDY_SCHEMA,
        id: "sw-warn",
        route: "computer-use",
        subject: {
          source: "app-url",
          appUrl: "http://127.0.0.1:3000/",
          topology: "per-lane-worlds",
        },
        actor: { type: "openai-computer-use", mission: "x" },
        execution: { target: "e2b-desktop" },
      }),
    ).toBe("`subject.topology` moved to `route:`. A shared world is `route: shared-world`.");

    // Every existing route still parses + routes unchanged (regression guard).
    const synthetic = parseStudy({
      schema: STUDY_SCHEMA,
      id: "s",
      route: "preview",
      subject: { source: "this-repo" },
      actor: { type: "synthetic-persona" },
    });
    const scripted = parseStudy({
      schema: STUDY_SCHEMA,
      id: "sc",
      route: "scripted",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actor: { type: "scripted-browser" },
      scenario: "scripted-first-run",
    });
    const terminal = parseStudy({
      schema: STUDY_SCHEMA,
      id: "t",
      route: "terminal",
      subject: {
        source: "terminal-product",
        product: { name: "widgetsmith", publicSurfaces: ["https://example.com/x"] },
      },
      actor: { type: "codex-exec" },
    });
    for (const result of [synthetic, scripted, terminal]) {
      expect(result.ok).toBe(true);
      if (result.ok) expect(isSharedWorldComposition(result.config)).toBe(false);
    }
    if (synthetic.ok) expect(routeOf(synthetic.config)).toBe("preview");
    if (scripted.ok) expect(routeOf(scripted.config)).toBe("scripted");
    if (terminal.ok) expect(routeOf(terminal.config)).toBe("terminal");
  });
});

// --- Concurrent shared-world topology parser matrix ------------------------------
function validConcurrent(overrides?: StudyOverrides): Record<string, unknown> {
  return {
    schema: STUDY_SCHEMA,
    id: "concurrent-shared-world-proof",
    route: "shared-world",
    subject: {
      source: "clone",
      exposure: "synthetic",
      repos: ["example-org/collab-app"],
      env: ["DATABASE_URL"],
      serve: { start: "pnpm start -H 0.0.0.0", url: "http://127.0.0.1:3000/" },
      state: {
        seed: [{ name: "migrate", command: "pnpm db:migrate" }],
        checkpoint: [{ name: "notes-count", command: "echo count" }],
      },
      ...overrides?.subject,
    },
    actor: overrides?.actor ?? { type: "openai-computer-use", mission: "Use the shared app." },
    participants: overrides?.participants ?? [
      { id: "persona-a", persona: "author", entry: "/compose" },
      { id: "persona-b", persona: "reviewer", entry: "/inbox" },
      { id: "persona-c", persona: "skimmer", entry: "/feed" },
    ],
    execution: overrides?.execution ?? { target: "e2b-desktop", timeoutMs: 60000, concurrency: 3 },
  };
}

describe("concurrent shared-world routing + cross-validation", () => {
  it("routes shared-world + concurrency>1 to the concurrent backend; no warnings", () => {
    const result = parseStudy(validConcurrent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isSharedWorldComposition(result.config)).toBe(true);
    expect(isSharedWorldComposition(result.config)).toBe(true); // concurrent is a shared-world subtype
    expect(routeOf(result.config)).toBe("shared-world");
    expect(concurrentSharedWorldValidationReason(result.config)).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it("refuses explicit concurrency 1 with a migration message; an omitted concurrency stays unset", () => {
    // The sequential shared-world route was removed in 0.106.0. A lab that still declares
    // concurrency 1 must fail at parse with the fix, never silently run concurrently.
    const seq1 = parseStudy(
      validConcurrent({ execution: { target: "e2b-desktop", timeoutMs: 60000, concurrency: 1 } }),
    );
    expect(seq1.ok).toBe(false);
    if (!seq1.ok) {
      expect(seq1.error.message).toContain("at least 2 (got 1)");
      expect(seq1.error.message).toContain("omit execution.concurrency");
    }
    // The planner resolves an omitted concurrency from the participants and the E2B plan's limit
    // (tests/study/participant-limits.test.ts), so the parser leaves it unset.
    const allParallel = parseStudy(
      validConcurrent({ execution: { target: "e2b-desktop", timeoutMs: 60000 } }),
    );
    expect(allParallel.ok).toBe(true);
    if (allParallel.ok) {
      expect(allParallel.config.execution?.concurrency).toBeUndefined();
      expect(isSharedWorldComposition(allParallel.config)).toBe(true);
      expect(routeOf(allParallel.config)).toBe("shared-world");
      // No waves warning: nothing was declared.
      expect(allParallel.warnings.filter((w) => w.includes("caps a"))).toEqual([]);
    }
  });

  it.each([
    [
      "missing synthetic-subject attestation",
      validConcurrent({ subject: { exposure: undefined } }),
    ],
    [
      "serve.start does not bind 0.0.0.0",
      validConcurrent({
        subject: { serve: { start: "pnpm start", url: "http://127.0.0.1:3000/" } },
      }),
    ],
    [
      "subject.clone.keep on the concurrent route",
      validConcurrent({ subject: { clone: { keep: true } } }),
    ],
    [
      "roster < 2 personas",
      validConcurrent({
        actor: { type: "openai-computer-use" },
        participants: [{ id: "only", entry: "/x" }],
      }),
    ],
    [
      "missing checkpoint",
      validConcurrent({
        subject: { state: { seed: [{ name: "migrate", command: "pnpm db:migrate" }] } },
      }),
    ],
  ])("fails closed on concurrent mis-config: %s", (_label, input) => {
    const result = parseStudy(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_STUDY_INVALID");
  });

  it("each concurrent fail-closed reason names its requirement precisely", () => {
    const noExposure = parseStudy(validConcurrent({ subject: { exposure: undefined } }));
    expect(noExposure.ok).toBe(false);
    if (!noExposure.ok) expect(noExposure.error.message).toContain("subject.exposure: synthetic");
    const badBind = parseStudy(
      validConcurrent({
        subject: { serve: { start: "pnpm start", url: "http://127.0.0.1:3000/" } },
      }),
    );
    expect(badBind.ok).toBe(false);
    if (!badBind.ok) expect(badBind.error.message).toContain("0.0.0.0");
    const keep = parseStudy(validConcurrent({ subject: { clone: { keep: true } } }));
    expect(keep.ok).toBe(false);
    if (!keep.ok) expect(keep.error.message).toContain("subject.clone.keep");
  });

  it("exposure: synthetic is enum-validated, and refused off the shared-world route", () => {
    const badExposure = parseStudy(validConcurrent({ subject: { exposure: "real" } }));
    expect(badExposure.ok).toBe(false);
    // exposure on a plain app-url computer-use study is refused as unread.
    expect(
      refusal({
        schema: STUDY_SCHEMA,
        id: "exp-warn",
        route: "computer-use",
        subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/", exposure: "synthetic" },
        actor: { type: "openai-computer-use", mission: "x" },
        execution: { target: "e2b-desktop" },
      }),
    ).toMatch(/^route: computer-use does not read subject\.exposure /);
  });

  it("existing routes stay byte-stable (none route to concurrent shared-world)", () => {
    const synthetic = parseStudy({
      schema: STUDY_SCHEMA,
      id: "s",
      route: "preview",
      subject: { source: "this-repo" },
      actor: { type: "synthetic-persona" },
    });
    // A plain cua fan-out (concurrency>1 but no shared-world route) stays cua, not concurrent shared-world.
    const fanout = parseStudy({
      schema: STUDY_SCHEMA,
      id: "f",
      route: "computer-use",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actor: { type: "openai-computer-use" },
      participants: 3,
      execution: { target: "e2b-desktop", concurrency: 2 },
    });
    for (const result of [synthetic, fanout]) {
      expect(result.ok).toBe(true);
      if (result.ok) expect(isSharedWorldComposition(result.config)).toBe(false);
    }
    if (fanout.ok) expect(routeOf(fanout.config)).toBe("computer-use");
  });
});

// Rung 1: the local-tree subject.source - packs the operator's own working tree
// (the study resolution cwd) and provisions it in-sandbox in place of a clone. Routing requires
// execution.target: e2b-desktop and a computer-use actor; everything else fails closed at parse.
describe("parseStudy (local-tree subject)", () => {
  const validLocalTree = {
    schema: STUDY_SCHEMA,
    id: "local-tree-lab",
    route: "computer-use",
    subject: {
      source: "local-tree",
      serve: { start: "pnpm start", url: "http://127.0.0.1:3000/" },
    },
    actor: {
      type: "openai-computer-use",
      persona: "pixel-pat",
      mission: "Explore the packed working tree.",
    },
    execution: { target: "e2b-desktop" },
  };

  it("parses a minimal local-tree study and routes to the computer-use route with zero warnings", () => {
    const result = parseStudy(validLocalTree);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.subject.source).toBe("local-tree");
    expect(result.config.subject.serve?.start).toBe("pnpm start");
    expect(result.config.subject.serve?.url).toBe("http://127.0.0.1:3000/");
    expect(isComputerUseComposition(result.config)).toBe(true);
    expect(routeOf(result.config)).toBe("computer-use");
    expect(result.warnings).toEqual([]);
  });

  it("normalizes localTree.exclude entries (leading ./ and trailing / stripped)", () => {
    const result = parseStudy({
      ...validLocalTree,
      subject: { ...validLocalTree.subject, localTree: { exclude: ["./big-media", "vendor/"] } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.subject.localTree).toEqual({ exclude: ["big-media", "vendor"] });
  });

  it("round-trips subject.localTree fields (keep/exclude/maxArchiveBytes)", () => {
    const result = parseStudy({
      ...validLocalTree,
      subject: {
        ...validLocalTree.subject,
        localTree: { keep: true, exclude: ["big-media", "vendor"], maxArchiveBytes: 100_000_000 },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.subject.localTree).toEqual({
      keep: true,
      exclude: ["big-media", "vendor"],
      maxArchiveBytes: 100_000_000,
    });
  });

  it("localTree is optional - a bare local-tree lab has no subject.localTree at all", () => {
    const result = parseStudy(validLocalTree);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.subject.localTree).toBeUndefined();
  });

  it.each([
    [
      "repos on local-tree",
      { ...validLocalTree, subject: { ...validLocalTree.subject, repos: ["a/b"] } },
    ],
    [
      "clone block on local-tree",
      { ...validLocalTree, subject: { ...validLocalTree.subject, clone: { depth: 1 } } },
    ],
    ["missing serve", { ...validLocalTree, subject: { source: "local-tree" } }],
    ["missing execution.target e2b-desktop", { ...validLocalTree, execution: undefined }],
    [
      "local execution.target (the whole point is a hosted desktop)",
      { ...validLocalTree, execution: { target: "local" } },
    ],
    [
      "non-computer-use actor (codex-app-server)",
      { ...validLocalTree, actor: { type: "codex-app-server" } },
    ],
    [
      "localTree block on a clone subject",
      {
        schema: STUDY_SCHEMA,
        id: "clone-with-localtree",
        route: "computer-use",
        subject: { source: "clone", repos: ["example-org/example-app"], localTree: { keep: true } },
        actor: { type: "codex-app-server" },
      },
    ],
    [
      "localTree.exclude with an empty string entry",
      {
        ...validLocalTree,
        subject: { ...validLocalTree.subject, localTree: { exclude: ["ok", ""] } },
      },
    ],
    [
      "localTree.exclude with an absolute path",
      {
        ...validLocalTree,
        subject: { ...validLocalTree.subject, localTree: { exclude: ["/etc/secrets"] } },
      },
    ],
    [
      "localTree.exclude with glob syntax",
      {
        ...validLocalTree,
        subject: { ...validLocalTree.subject, localTree: { exclude: ["**/secrets"] } },
      },
    ],
    [
      "localTree.keep as a quoted YAML string",
      { ...validLocalTree, subject: { ...validLocalTree.subject, localTree: { keep: "true" } } },
    ],
    [
      "localTree.maxArchiveBytes zero",
      {
        ...validLocalTree,
        subject: { ...validLocalTree.subject, localTree: { maxArchiveBytes: 0 } },
      },
    ],
    [
      "localTree.maxArchiveBytes negative",
      {
        ...validLocalTree,
        subject: { ...validLocalTree.subject, localTree: { maxArchiveBytes: -1 } },
      },
    ],
  ])("fails closed on local-tree mis-config: %s", (_label, input) => {
    const result = parseStudy(input);
    expect(result.ok, _label).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_STUDY_INVALID");
  });

  it("each local-tree fail-closed reason names its requirement precisely", () => {
    const withRepos = parseStudy({
      ...validLocalTree,
      subject: { ...validLocalTree.subject, repos: ["a/b"] },
    });
    expect(withRepos.ok).toBe(false);
    if (!withRepos.ok) expect(withRepos.error.message).toContain("subject.repos");

    const withClone = parseStudy({
      ...validLocalTree,
      subject: { ...validLocalTree.subject, clone: { depth: 1 } },
    });
    expect(withClone.ok).toBe(false);
    if (!withClone.ok) expect(withClone.error.message).toContain("subject.clone");

    const noServe = parseStudy({ ...validLocalTree, subject: { source: "local-tree" } });
    expect(noServe.ok).toBe(false);
    if (!noServe.ok) expect(noServe.error.message).toContain("subject.serve");

    const noTarget = parseStudy({ ...validLocalTree, execution: undefined });
    expect(noTarget.ok).toBe(false);
    if (!noTarget.ok) expect(noTarget.error.message).toContain("execution.target: e2b-desktop");

    const badActor = parseStudy({
      ...validLocalTree,
      actor: { type: "codex-app-server" },
    });
    expect(badActor.ok).toBe(false);
    if (!badActor.ok) expect(badActor.error.message).toContain("computer-use actor");

    const localTreeOnClone = parseStudy({
      schema: STUDY_SCHEMA,
      id: "clone-with-localtree",
      route: "computer-use",
      subject: { source: "clone", repos: ["example-org/example-app"], localTree: { keep: true } },
      actor: { type: "codex-app-server" },
    });
    expect(localTreeOnClone.ok).toBe(false);
    if (!localTreeOnClone.ok) expect(localTreeOnClone.error.message).toContain("subject.localTree");

    // local-tree is a valid shared-world source too: see
    // validSharedWorldLocalTree() in the "shared-world topology routing" describe above for the
    // full positive proof (participants + checkpoint declared, parses ok, routes to shared-world).
    // Here, the bare validLocalTree fixture with one participant and no checkpoint still fails
    // closed, but on the participant floor - never on a source rejection.
    const sharedWorldOnBareLocalTree = parseStudy({
      ...validLocalTree,
      route: "shared-world",
      participants: [{ id: "solo" }],
    });
    expect(sharedWorldOnBareLocalTree.ok).toBe(false);
    if (!sharedWorldOnBareLocalTree.ok) {
      expect(sharedWorldOnBareLocalTree.error.message).not.toContain(
        "requires `subject.source: clone` or `subject.source: local-tree`",
      );
      expect(sharedWorldOnBareLocalTree.error.message).toContain("list of at least 2");
    }

    const badExclude = parseStudy({
      ...validLocalTree,
      subject: { ...validLocalTree.subject, localTree: { exclude: [""] } },
    });
    expect(badExclude.ok).toBe(false);
    if (!badExclude.ok) expect(badExclude.error.message).toContain("subject.localTree.exclude");

    const badMax = parseStudy({
      ...validLocalTree,
      subject: { ...validLocalTree.subject, localTree: { maxArchiveBytes: 0 } },
    });
    expect(badMax.ok).toBe(false);
    if (!badMax.ok) expect(badMax.error.message).toContain("subject.localTree.maxArchiveBytes");
  });

  it("serve/env/state are shared with the clone route (same parsing + semantic validation)", () => {
    const result = parseStudy({
      ...validLocalTree,
      subject: {
        ...validLocalTree.subject,
        env: ["DATABASE_URL"],
        state: { seed: [{ name: "fixtures", command: "pnpm prisma db seed" }] },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.subject.env).toEqual(["DATABASE_URL"]);
    expect(result.config.subject.state?.seed).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it("still fails closed on a malformed state block (semantic validation is shared with clone)", () => {
    const result = parseStudy({
      ...validLocalTree,
      subject: { ...validLocalTree.subject, state: { external: ["REDIS_URL"] } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("subject.env");
  });
});

// A one-participant shared world never parses: the two-participant floor refuses it on both
// planes before the concurrency rule can, so no single-participant exception to that rule is
// reachable.
describe("shared-world one-participant rosters and the concurrency rule", () => {
  const PROVISIONED_FLOOR = "needs a `participants` list of at least 2 participants";
  const EXTERNAL_FLOOR = "a single-participant shared world proves no shared session";
  const CONCURRENCY_RULE = "need `execution.concurrency` of at least 2";

  function oneParticipant(config: Record<string, unknown>): Record<string, unknown> {
    return { ...config, participants: (config.participants as unknown[]).slice(0, 1) };
  }
  function externalPublic(participants: unknown[], execution: Record<string, unknown> = {}) {
    return {
      schema: STUDY_SCHEMA,
      id: "external-one-seat",
      route: "shared-world",
      subject: {
        source: "app-url",
        appUrl: "https://play.example.com/",
        publicTarget: { owner: "example-org", authorized: true },
      },
      actor: { type: "openai-computer-use", mission: "Join the shared game." },
      participants,
      execution: { target: "e2b-desktop", timeoutMs: 60000, ...execution },
      policies: { allowPublicTargets: true },
    };
  }

  it.each([
    ["omitted", undefined],
    ["1", 1],
  ])(
    "refuses a one-participant provisioned roster by the roster floor (concurrency %s)",
    (_, value) => {
      const execution = { target: "e2b-desktop", timeoutMs: 60000, concurrency: value };
      const message = refusal(oneParticipant(validSharedWorld({ execution })));
      expect(message).toContain(PROVISIONED_FLOOR);
      expect(message).not.toContain(CONCURRENCY_RULE);
    },
  );

  it.each([["a one-seat roster", [{ id: "host", host: true }]]])(
    "refuses %s on the external-public plane by the roster floor",
    (_, participants) => {
      const message = refusal(externalPublic(participants));
      expect(message).toContain(EXTERNAL_FLOOR);
      expect(message).not.toContain(CONCURRENCY_RULE);
    },
  );

  it("keeps the migration refusal for two or more participants at concurrency 1", () => {
    const provisioned = validSharedWorld({
      execution: { target: "e2b-desktop", timeoutMs: 60000, concurrency: 1 },
    });
    const external = externalPublic([{ id: "host", host: true }, { id: "guest" }], {
      concurrency: 1,
    });
    for (const config of [provisioned, external]) {
      expect(refusal(config)).toContain(CONCURRENCY_RULE);
    }
  });
});
