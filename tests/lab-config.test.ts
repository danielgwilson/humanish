import { describe, expect, it } from "vitest";

import {
  concurrentSharedWorldValidationReason,
  LAB_CONFIG_SCHEMA,
  parseLabConfig,
  resolveSeatUrl,
  routesToComputerUse,
  routesToConcurrentSharedWorld,
  routesToProvisionedScriptedBrowser,
  routesToScriptedBrowser,
  routesToSharedWorld,
  sharedWorldValidationReason
} from "../src/lab-config.js";
import { selectLabBackend } from "../src/lab-engine.js";

describe("parseLabConfig (homun.lab.v2)", () => {
  it("parses an oss-meta-shaped lab (clone + e2b-desktop + codex actor)", () => {
    const result = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "oss",
      title: "OSS meta-lab",
      subject: { source: "clone", repos: ["CorentinTh/it-tools"], clone: { fanout: 4 } },
      actors: [{ type: "codex-app-server", count: 1 }],
      execution: { target: "e2b-desktop", desktop: { codexAppServer: true } },
      scenario: { mode: "live" }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.subject).toEqual({ source: "clone", repos: ["CorentinTh/it-tools"], clone: { fanout: 4 } });
    expect(result.config.actors[0]?.type).toBe("codex-app-server");
    expect(result.config.execution?.target).toBe("e2b-desktop");
    expect(result.config.execution?.desktop?.codexAppServer).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("parses a synthetic-shaped lab (this-repo + persona actor, dry-run)", () => {
    const result = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "first-run",
      subject: { source: "this-repo" },
      actors: [{ type: "synthetic-persona", count: 4 }],
      scenario: { mode: "dry-run" },
      defaults: { open: true }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.subject.source).toBe("this-repo");
    expect(result.config.actors[0]).toEqual({ type: "synthetic-persona", count: 4 });
    expect(result.config.scenario).toEqual({ mode: "dry-run" });
    expect(result.warnings).toEqual([]);
  });

  it("accepts a free-form actor.type on non-app-url routes (registry-resolved only where consumed)", () => {
    // HONEST CONTRACT: on this-repo/clone routes actor.type is a free-form label and routing
    // ignores it. Only the app-url (computer-use) route resolves it against the actor registry,
    // because only there does the descriptor actually run the session.
    const result = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "future",
      subject: { source: "this-repo" },
      actors: [{ type: "some-actor-not-in-the-registry" }]
    });
    expect(result.ok).toBe(true);
  });

  it("warns (does not silently swallow) when forward-declared fields are set", () => {
    const result = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "forward",
      subject: { source: "this-repo" },
      actors: [{ type: "synthetic-persona", mission: "do a thing", persona: "p1" }],
      review: { scoring: "custom" }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("not yet consumed");
    expect(result.warnings[0]).toContain("actors[0].mission");
    expect(result.warnings[0]).toContain("review");
  });

  it("rejects multiple actors (fan-out not wired — fail closed, not silent)", () => {
    const result = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "multi",
      subject: { source: "this-repo" },
      actors: [{ type: "a" }, { type: "b" }]
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Multiple actors");
  });

  it.each([
    ["wrong schema", { schema: "homun.lab.v1", id: "x", subject: { source: "this-repo" }, actors: [{ type: "a" }] }],
    ["missing id", { schema: LAB_CONFIG_SCHEMA, subject: { source: "this-repo" }, actors: [{ type: "a" }] }],
    ["id with space", { schema: LAB_CONFIG_SCHEMA, id: "has space", subject: { source: "this-repo" }, actors: [{ type: "a" }] }],
    ["id not starting alphanumeric", { schema: LAB_CONFIG_SCHEMA, id: ".hidden", subject: { source: "this-repo" }, actors: [{ type: "a" }] }],
    ["no subject", { schema: LAB_CONFIG_SCHEMA, id: "x", actors: [{ type: "a" }] }],
    ["bad subject source", { schema: LAB_CONFIG_SCHEMA, id: "x", subject: { source: "vm" }, actors: [{ type: "a" }] }],
    ["clone without repos", { schema: LAB_CONFIG_SCHEMA, id: "x", subject: { source: "clone" }, actors: [{ type: "a" }] }],
    ["empty actors", { schema: LAB_CONFIG_SCHEMA, id: "x", subject: { source: "this-repo" }, actors: [] }],
    ["actor without type", { schema: LAB_CONFIG_SCHEMA, id: "x", subject: { source: "this-repo" }, actors: [{ count: 1 }] }],
    ["bad execution target", { schema: LAB_CONFIG_SCHEMA, id: "x", subject: { source: "this-repo" }, actors: [{ type: "a" }], execution: { target: "vm" } }],
    ["non-positive resolution", { schema: LAB_CONFIG_SCHEMA, id: "x", subject: { source: "this-repo" }, actors: [{ type: "a" }], execution: { desktop: { resolution: [0, -1] } } }],
    ["this-repo with execution.target", { schema: LAB_CONFIG_SCHEMA, id: "x", subject: { source: "this-repo" }, actors: [{ type: "a" }], execution: { target: "e2b-desktop" } }],
    ["this-repo with live scenario", { schema: LAB_CONFIG_SCHEMA, id: "x", subject: { source: "this-repo" }, actors: [{ type: "a" }], scenario: { mode: "live" } }]
  ])("rejects invalid config: %s", (_label, input) => {
    const result = parseLabConfig(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HOMUN_LAB_INVALID");
  });

  describe("app-url (computer-use route)", () => {
    const validCua = {
      schema: LAB_CONFIG_SCHEMA,
      id: "cua-browser",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{
        type: "openai-computer-use",
        persona: "first-time-visitor",
        mission: "Explore the app.",
        laneFocus: { instruction: "Focus on onboarding." },
        model: "gpt-5.5"
      }],
      execution: { target: "e2b-desktop", timeoutMs: 120000, desktop: { resolution: [1280, 800], sandboxTimeoutMs: 600000 } },
      scenario: { mode: "dry-run" }
    };

    it("parses a computer-use lab with ZERO warnings — every set field is consumed on this route", () => {
      const result = parseLabConfig(validCua);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.subject).toEqual({ source: "app-url", appUrl: "http://127.0.0.1:3000/" });
      expect(result.config.actors[0]?.type).toBe("openai-computer-use");
      expect(result.warnings).toEqual([]);
    });

    it("CONSUMES execution.concurrency on the cua route (no warning) but still warns it elsewhere", () => {
      // Consumed here (bounds in-flight fan-out lanes) → zero warnings.
      const onCua = parseLabConfig({ ...validCua, execution: { ...validCua.execution, concurrency: 2 } });
      expect(onCua.ok).toBe(true);
      if (!onCua.ok) return;
      expect(onCua.warnings).toEqual([]);

      // Still inert (warned) on a route that does not consume it (regression guard).
      const offCua = parseLabConfig({
        schema: LAB_CONFIG_SCHEMA,
        id: "synthetic-concurrency",
        subject: { source: "this-repo" },
        actors: [{ type: "synthetic-persona" }],
        execution: { concurrency: 2 }
      });
      expect(offCua.ok).toBe(true);
      if (!offCua.ok) return;
      expect(offCua.warnings[0]).toContain("execution.concurrency");
    });

    it("warns about laneFocus.id/label on the cua route — only laneFocus.instruction is consumed there", () => {
      const result = parseLabConfig({
        ...validCua,
        actors: [{ type: "openai-computer-use", laneFocus: { id: "lane-1", label: "Lane one" } }]
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.warnings[0]).toContain("actors[0].laneFocus.id");
      expect(result.warnings[0]).toContain("actors[0].laneFocus.label");
      expect(result.warnings[0]).not.toContain("laneFocus.instruction");
    });

    it("parses actor-level and lane-level deterministic stopWhen guards", () => {
      const result = parseLabConfig({
        ...validCua,
        actors: [{
          type: "openai-computer-use",
          mission: "Exercise each lane.",
          stopWhen: { any: [{ id: "actor-done", textIncludes: "Saved" }] },
          lanes: [
            { id: "lane-a", persona: "reviewer", instruction: "Review the item." },
            {
              id: "lane-b",
              persona: "approver",
              instruction: "Approve the item.",
              stopWhen: { any: [{ id: "lane-approved", urlPathEquals: "/done" }] }
            }
          ]
        }]
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.actors[0]?.stopWhen?.any[0]?.textIncludes).toBe("Saved");
      expect(result.config.actors[0]?.lanes?.[1]?.stopWhen?.any[0]?.urlPathEquals).toBe("/done");
      expect(result.warnings).toEqual([]);
    });

    it.each([
      ["empty any", { any: [] }],
      ["bad rule id", { any: [{ id: "bad id", textIncludes: "Saved" }] }],
      ["rule without condition", { any: [{ id: "done" }] }],
      ["bad urlPathEquals", { any: [{ urlPathEquals: "tasks" }] }],
      ["bad appState path", { any: [{ appStatePathEquals: { path: "bad/path", equals: "done" } }] }],
      ["non-primitive equals", { any: [{ appStatePathEquals: { path: "status", equals: { value: "done" } } }] }]
    ])("rejects invalid stopWhen: %s", (_label, stopWhen) => {
      const result = parseLabConfig({
        ...validCua,
        actors: [{ type: "openai-computer-use", stopWhen }]
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("stopWhen");
    });

    it("keeps warning about mission/persona/model on routes that do NOT consume them", () => {
      const result = parseLabConfig({
        schema: LAB_CONFIG_SCHEMA,
        id: "clone-with-prompt-fields",
        subject: { source: "clone", repos: ["example-org/example-app"] },
        actors: [{ type: "codex-app-server", mission: "inert here", model: "inert" }]
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.warnings[0]).toContain("actors[0].mission");
      expect(result.warnings[0]).toContain("actors[0].model");
    });

    it.each([
      ["missing appUrl", { ...validCua, subject: { source: "app-url" } }],
      ["public URL", { ...validCua, subject: { source: "app-url", appUrl: "https://example.com/" } }],
      ["non-http scheme", { ...validCua, subject: { source: "app-url", appUrl: "file:///tmp/index.html" } }],
      ["not a URL", { ...validCua, subject: { source: "app-url", appUrl: "localhost:3000" } }],
      ["missing e2b-desktop target", { ...validCua, execution: { timeoutMs: 1000 } }],
      ["local target", { ...validCua, execution: { target: "local" } }],
      ["unregistered actor type", { ...validCua, actors: [{ type: "not-a-real-actor" }] }],
      ["registered but not computer-use", { ...validCua, actors: [{ type: "codex-app-server" }] }]
    ])("fails closed on cua mis-config: %s", (_label, input) => {
      const result = parseLabConfig(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("HOMUN_LAB_INVALID");
    });

    describe("multi-lane fan-out (#163)", () => {
      it("ACCEPTS a homogeneous count > 1 on the cua route (lifted rejection), default concurrency min(N,3)", () => {
        const result = parseLabConfig({ ...validCua, actors: [{ type: "openai-computer-use", count: 4 }] });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.config.actors[0]?.count).toBe(4);
        expect(result.warnings).toEqual([]);
      });

      it("ACCEPTS a differentiated lanes roster (per-lane persona/device/instruction)", () => {
        const result = parseLabConfig({
          ...validCua,
          actors: [{
            type: "openai-computer-use",
            mission: "Explore the app.",
            lanes: [
              { id: "mobile-newcomer", persona: "first-time-visitor", device: "mobile", instruction: "Sign up from a phone." },
              { id: "desktop-power", persona: "power-user", device: "wide", instruction: "Find advanced settings." }
            ]
          }],
          execution: { target: "e2b-desktop", timeoutMs: 120000, concurrency: 2 }
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.config.actors[0]?.lanes).toHaveLength(2);
        expect(result.warnings).toEqual([]);
      });

      it("ACCEPTS explicit per-lane public targets when every lane declares one and the owner opts in", () => {
        const result = parseLabConfig({
          ...validCua,
          subject: { source: "app-url", appUrl: "https://fallback.preview.example.test/" },
          actors: [{
            type: "openai-computer-use",
            mission: "Exercise each declared target.",
            lanes: [
              { id: "role-a", target: "https://role-a.preview.example.test/app", persona: "role-a" },
              { id: "role-b", target: "https://role-b.preview.example.test/app", persona: "role-b" }
            ]
          }],
          policies: { allowPublicTargets: true }
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.config.actors[0]?.lanes?.map((lane) => lane.target)).toEqual([
          "https://role-a.preview.example.test/app",
          "https://role-b.preview.example.test/app"
        ]);
        expect(result.warnings).toEqual([]);
      });

      it("expands compact roster groups into deterministic lanes", () => {
        const result = parseLabConfig({
          ...validCua,
          actors: [{
            type: "openai-computer-use",
            mission: "Exercise each app surface.",
            roster: [
              {
                id: "viewer",
                count: 3,
                actorType: "viewer",
                surface: "review-queue",
                caseGroup: "case-001",
                persona: "curious-reviewer",
                device: "desktop",
                instruction: "Review one assigned item."
              },
              {
                id: "manager",
                count: 1,
                actorType: "manager",
                surface: "dashboard",
                caseGroup: "case-001",
                persona: "operations-lead",
                device: "wide",
                instruction: "Check the dashboard summary."
              }
            ]
          }],
          execution: { target: "e2b-desktop", timeoutMs: 120000, concurrency: 2 }
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.config.actors[0]?.lanes?.map((lane) => lane.id)).toEqual([
          "viewer-01",
          "viewer-02",
          "viewer-03",
          "manager-01"
        ]);
        expect(result.config.actors[0]?.lanes?.map((lane) => [lane.actorType, lane.surface, lane.caseGroup, lane.device])).toEqual([
          ["viewer", "review-queue", "case-001", "desktop"],
          ["viewer", "review-queue", "case-001", "desktop"],
          ["viewer", "review-queue", "case-001", "desktop"],
          ["manager", "dashboard", "case-001", "wide"]
        ]);
        expect(result.warnings).toEqual([]);
      });

      it.each([
        ["lanes XOR count", { ...validCua, actors: [{ type: "openai-computer-use", count: 2, lanes: [{ id: "a" }, { id: "b" }] }] }],
        ["roster XOR count", { ...validCua, actors: [{ type: "openai-computer-use", count: 2, roster: [{ id: "a", count: 2 }] }] }],
        ["roster XOR lanes", { ...validCua, actors: [{ type: "openai-computer-use", roster: [{ id: "a", count: 2 }], lanes: [{ id: "b" }] }] }],
        ["lanes XOR laneFocus", { ...validCua, actors: [{ type: "openai-computer-use", laneFocus: { instruction: "x" }, lanes: [{ id: "a" }, { id: "b" }] }] }],
        ["roster XOR laneFocus", { ...validCua, actors: [{ type: "openai-computer-use", laneFocus: { instruction: "x" }, roster: [{ id: "a", count: 2 }] }] }],
        ["lanes[].device XOR raw resolution", {
          ...validCua,
          actors: [{ type: "openai-computer-use", lanes: [{ id: "a", device: "mobile" }, { id: "b" }] }],
          execution: { target: "e2b-desktop", desktop: { resolution: [1280, 800] } }
        }],
        ["over the 16-lane cap (count)", { ...validCua, actors: [{ type: "openai-computer-use", count: 17 }] }],
        ["over the 16-lane cap (lanes)", { ...validCua, actors: [{ type: "openai-computer-use", lanes: Array.from({ length: 17 }, (_v, i) => ({ id: `lane-${i}` })) }] }],
        ["over the 16-lane cap (roster)", { ...validCua, actors: [{ type: "openai-computer-use", roster: [{ id: "viewer", count: 17 }] }] }],
        ["duplicate lane ids", { ...validCua, actors: [{ type: "openai-computer-use", lanes: [{ id: "dup" }, { id: "dup" }] }] }],
        ["duplicate roster group ids", { ...validCua, actors: [{ type: "openai-computer-use", roster: [{ id: "dup", count: 1 }, { id: "dup", count: 1 }] }] }],
        ["bad lane id shape", { ...validCua, actors: [{ type: "openai-computer-use", lanes: [{ id: "Bad Id!" }, { id: "ok" }] }] }],
        ["bad roster id shape", { ...validCua, actors: [{ type: "openai-computer-use", roster: [{ id: "Bad Id!", count: 1 }] }] }],
        ["missing roster count", { ...validCua, actors: [{ type: "openai-computer-use", roster: [{ id: "viewer" }] }] }],
        ["unknown lane device", { ...validCua, actors: [{ type: "openai-computer-use", lanes: [{ id: "a", device: "phablet" }, { id: "b" }] }] }],
        ["unknown roster device", { ...validCua, actors: [{ type: "openai-computer-use", roster: [{ id: "viewer", count: 1, device: "phablet" }] }] }],
        ["bad lane target URL", { ...validCua, actors: [{ type: "openai-computer-use", lanes: [{ id: "a", target: "not-a-url" }, { id: "b", target: "http://127.0.0.1:3001/" }] }] }],
        ["mixed target/no-target roster", { ...validCua, actors: [{ type: "openai-computer-use", lanes: [{ id: "a", target: "http://127.0.0.1:3001/" }, { id: "b" }] }] }],
        ["target mixed with shared-world entry", { ...validCua, actors: [{ type: "openai-computer-use", lanes: [{ id: "a", target: "http://127.0.0.1:3001/", entry: "/a" }, { id: "b", target: "http://127.0.0.1:3002/" }] }] }],
        ["public lane target without allowPublicTargets", { ...validCua, actors: [{ type: "openai-computer-use", lanes: [{ id: "a", target: "https://role-a.preview.example.test/" }, { id: "b", target: "https://role-b.preview.example.test/" }] }] }],
        ["allowPublicTargets + N>1", {
          ...validCua,
          subject: { source: "app-url", appUrl: "https://preview.example.com/" },
          actors: [{ type: "openai-computer-use", count: 2 }],
          policies: { allowPublicTargets: true }
        }]
      ])("fails closed on fan-out mis-config: %s", (_label, input) => {
        const result = parseLabConfig(input);
        expect(result.ok, _label).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("HOMUN_LAB_INVALID");
      });

      it("warns actors[0].lanes as inert on a non-cua route (regression: other routes' rules fire)", () => {
        const result = parseLabConfig({
          schema: LAB_CONFIG_SCHEMA,
          id: "synthetic-lanes",
          subject: { source: "this-repo" },
          actors: [{ type: "synthetic-persona", lanes: [{ id: "a" }, { id: "b" }] }]
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.warnings.join(" ")).toContain("actors[0].lanes");
      });
    });

    it("names the registered computer-use actors in the unsupported-actor error", () => {
      const result = parseLabConfig({ ...validCua, actors: [{ type: "codex-app-server" }] });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("openai-computer-use");
      expect(result.error.message).toContain('"codex-app-server"');
    });

    it("accepts loopback variants (localhost, [::1]) and https", () => {
      for (const appUrl of ["http://localhost:8080/app", "https://127.0.0.1/", "http://[::1]:3000/"]) {
        const result = parseLabConfig({ ...validCua, subject: { source: "app-url", appUrl } });
        expect(result.ok, appUrl).toBe(true);
      }
    });

    it("policies.allowPublicTargets demotes the loopback wall: a public appUrl parses with it, fails without it", () => {
      const publicTarget = { ...validCua, subject: { source: "app-url", appUrl: "https://preview-123.vercel.app/" } };
      // Without the policy: rejected (safe default).
      const blocked = parseLabConfig(publicTarget);
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.error.message).toContain("allowPublicTargets");
      // With the policy: the owner has declared the target — accepted.
      const allowed = parseLabConfig({ ...publicTarget, policies: { allowPublicTargets: true } });
      expect(allowed.ok).toBe(true);
      if (allowed.ok) expect(allowed.config.subject.appUrl).toBe("https://preview-123.vercel.app/");
      // A garbage non-URL is still rejected even with the policy (shape gate holds).
      const garbage = parseLabConfig({ ...publicTarget, subject: { source: "app-url", appUrl: "not a url" }, policies: { allowPublicTargets: true } });
      expect(garbage.ok).toBe(false);
    });

    it("policies.redactScreenshots parses on the cua route with zero warnings (it is consumed)", () => {
      const result = parseLabConfig({ ...validCua, policies: { redactScreenshots: true } });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.policies?.redactScreenshots).toBe(true);
      expect(result.warnings).toEqual([]);
    });

    it("execution.desktop.device parses on the cua route with zero warnings (consumed)", () => {
      const result = parseLabConfig({
        ...validCua,
        execution: { target: "e2b-desktop", timeoutMs: 120000, desktop: { device: "mobile" } }
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.execution?.desktop?.device).toBe("mobile");
      expect(result.warnings).toEqual([]);
    });

    it("execution.desktop.browser parses on the cua route with zero warnings (consumed)", () => {
      const result = parseLabConfig({
        ...validCua,
        execution: { target: "e2b-desktop", timeoutMs: 120000, desktop: { browser: "chrome" } }
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.execution?.desktop?.browser).toBe("chrome");
      expect(result.warnings).toEqual([]);
    });

    it("rejects an unknown desktop browser", () => {
      const result = parseLabConfig({
        ...validCua,
        execution: { target: "e2b-desktop", timeoutMs: 120000, desktop: { browser: "safari" } }
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("execution.desktop.browser");
      expect(result.error.message).toContain("chrome");
    });

    it("rejects an unknown device preset", () => {
      const result = parseLabConfig({
        ...validCua,
        execution: { target: "e2b-desktop", timeoutMs: 120000, desktop: { device: "foldable" } }
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("execution.desktop.device");
      expect(result.error.message).toContain("mobile");
    });

    it("warns execution.desktop.device as inert on a non-cua route", () => {
      const result = parseLabConfig({
        schema: LAB_CONFIG_SCHEMA,
        id: "clone-smoke-device",
        subject: { source: "clone", repos: ["example-org/example-app"] },
        actors: [{ type: "homun-setup" }],
        execution: { desktop: { device: "mobile" } }
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.warnings[0]).toContain("execution.desktop.device");
    });

    it("warns execution.desktop.browser as inert on a non-cua route", () => {
      const result = parseLabConfig({
        schema: LAB_CONFIG_SCHEMA,
        id: "clone-smoke-browser",
        subject: { source: "clone", repos: ["example-org/example-app"] },
        actors: [{ type: "homun-setup" }],
        execution: { desktop: { browser: "chrome" } }
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.warnings[0]).toContain("execution.desktop.browser");
    });

    it("execution.desktop.template parses + trims on the cua route with zero warnings (consumed; any string is a valid name/id)", () => {
      const result = parseLabConfig({
        ...validCua,
        execution: { target: "e2b-desktop", timeoutMs: 120000, desktop: { template: "  acme-desktop-with-runtimes  " } }
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.execution?.desktop?.template).toBe("acme-desktop-with-runtimes");
      expect(result.warnings).toEqual([]);
    });

    it("rejects a blank/whitespace execution.desktop.template (set-but-empty is a mistake, not a template)", () => {
      const result = parseLabConfig({
        ...validCua,
        execution: { target: "e2b-desktop", timeoutMs: 120000, desktop: { template: "   " } }
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("execution.desktop.template");
    });

    it("warns execution.desktop.template as inert on the meta route (e2b-desktop, but no desktop-creating cua actor consumes it)", () => {
      const result = parseLabConfig({
        schema: LAB_CONFIG_SCHEMA,
        id: "meta-template",
        subject: { source: "clone", repos: ["example-org/example-app"] },
        actors: [{ type: "codex-app-server" }],
        execution: { target: "e2b-desktop", desktop: { template: "acme-desktop-with-runtimes" } }
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.warnings.join(" ")).toContain("execution.desktop.template");
    });

    it("warns execution.desktop.template as inert on the local-app route (routes to cua but creates NO desktop)", () => {
      const result = parseLabConfig({
        schema: LAB_CONFIG_SCHEMA,
        id: "local-app-template",
        subject: { source: "local-app", appUrl: "http://localhost:5173/" },
        actors: [{ type: "openai-computer-use", mission: "Drive the app." }],
        execution: { target: "local", desktop: { template: "acme-desktop-with-runtimes" } }
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // It routes to the cua backend, but the in-process route launches no E2B desktop, so the
      // template can never be consumed here → it must warn, never be silently ignored.
      expect(routesToComputerUse(result.config)).toBe(true);
      expect(result.warnings.join(" ")).toContain("execution.desktop.template");
    });
  });

  describe("app-url (scripted-browser route)", () => {
    const validScripted = {
      schema: LAB_CONFIG_SCHEMA,
      id: "scripted-demo",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:5173/" },
      actors: [{ type: "scripted-browser", persona: "synthetic-new-user", count: 2 }],
      scenario: { ref: "scripted-first-run" },
      execution: { target: "local", timeoutMs: 60000 }
    };

    it("parses a scripted lab with ZERO warnings — every set field is consumed on this route", () => {
      const result = parseLabConfig(validScripted);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.actors[0]?.type).toBe("scripted-browser");
      expect(result.config.scenario?.ref).toBe("scripted-first-run");
      expect(result.warnings).toEqual([]);
    });

    it("accepts an absent execution.target (absent means local on this route)", () => {
      const result = parseLabConfig({ ...validScripted, execution: { timeoutMs: 60000 } });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.warnings).toEqual([]);
    });

    it("accepts surface counts 1 and 2 (desktop / desktop + mobile)", () => {
      for (const count of [1, 2]) {
        const result = parseLabConfig({ ...validScripted, actors: [{ type: "scripted-browser", count }] });
        expect(result.ok, `count ${count}`).toBe(true);
      }
    });

    it.each([
      ["scripted actor on e2b-desktop", { ...validScripted, execution: { target: "e2b-desktop" } }],
      ["scripted actor on this-repo", { ...validScripted, subject: { source: "this-repo" }, execution: undefined }],
      ["count > 2 (fan-out is a later layer)", { ...validScripted, actors: [{ type: "scripted-browser", count: 3 }] }],
      ["missing scenario.ref (the steps ARE the actor)", { ...validScripted, scenario: undefined }],
      ["scenario.mode without ref", { ...validScripted, scenario: { mode: "live" } }],
      ["policies.redactScreenshots: true (blur unimplemented here; no silent raw)", { ...validScripted, policies: { redactScreenshots: true } }],
      ["policies.allowPublicTargets: true (driver enforces loopback per step)", { ...validScripted, policies: { allowPublicTargets: true } }],
      ["public appUrl", { ...validScripted, subject: { source: "app-url", appUrl: "https://example.com/" } }],
      ["two-actor scripted+LLM composition", { ...validScripted, actors: [{ type: "scripted-browser" }, { type: "openai-computer-use" }] }]
    ])("fails closed on scripted mis-config: %s", (_label, input) => {
      const result = parseLabConfig(input);
      expect(result.ok, _label).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("HOMUN_LAB_INVALID");
    });

    it("rejects subject.state on the scripted route (a clone-only field on an app-url subject)", () => {
      const result = parseLabConfig({
        ...validScripted,
        subject: {
          source: "app-url",
          appUrl: "http://127.0.0.1:5173/",
          state: { seed: [{ name: "seed", command: "pnpm db:seed" }] }
        }
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("subject.state");
      expect(result.error.message).toContain("clone subjects");
    });

    it("still rejects app-url × local with a computer-use actor (the cross-validation branch this route narrowed)", () => {
      const result = parseLabConfig({
        ...validScripted,
        actors: [{ type: "openai-computer-use" }],
        scenario: undefined
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // The message must point at BOTH valid pairings so the mis-config is self-recovering.
      expect(result.error.message).toContain("e2b-desktop");
      expect(result.error.message).toContain("scripted-browser");
    });

    it("names the scripted-browser actors in the app-url × e2b-desktop unsupported-actor error", () => {
      const result = parseLabConfig({
        ...validScripted,
        actors: [{ type: "codex-app-server" }],
        execution: { target: "e2b-desktop" },
        scenario: undefined
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("openai-computer-use");
      expect(result.error.message).toContain("scripted-browser");
    });

    it("warns mission/laneFocus/model as inert on the scripted route (no model runs); persona/count/timeoutMs stay de-warned", () => {
      const result = parseLabConfig({
        ...validScripted,
        actors: [{
          type: "scripted-browser",
          persona: "p1",
          count: 1,
          mission: "inert here",
          laneFocus: { instruction: "inert here" },
          model: "inert"
        }]
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("actors[0].mission");
      expect(result.warnings[0]).toContain("actors[0].laneFocus");
      expect(result.warnings[0]).toContain("actors[0].model");
      expect(result.warnings[0]).toContain("runs no model");
      expect(result.warnings[0]).not.toContain("actors[0].persona");
      expect(result.warnings[0]).not.toContain("execution.timeoutMs");
      expect(result.warnings[0]).not.toContain("scenario.ref");
    });

    it("keeps warning scenario.ref as forward-declared on NON-scripted routes", () => {
      const result = parseLabConfig({
        schema: LAB_CONFIG_SCHEMA,
        id: "synthetic-with-ref",
        subject: { source: "this-repo" },
        actors: [{ type: "synthetic-persona" }],
        scenario: { ref: "scripted-first-run" }
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.warnings[0]).toContain("scenario.ref");
    });

    it("keeps warning execution.desktop.* on the scripted route (device presets are the cua route's)", () => {
      const result = parseLabConfig({
        ...validScripted,
        execution: { target: "local", desktop: { device: "mobile" } }
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.warnings[0]).toContain("execution.desktop.device");
    });

    it("parses clone × e2b-desktop × scripted-browser as a provisioned synthetic scripted route", () => {
      const result = parseLabConfig({
        schema: LAB_CONFIG_SCHEMA,
        id: "provisioned-scripted",
        subject: {
          source: "clone",
          exposure: "synthetic",
          repos: ["example-org/example-app"],
          clone: { depth: 1 },
          serve: {
            install: "pnpm install --frozen-lockfile",
            build: "pnpm build",
            start: "pnpm start --host 0.0.0.0",
            url: "http://127.0.0.1:3000/"
          },
          env: ["GITHUB_TOKEN"],
          state: { seed: [{ name: "seed", command: "pnpm db:seed" }] }
        },
        actors: [{ type: "scripted-browser", persona: "workflow-reviewer", count: 1 }],
        scenario: { ref: "workflow-review-proof", mode: "live" },
        execution: { target: "e2b-desktop", timeoutMs: 120000, desktop: { template: "adopter-ui-sim-base" } }
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(routesToScriptedBrowser(result.config)).toBe(true);
      expect(routesToProvisionedScriptedBrowser(result.config)).toBe(true);
      expect(selectLabBackend(result.config)).toBe("scripted");
      expect(result.warnings).toEqual([]);
    });

    it.each([
      ["missing synthetic exposure", { subject: { exposure: undefined } }, "subject.exposure: synthetic"],
      ["missing seed", { subject: { state: undefined } }, "subject.state.seed"],
      ["external state", { subject: { env: ["DATABASE_URL"], state: { seed: [{ name: "seed", command: "pnpm db:seed" }], external: ["DATABASE_URL"] } } }, "do not allow `subject.state.external`"],
      ["loopback-only start", { subject: { serve: { start: "pnpm start", url: "http://127.0.0.1:3000/" } } }, "0.0.0.0"],
      ["lane roster", { actors: [{ type: "scripted-browser", lanes: [{ id: "provider" }] }] }, "actors[0].lanes"]
    ])("fails closed on unsafe provisioned scripted config: %s", (_label, patch, expected) => {
      const base = {
        schema: LAB_CONFIG_SCHEMA,
        id: "provisioned-scripted-invalid",
        subject: {
          source: "clone",
          exposure: "synthetic",
          repos: ["example-org/example-app"],
          serve: { start: "pnpm start --host 0.0.0.0", url: "http://127.0.0.1:3000/" },
          state: { seed: [{ name: "seed", command: "pnpm db:seed" }] }
        },
        actors: [{ type: "scripted-browser" }],
        scenario: { ref: "workflow-review-proof" },
        execution: { target: "e2b-desktop" }
      };
      const typedPatch = patch as { subject?: Record<string, unknown>; actors?: unknown[] };
      const input = {
        ...base,
        ...patch,
        subject: { ...base.subject, ...(typedPatch.subject ?? {}) },
        actors: typedPatch.actors ?? base.actors
      };
      const result = parseLabConfig(input);
      expect(result.ok, _label).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain(expected);
    });
  });

  describe("clone + serve (computer-use route)", () => {
    const validCloneCua = {
      schema: LAB_CONFIG_SCHEMA,
      id: "cua-clone",
      subject: {
        source: "clone",
        repos: ["example-org/example-app"],
        clone: { depth: 2 },
        serve: { install: "pnpm install", build: "pnpm build", start: "pnpm start", url: "http://127.0.0.1:3000/", readyTimeoutMs: 60000 },
        env: ["DATABASE_URL", "GITHUB_TOKEN"]
      },
      actors: [{ type: "openai-computer-use", mission: "Explore." }],
      execution: { target: "e2b-desktop", timeoutMs: 120000 },
      scenario: { mode: "live" }
    };

    it("parses configurable install/build timeouts on serve (monorepo-scale builds exceed the default)", () => {
      const result = parseLabConfig({
        ...validCloneCua,
        subject: {
          ...validCloneCua.subject,
          serve: { ...validCloneCua.subject.serve, installTimeoutMs: 1_200_000, buildTimeoutMs: 1_800_000 }
        }
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.subject.serve?.installTimeoutMs).toBe(1_200_000);
      expect(result.config.subject.serve?.buildTimeoutMs).toBe(1_800_000);
      expect(result.warnings).toEqual([]);
    });

    it("serve.url stays loopback-only even with allowPublicTargets (the lab serves the clone in-sandbox)", () => {
      const result = parseLabConfig({
        ...validCloneCua,
        subject: { ...validCloneCua.subject, serve: { ...validCloneCua.subject.serve, url: "https://preview.vercel.app/" } },
        policies: { allowPublicTargets: true }
      });
      // allowPublicTargets governs app-url subjects, not where we serve a clone — serve.url must be loopback.
      expect(result.ok).toBe(false);
    });

    it("parses with ZERO warnings — serve, env, and clone.depth are all consumed on this route", () => {
      const result = parseLabConfig(validCloneCua);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.subject.serve?.start).toBe("pnpm start");
      expect(result.config.subject.env).toEqual(["DATABASE_URL", "GITHUB_TOKEN"]);
      expect(result.warnings).toEqual([]);
    });

    it("REJECTS clone.fanout on the cua route (declared behavior change) but accepts clone.keep/depth", () => {
      // clone.fanout is now a hard parse error on the cua route — fan-out is declared via
      // actors[0].count/lanes, not subject.clone.fanout (which drives the OSS smoke/meta routes).
      const rejected = parseLabConfig({
        ...validCloneCua,
        subject: { ...validCloneCua.subject, clone: { depth: 1, keep: true, fanout: 2 } }
      });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) return;
      expect(rejected.error.code).toBe("HOMUN_LAB_INVALID");
      expect(rejected.error.message).toContain("subject.clone.fanout");

      // clone.keep + depth alone parse clean (keep is honored on failure; depth is consumed).
      const accepted = parseLabConfig({
        ...validCloneCua,
        subject: { ...validCloneCua.subject, clone: { depth: 1, keep: true } }
      });
      expect(accepted.ok).toBe(true);
      if (!accepted.ok) return;
      expect(accepted.warnings).toEqual([]);
    });

    it("ACCEPTS a homogeneous count > 1 on the clone cua route (each lane clones the same repo)", () => {
      const result = parseLabConfig({ ...validCloneCua, actors: [{ type: "openai-computer-use", count: 3 }] });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.actors[0]?.count).toBe(3);
    });

    it("warns serve/env/depth as inert on clone routes that do NOT serve (smoke/meta)", () => {
      const smoke = parseLabConfig({
        ...validCloneCua,
        actors: [{ type: "homun-setup" }],
        execution: undefined,
        scenario: undefined
      });
      expect(smoke.ok).toBe(true);
      if (!smoke.ok) return;
      expect(smoke.warnings[0]).toContain("subject.serve");
      expect(smoke.warnings[0]).toContain("subject.env");
      expect(smoke.warnings[0]).toContain("subject.clone.depth");

      const meta = parseLabConfig({
        ...validCloneCua,
        subject: { ...validCloneCua.subject, serve: undefined, env: undefined },
        actors: [{ type: "codex-app-server" }]
      });
      expect(meta.ok).toBe(true);
      if (!meta.ok) return;
      expect(meta.warnings[0] ?? "").toContain("subject.clone.depth");
    });

    it.each([
      ["serve on app-url", { ...validCloneCua, subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/", serve: validCloneCua.subject.serve } }],
      ["serve on this-repo", { ...validCloneCua, subject: { source: "this-repo", serve: validCloneCua.subject.serve }, execution: undefined, scenario: undefined }],
      ["env on app-url", { ...validCloneCua, subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/", env: ["X_Y"] } }],
      ["serve without start", { ...validCloneCua, subject: { ...validCloneCua.subject, serve: { url: "http://127.0.0.1:3000/" } } }],
      ["serve without url", { ...validCloneCua, subject: { ...validCloneCua.subject, serve: { start: "pnpm start" } } }],
      ["serve with public url", { ...validCloneCua, subject: { ...validCloneCua.subject, serve: { start: "pnpm start", url: "https://example.com/" } } }],
      ["bad env name", { ...validCloneCua, subject: { ...validCloneCua.subject, env: ["lowercase-bad"] } }],
      ["empty env list", { ...validCloneCua, subject: { ...validCloneCua.subject, env: [] } }],
      ["cua-clone without serve", { ...validCloneCua, subject: { source: "clone", repos: ["example-org/example-app"] } }],
      ["two repos on cua-clone", { ...validCloneCua, subject: { ...validCloneCua.subject, repos: ["a/b", "c/d"] } }],
      ["bad repo slug", { ...validCloneCua, subject: { ...validCloneCua.subject, repos: ["not a slug; rm -rf"] } }],
      ["clone.fanout (declared behavior change: rejected on cua)", { ...validCloneCua, subject: { ...validCloneCua.subject, clone: { fanout: 2 } } }],
      ["over the 16-lane cap", { ...validCloneCua, actors: [{ type: "openai-computer-use", count: 17 }] }]
    ])("fails closed on clone+serve mis-config: %s", (_label, input) => {
      const result = parseLabConfig(input);
      expect(result.ok, _label).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("HOMUN_LAB_INVALID");
    });
  });

  describe("subject.state (seed/migrate/fixtures, computer-use clone route)", () => {
    const validCloneCua = {
      schema: LAB_CONFIG_SCHEMA,
      id: "cua-clone-state",
      subject: {
        source: "clone",
        repos: ["example-org/example-app"],
        serve: { install: "pnpm install", build: "pnpm build", start: "pnpm start", url: "http://127.0.0.1:3000/" },
        env: ["DATABASE_URL"]
      },
      actors: [{ type: "openai-computer-use", mission: "Explore." }],
      execution: { target: "e2b-desktop", timeoutMs: 120000 },
      scenario: { mode: "live" }
    };
    const withState = (state: unknown) => ({
      ...validCloneCua,
      subject: { ...validCloneCua.subject, state }
    });

    it("parses a full state declaration (all three phases + external) with ZERO warnings on the cua route", () => {
      const result = parseLabConfig(withState({
        seed: [
          { name: "db-up", command: "sudo service postgresql start && pg_isready -t 30", when: "before-start" },
          { name: "db-migrate", command: "pnpm prisma migrate deploy", timeoutMs: 300000 },
          { name: "prebuild-fixtures", command: "node scripts/fixtures.js", when: "before-build" },
          { name: "admin-user", command: "curl -sf -X POST http://127.0.0.1:3000/api/test/bootstrap-admin", when: "after-ready" }
        ],
        external: ["DATABASE_URL"]
      }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.warnings).toEqual([]);
      expect(result.config.subject.state?.seed).toHaveLength(4);
      expect(result.config.subject.state?.seed?.[0]).toEqual({
        name: "db-up",
        command: "sudo service postgresql start && pg_isready -t 30",
        when: "before-start"
      });
      // `when` stays optional in the parsed config (the engine defaults it to before-start).
      expect(result.config.subject.state?.seed?.[1]).toEqual({
        name: "db-migrate",
        command: "pnpm prisma migrate deploy",
        timeoutMs: 300000
      });
      expect(result.config.subject.state?.external).toEqual(["DATABASE_URL"]);
    });

    it("parses seed-only state (no external) — the common synthetic-seed shape", () => {
      const result = parseLabConfig(withState({
        seed: [{ name: "fixtures", command: "pnpm prisma db seed" }]
      }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.warnings).toEqual([]);
    });

    it.each([
      ["state on app-url", {
        ...validCloneCua,
        subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/", state: { seed: [{ name: "a", command: "true" }] } }
      }],
      ["state on this-repo", {
        schema: LAB_CONFIG_SCHEMA,
        id: "x",
        subject: { source: "this-repo", state: { seed: [{ name: "a", command: "true" }] } },
        actors: [{ type: "synthetic-persona" }]
      }],
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
      ["duplicate step names", withState({ seed: [{ name: "a", command: "true" }, { name: "a", command: "false" }] })],
      ["bad when", withState({ seed: [{ name: "a", command: "true", when: "after-start" }] })],
      ["zero timeoutMs", withState({ seed: [{ name: "a", command: "true", timeoutMs: 0 }] })],
      ["non-numeric timeoutMs", withState({ seed: [{ name: "a", command: "true", timeoutMs: "soon" }] })],
      ["external empty list", withState({ external: [] })],
      ["external value-shaped entry", withState({ external: ["lowercase-not-a-name"] })],
      ["external name not in subject.env", withState({ external: ["REDIS_URL"] })],
      ["external without subject.env at all", {
        ...validCloneCua,
        subject: { ...validCloneCua.subject, env: undefined, state: { external: ["DATABASE_URL"] } }
      }]
    ])("fails closed on state mis-config: %s", (_label, input) => {
      const result = parseLabConfig(input);
      expect(result.ok, _label).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("HOMUN_LAB_INVALID");
    });

    it("names the provisioned-channel rule when external is not backed by subject.env", () => {
      const result = parseLabConfig(withState({ external: ["REDIS_URL"] }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("subject.env");
      expect(result.error.message).toContain("provisioned channel");
    });

    it("warns subject.state as inert on non-cua routes — alongside the other forward-declared warnings, which still fire", () => {
      // Smoke route (clone, no desktop target): serve, env, AND state all warn — adding the
      // state warning must not displace the existing ones.
      const smoke = parseLabConfig({
        ...withState({ seed: [{ name: "fixtures", command: "pnpm prisma db seed" }] }),
        actors: [{ type: "homun-setup" }],
        execution: undefined,
        scenario: undefined
      });
      expect(smoke.ok).toBe(true);
      if (!smoke.ok) return;
      expect(smoke.warnings).toHaveLength(1);
      expect(smoke.warnings[0]).toContain("subject.state");
      expect(smoke.warnings[0]).toContain("subject.serve");
      expect(smoke.warnings[0]).toContain("subject.env");

      // Meta route (clone × e2b-desktop, non-cua actor): same story.
      const meta = parseLabConfig({
        ...withState({ seed: [{ name: "fixtures", command: "pnpm prisma db seed" }] }),
        actors: [{ type: "codex-app-server" }]
      });
      expect(meta.ok).toBe(true);
      if (!meta.ok) return;
      expect(meta.warnings[0]).toContain("subject.state");
      expect(meta.warnings[0]).toContain("subject.serve");
    });
  });
});

// RUNG 1 (#148): the local-app subject.source — an already-running local dev server driven
// in-process via a custom CuaExecutor (no clone, no E2B desktop). Parse-validated fail-closed.
describe("parseLabConfig (local-app subject — issue #148)", () => {
  const validLocalApp = {
    schema: LAB_CONFIG_SCHEMA,
    id: "local-app-state",
    subject: { source: "local-app", appUrl: "http://localhost:5173/" },
    actors: [{ type: "openai-computer-use", persona: "pixel-pat", mission: "Drive the app via its state contract." }],
    scenario: { mode: "live" }
  };

  it("parses a local-app + computer-use actor and routes to the cua backend", () => {
    const result = parseLabConfig(validLocalApp);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.subject).toEqual({ source: "local-app", appUrl: "http://localhost:5173/" });
    expect(routesToComputerUse(result.config)).toBe(true);
    expect(routesToScriptedBrowser(result.config)).toBe(false);
    expect(selectLabBackend(result.config)).toBe("cua");
    // The actor prompt fields are consumed on this route (composeInstructions): no inert warning.
    expect(result.warnings).toEqual([]);
  });

  it("accepts execution.target: local explicitly (and absent), routing to cua either way", () => {
    const explicit = parseLabConfig({ ...validLocalApp, execution: { target: "local", timeoutMs: 60000 } });
    expect(explicit.ok).toBe(true);
    if (explicit.ok) expect(selectLabBackend(explicit.config)).toBe("cua");
  });

  it("accepts loopback variants (127.0.0.1, [::1], https)", () => {
    for (const appUrl of ["http://127.0.0.1:3000/", "https://localhost/", "http://[::1]:5173/"]) {
      const result = parseLabConfig({ ...validLocalApp, subject: { source: "local-app", appUrl } });
      expect(result.ok, appUrl).toBe(true);
    }
  });

  it.each([
    ["missing appUrl", { ...validLocalApp, subject: { source: "local-app" } }],
    ["public URL (always loopback on this route)", { ...validLocalApp, subject: { source: "local-app", appUrl: "https://example.com/" } }],
    ["non-http scheme", { ...validLocalApp, subject: { source: "local-app", appUrl: "file:///tmp/x.html" } }],
    ["e2b-desktop target (the whole point is to skip the desktop)", { ...validLocalApp, execution: { target: "e2b-desktop" } }],
    ["non-cua actor (codex-app-server)", { ...validLocalApp, actors: [{ type: "codex-app-server" }] }],
    ["scripted-browser actor", { ...validLocalApp, actors: [{ type: "scripted-browser" }] }],
    ["unregistered actor type", { ...validLocalApp, actors: [{ type: "not-a-real-actor" }] }],
    ["fan-out count", { ...validLocalApp, actors: [{ type: "openai-computer-use", count: 2 }] }],
    ["allowPublicTargets (no public target on this route)", { ...validLocalApp, policies: { allowPublicTargets: true } }],
    ["clone-only field serve", { ...validLocalApp, subject: { source: "local-app", appUrl: "http://localhost:5173/", serve: { start: "pnpm dev", url: "http://localhost:5173/" } } }],
    ["clone-only field env", { ...validLocalApp, subject: { source: "local-app", appUrl: "http://localhost:5173/", env: ["DATABASE_URL"] } }],
    ["clone-only field state", { ...validLocalApp, subject: { source: "local-app", appUrl: "http://localhost:5173/", state: { seed: [{ name: "s", command: "x" }] } } }],
    ["clone-only field repos", { ...validLocalApp, subject: { source: "local-app", appUrl: "http://localhost:5173/", repos: ["a/b"] } }]
  ])("fails closed on local-app mis-config: %s", (_label, input) => {
    const result = parseLabConfig(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HOMUN_LAB_INVALID");
  });

  it("the e2b-desktop rejection names the right remedy (app-url for the hosted desktop route)", () => {
    const result = parseLabConfig({ ...validLocalApp, execution: { target: "e2b-desktop" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("app-url");
    expect(result.error.message.toLowerCase()).toContain("e2b-desktop");
  });
});

// --- Shared-world topology (#164) parser matrix ------------------------------------------------
function validSharedWorld(overrides?: { subject?: Record<string, unknown>; actors?: unknown; execution?: Record<string, unknown> }): Record<string, unknown> {
  return {
    schema: LAB_CONFIG_SCHEMA,
    id: "shared-world-proof",
    subject: {
      source: "clone",
      topology: "shared-world",
      repos: ["example-org/collab-app"],
      env: ["DATABASE_URL"],
      serve: { start: "pnpm start", url: "http://127.0.0.1:3000/" },
      state: {
        seed: [{ name: "migrate", command: "pnpm db:migrate" }],
        checkpoint: [{ name: "notes-count", command: "echo count" }]
      },
      ...(overrides?.subject ?? {})
    },
    actors: overrides?.actors ?? [
      {
        type: "openai-computer-use",
        mission: "Use the shared app.",
        lanes: [
          { id: "role-author", actorType: "author", surface: "studio", caseGroup: "case-001", persona: "author", entry: "/compose", instruction: "Create a note." },
          { id: "role-reviewer", actorType: "reviewer", surface: "queue", caseGroup: "case-001", persona: "reviewer", entry: "/inbox", instruction: "Review the note." }
        ]
      }
    ],
    execution: overrides?.execution ?? { target: "e2b-desktop", timeoutMs: 60000 }
  };
}

describe("shared-world topology routing + cross-validation (#164)", () => {
  it("parses a valid shared-world lab, routes to the shared-world backend, no warnings", () => {
    const result = parseLabConfig(validSharedWorld());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.subject.topology).toBe("shared-world");
    expect(routesToSharedWorld(result.config)).toBe(true);
    expect(selectLabBackend(result.config)).toBe("shared-world");
    expect(sharedWorldValidationReason(result.config)).toBeNull();
    expect(result.warnings).toEqual([]);
    // The roster IS the role roster (no parallel roles[] field).
    expect(result.config.actors[0]?.lanes?.map((lane) => lane.id)).toEqual(["role-author", "role-reviewer"]);
    expect(result.config.actors[0]?.lanes?.map((lane) => [lane.actorType, lane.surface, lane.caseGroup])).toEqual([
      ["author", "studio", "case-001"],
      ["reviewer", "queue", "case-001"]
    ]);
    expect(result.config.subject.state?.checkpoint?.map((probe) => probe.name)).toEqual(["notes-count"]);
  });

  it("execution.desktop.browser parses on sequential shared-world with zero warnings", () => {
    const result = parseLabConfig(validSharedWorld({
      execution: { target: "e2b-desktop", timeoutMs: 60000, desktop: { browser: "chrome" } }
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(selectLabBackend(result.config)).toBe("shared-world");
    expect(result.config.execution?.desktop?.browser).toBe("chrome");
    expect(result.warnings).toEqual([]);
  });

  it("rejects malformed lane grouping metadata instead of persisting arbitrary labels", () => {
    const result = parseLabConfig(validSharedWorld({
      actors: [{
        type: "openai-computer-use",
        lanes: [
          { id: "role-a", actorType: "person with spaces", entry: "/compose" },
          { id: "role-b", actorType: "reviewer", entry: "/inbox" }
        ]
      }]
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("actorType");
  });

  it("expands compact roster groups before shared-world validation", () => {
    const result = parseLabConfig(validSharedWorld({
      actors: [{
        type: "openai-computer-use",
        mission: "Use the shared app.",
        roster: [
          { id: "author", count: 2, actorType: "author", surface: "studio", caseGroup: "case-001", persona: "writer", entry: "/compose", instruction: "Create a note." },
          { id: "reviewer", count: 1, actorType: "reviewer", surface: "queue", caseGroup: "case-001", persona: "reviewer", entry: "/inbox", instruction: "Review the note." }
        ]
      }]
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(routesToSharedWorld(result.config)).toBe(true);
    expect(sharedWorldValidationReason(result.config)).toBeNull();
    expect(result.config.actors[0]?.lanes?.map((lane) => [lane.id, lane.actorType, lane.surface, lane.caseGroup, lane.entry])).toEqual([
      ["author-01", "author", "studio", "case-001", "/compose"],
      ["author-02", "author", "studio", "case-001", "/compose"],
      ["reviewer-01", "reviewer", "queue", "case-001", "/inbox"]
    ]);
  });

  it("the SAME composition WITHOUT topology stays per-lane-worlds (cua), proving topology is the switch", () => {
    const sw = validSharedWorld();
    const subject = { ...(sw.subject as Record<string, unknown>) };
    delete subject.topology;
    const result = parseLabConfig({ ...sw, subject });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(routesToSharedWorld(result.config)).toBe(false);
    expect(routesToComputerUse(result.config)).toBe(true);
    expect(selectLabBackend(result.config)).toBe("cua");
    // entry is now inert (per-lane-worlds has no per-role entry) and warns.
    expect(result.warnings.join("\n")).toContain("actors[0].lanes[].entry");
    expect(result.warnings.join("\n")).toContain("subject.state.checkpoint");
  });

  it.each([
    ["missing serve", validSharedWorld({ subject: { serve: undefined } })],
    ["roster < 2 roles", validSharedWorld({ actors: [{ type: "openai-computer-use", lanes: [{ id: "only-role", entry: "/x" }] }] })],
    ["wrong source (this-repo)", { schema: LAB_CONFIG_SCHEMA, id: "sw-src", subject: { source: "this-repo", topology: "shared-world" }, actors: [{ type: "synthetic-persona" }] }],
    ["wrong target (no e2b-desktop)", validSharedWorld({ execution: { timeoutMs: 60000 } })],
    ["missing checkpoint", validSharedWorld({ subject: { state: { seed: [{ name: "migrate", command: "pnpm db:migrate" }] } } })],
    ["entry not same-origin with serve.url", validSharedWorld({ actors: [{ type: "openai-computer-use", lanes: [{ id: "role-a", entry: "http://evil.example.com/x" }, { id: "role-b", entry: "/inbox" }] }] })]
  ])("fails closed on shared-world mis-config: %s", (_label, input) => {
    const result = parseLabConfig(input as Record<string, unknown>);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HOMUN_LAB_INVALID");
  });

  it("each fail-closed reason names its requirement precisely", () => {
    const noServe = parseLabConfig(validSharedWorld({ subject: { serve: undefined } }));
    expect(noServe.ok).toBe(false);
    if (!noServe.ok) expect(noServe.error.message).toContain("subject.serve");
    const oneRole = parseLabConfig(validSharedWorld({ actors: [{ type: "openai-computer-use", lanes: [{ id: "only", entry: "/x" }] }] }));
    expect(oneRole.ok).toBe(false);
    if (!oneRole.ok) expect(oneRole.error.message).toContain("at least 2 roles");
    const noCheckpoint = parseLabConfig(validSharedWorld({ subject: { state: { seed: [{ name: "migrate", command: "pnpm db:migrate" }] } } }));
    expect(noCheckpoint.ok).toBe(false);
    if (!noCheckpoint.ok) expect(noCheckpoint.error.message).toContain("subject.state.checkpoint");
    const badEntry = parseLabConfig(validSharedWorld({ actors: [{ type: "openai-computer-use", lanes: [{ id: "role-a", entry: "http://evil.example.com/x" }, { id: "role-b", entry: "/inbox" }] }] }));
    expect(badEntry.ok).toBe(false);
    if (!badEntry.ok) expect(badEntry.error.message).toContain("same-origin");
  });

  it("entry validation accepts same-origin paths + absolute loopback URLs, rejects cross-origin/non-loopback", () => {
    expect(resolveSeatUrl("http://127.0.0.1:3000/", "/compose")).toBe("http://127.0.0.1:3000/compose");
    expect(resolveSeatUrl("http://127.0.0.1:3000/", "http://127.0.0.1:3000/inbox")).toBe("http://127.0.0.1:3000/inbox");
    expect(resolveSeatUrl("http://127.0.0.1:3000/", undefined)).toBe("http://127.0.0.1:3000/");
    expect(resolveSeatUrl("http://127.0.0.1:3000/", "http://127.0.0.1:4000/x")).toBeNull(); // different port → cross-origin
    expect(resolveSeatUrl("http://127.0.0.1:3000/", "http://example.com/x")).toBeNull(); // cross-origin
  });

  it("rejects a malformed checkpoint (missing command / duplicate name / value-shaped redact)", () => {
    const noCommand = parseLabConfig(validSharedWorld({ subject: { state: { checkpoint: [{ name: "c1" }] } } }));
    expect(noCommand.ok).toBe(false);
    const dupName = parseLabConfig(validSharedWorld({ subject: { state: { checkpoint: [{ name: "c1", command: "echo a" }, { name: "c1", command: "echo b" }] } } }));
    expect(dupName.ok).toBe(false);
    if (!dupName.ok) expect(dupName.error.message).toContain("unique");
    const badRedact = parseLabConfig(validSharedWorld({ subject: { state: { checkpoint: [{ name: "c1", command: "echo a", redact: "not-a-list" }] } } }));
    expect(badRedact.ok).toBe(false);
  });

  it("topology + checkpoint warn as inert off the shared-world route, and the other routes are byte-stable", () => {
    // topology on an app-url cua route warns inert.
    const appUrl = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "sw-warn",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/", topology: "per-lane-worlds" },
      actors: [{ type: "openai-computer-use", mission: "x" }],
      execution: { target: "e2b-desktop" }
    });
    expect(appUrl.ok).toBe(true);
    if (appUrl.ok) {
      expect(appUrl.warnings.join("\n")).toContain("subject.topology");
      expect(routesToSharedWorld(appUrl.config)).toBe(false);
      expect(selectLabBackend(appUrl.config)).toBe("cua");
    }

    // Every existing route still parses + routes unchanged (regression guard).
    const synthetic = parseLabConfig({ schema: LAB_CONFIG_SCHEMA, id: "s", subject: { source: "this-repo" }, actors: [{ type: "synthetic-persona" }] });
    const smoke = parseLabConfig({ schema: LAB_CONFIG_SCHEMA, id: "c", subject: { source: "clone", repos: ["a/b"] }, actors: [{ type: "homun-setup" }] });
    const meta = parseLabConfig({ schema: LAB_CONFIG_SCHEMA, id: "m", subject: { source: "clone", repos: ["a/b"] }, actors: [{ type: "codex-app-server" }], execution: { target: "e2b-desktop" } });
    const scripted = parseLabConfig({ schema: LAB_CONFIG_SCHEMA, id: "sc", subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" }, actors: [{ type: "scripted-browser" }], scenario: { ref: "scripted-first-run" } });
    const terminal = parseLabConfig({ schema: LAB_CONFIG_SCHEMA, id: "t", subject: { source: "terminal-product", product: { name: "widgetsmith", publicSurfaces: ["https://example.com/x"] } }, actors: [{ type: "codex-exec" }] });
    for (const result of [synthetic, smoke, meta, scripted, terminal]) {
      expect(result.ok).toBe(true);
      if (result.ok) expect(routesToSharedWorld(result.config)).toBe(false);
    }
    if (synthetic.ok) expect(selectLabBackend(synthetic.config)).toBe("synthetic");
    if (smoke.ok) expect(selectLabBackend(smoke.config)).toBe("smoke");
    if (meta.ok) expect(selectLabBackend(meta.config)).toBe("meta");
    if (scripted.ok) expect(selectLabBackend(scripted.config)).toBe("scripted");
    if (terminal.ok) expect(selectLabBackend(terminal.config)).toBe("terminal");
  });
});

// --- CONCURRENT shared-world topology (#164 phase 2) parser matrix ------------------------------
function validConcurrent(overrides?: { subject?: Record<string, unknown>; actors?: unknown; execution?: Record<string, unknown> }): Record<string, unknown> {
  return {
    schema: LAB_CONFIG_SCHEMA,
    id: "concurrent-shared-world-proof",
    subject: {
      source: "clone",
      topology: "shared-world",
      exposure: "synthetic",
      repos: ["example-org/collab-app"],
      env: ["DATABASE_URL"],
      serve: { start: "pnpm start -H 0.0.0.0", url: "http://127.0.0.1:3000/" },
      state: {
        seed: [{ name: "migrate", command: "pnpm db:migrate" }],
        checkpoint: [{ name: "notes-count", command: "echo count" }]
      },
      ...(overrides?.subject ?? {})
    },
    actors: overrides?.actors ?? [
      {
        type: "openai-computer-use",
        mission: "Use the shared app.",
        lanes: [
          { id: "persona-a", persona: "author", entry: "/compose" },
          { id: "persona-b", persona: "reviewer", entry: "/inbox" },
          { id: "persona-c", persona: "skimmer", entry: "/feed" }
        ]
      }
    ],
    execution: overrides?.execution ?? { target: "e2b-desktop", timeoutMs: 60000, concurrency: 3 }
  };
}

describe("concurrent shared-world routing + cross-validation (#164 phase 2)", () => {
  it("routes shared-world + concurrency>1 to the concurrent backend; no warnings", () => {
    const result = parseLabConfig(validConcurrent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(routesToConcurrentSharedWorld(result.config)).toBe(true);
    expect(routesToSharedWorld(result.config)).toBe(true); // concurrent is a shared-world subtype
    expect(selectLabBackend(result.config)).toBe("concurrent-shared-world");
    expect(concurrentSharedWorldValidationReason(result.config)).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it("the SAME shared-world config with concurrency 1 (or absent) stays SEQUENTIAL", () => {
    const seq1 = parseLabConfig(validConcurrent({ execution: { target: "e2b-desktop", timeoutMs: 60000, concurrency: 1 } }));
    expect(seq1.ok).toBe(true);
    if (seq1.ok) {
      expect(routesToConcurrentSharedWorld(seq1.config)).toBe(false);
      expect(selectLabBackend(seq1.config)).toBe("shared-world");
      // exposure is inert on the sequential route → warns.
      expect(seq1.warnings.join("\n")).toContain("subject.exposure");
    }
    const seqAbsent = parseLabConfig(validConcurrent({ execution: { target: "e2b-desktop", timeoutMs: 60000 } }));
    expect(seqAbsent.ok).toBe(true);
    if (seqAbsent.ok) expect(selectLabBackend(seqAbsent.config)).toBe("shared-world");
  });

  it.each([
    ["missing synthetic-subject attestation", validConcurrent({ subject: { exposure: undefined } })],
    ["serve.start does not bind 0.0.0.0", validConcurrent({ subject: { serve: { start: "pnpm start", url: "http://127.0.0.1:3000/" } } })],
    ["subject.clone.keep on the concurrent route", validConcurrent({ subject: { clone: { keep: true } } })],
    ["roster < 2 personas", validConcurrent({ actors: [{ type: "openai-computer-use", lanes: [{ id: "only", entry: "/x" }] }] })],
    ["missing checkpoint", validConcurrent({ subject: { state: { seed: [{ name: "migrate", command: "pnpm db:migrate" }] } } })]
  ])("fails closed on concurrent mis-config: %s", (_label, input) => {
    const result = parseLabConfig(input as Record<string, unknown>);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HOMUN_LAB_INVALID");
  });

  it("each concurrent fail-closed reason names its requirement precisely", () => {
    const noExposure = parseLabConfig(validConcurrent({ subject: { exposure: undefined } }));
    expect(noExposure.ok).toBe(false);
    if (!noExposure.ok) expect(noExposure.error.message).toContain("subject.exposure: synthetic");
    const badBind = parseLabConfig(validConcurrent({ subject: { serve: { start: "pnpm start", url: "http://127.0.0.1:3000/" } } }));
    expect(badBind.ok).toBe(false);
    if (!badBind.ok) expect(badBind.error.message).toContain("0.0.0.0");
    const keep = parseLabConfig(validConcurrent({ subject: { clone: { keep: true } } }));
    expect(keep.ok).toBe(false);
    if (!keep.ok) expect(keep.error.message).toContain("subject.clone.keep");
  });

  it("exposure: synthetic is enum-validated and inert (warned) off the concurrent route", () => {
    const badExposure = parseLabConfig(validConcurrent({ subject: { exposure: "real" } }));
    expect(badExposure.ok).toBe(false);
    // exposure on a plain app-url cua route warns inert.
    const offRoute = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "exp-warn",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/", exposure: "synthetic" },
      actors: [{ type: "openai-computer-use", mission: "x" }],
      execution: { target: "e2b-desktop" }
    });
    expect(offRoute.ok).toBe(true);
    if (offRoute.ok) {
      expect(routesToConcurrentSharedWorld(offRoute.config)).toBe(false);
      expect(offRoute.warnings.join("\n")).toContain("subject.exposure");
    }
  });

  it("existing routes stay byte-stable (none route to concurrent shared-world)", () => {
    const synthetic = parseLabConfig({ schema: LAB_CONFIG_SCHEMA, id: "s", subject: { source: "this-repo" }, actors: [{ type: "synthetic-persona" }] });
    const smoke = parseLabConfig({ schema: LAB_CONFIG_SCHEMA, id: "c", subject: { source: "clone", repos: ["a/b"] }, actors: [{ type: "homun-setup" }] });
    const meta = parseLabConfig({ schema: LAB_CONFIG_SCHEMA, id: "m", subject: { source: "clone", repos: ["a/b"] }, actors: [{ type: "codex-app-server" }], execution: { target: "e2b-desktop" } });
    // A plain cua fan-out (concurrency>1 but NO shared-world topology) stays cua, NOT concurrent shared-world.
    const fanout = parseLabConfig({ schema: LAB_CONFIG_SCHEMA, id: "f", subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" }, actors: [{ type: "openai-computer-use", count: 3 }], execution: { target: "e2b-desktop", concurrency: 2 } });
    for (const result of [synthetic, smoke, meta, fanout]) {
      expect(result.ok).toBe(true);
      if (result.ok) expect(routesToConcurrentSharedWorld(result.config)).toBe(false);
    }
    if (fanout.ok) expect(selectLabBackend(fanout.config)).toBe("cua");
  });
});


// RUNG 1: the local-tree subject.source (issue #261) - packs the operator's own working tree
// (the lab resolution cwd) and provisions it in-sandbox in place of a clone. Routing requires
// execution.target: e2b-desktop and a computer-use actor; everything else fails closed at parse.
describe("parseLabConfig (local-tree subject - issue #261)", () => {
  const validLocalTree = {
    schema: LAB_CONFIG_SCHEMA,
    id: "local-tree-lab",
    subject: {
      source: "local-tree",
      serve: { start: "pnpm start", url: "http://127.0.0.1:3000/" }
    },
    actors: [{ type: "openai-computer-use", persona: "pixel-pat", mission: "Explore the packed working tree." }],
    execution: { target: "e2b-desktop" }
  };

  it("parses a minimal local-tree lab and routes to the cua backend with ZERO warnings", () => {
    const result = parseLabConfig(validLocalTree);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.subject.source).toBe("local-tree");
    expect(result.config.subject.serve?.start).toBe("pnpm start");
    expect(result.config.subject.serve?.url).toBe("http://127.0.0.1:3000/");
    expect(routesToComputerUse(result.config)).toBe(true);
    expect(selectLabBackend(result.config)).toBe("cua");
    expect(result.warnings).toEqual([]);
  });

  it("normalizes localTree.exclude entries (leading ./ and trailing / stripped)", () => {
    const result = parseLabConfig({
      ...validLocalTree,
      subject: { ...validLocalTree.subject, localTree: { exclude: ["./big-media", "vendor/"] } }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.subject.localTree).toEqual({ exclude: ["big-media", "vendor"] });
  });

  it("round-trips subject.localTree fields (keep/exclude/maxArchiveBytes)", () => {
    const result = parseLabConfig({
      ...validLocalTree,
      subject: {
        ...validLocalTree.subject,
        localTree: { keep: true, exclude: ["big-media", "vendor"], maxArchiveBytes: 100_000_000 }
      }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.subject.localTree).toEqual({
      keep: true,
      exclude: ["big-media", "vendor"],
      maxArchiveBytes: 100_000_000
    });
  });

  it("localTree is optional - a bare local-tree lab has no subject.localTree at all", () => {
    const result = parseLabConfig(validLocalTree);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.subject.localTree).toBeUndefined();
  });

  it.each([
    ["repos on local-tree", { ...validLocalTree, subject: { ...validLocalTree.subject, repos: ["a/b"] } }],
    ["clone block on local-tree", { ...validLocalTree, subject: { ...validLocalTree.subject, clone: { depth: 1 } } }],
    ["missing serve", { ...validLocalTree, subject: { source: "local-tree" } }],
    ["missing execution.target e2b-desktop", { ...validLocalTree, execution: undefined }],
    ["local execution.target (the whole point is a hosted desktop)", { ...validLocalTree, execution: { target: "local" } }],
    ["non-computer-use actor (codex-app-server)", { ...validLocalTree, actors: [{ type: "codex-app-server" }] }],
    ["localTree block on a clone subject", {
      schema: LAB_CONFIG_SCHEMA,
      id: "clone-with-localtree",
      subject: { source: "clone", repos: ["example-org/example-app"], localTree: { keep: true } },
      actors: [{ type: "codex-app-server" }]
    }],
    ["topology: shared-world on a local-tree subject", { ...validLocalTree, subject: { ...validLocalTree.subject, topology: "shared-world" } }],
    ["localTree.exclude with an empty string entry", { ...validLocalTree, subject: { ...validLocalTree.subject, localTree: { exclude: ["ok", ""] } } }],
    ["localTree.exclude with an absolute path", { ...validLocalTree, subject: { ...validLocalTree.subject, localTree: { exclude: ["/etc/secrets"] } } }],
    ["localTree.exclude with glob syntax", { ...validLocalTree, subject: { ...validLocalTree.subject, localTree: { exclude: ["**/secrets"] } } }],
    ["localTree.keep as a quoted YAML string", { ...validLocalTree, subject: { ...validLocalTree.subject, localTree: { keep: "true" } } }],
    ["localTree.maxArchiveBytes zero", { ...validLocalTree, subject: { ...validLocalTree.subject, localTree: { maxArchiveBytes: 0 } } }],
    ["localTree.maxArchiveBytes negative", { ...validLocalTree, subject: { ...validLocalTree.subject, localTree: { maxArchiveBytes: -1 } } }]
  ])("fails closed on local-tree mis-config: %s", (_label, input) => {
    const result = parseLabConfig(input);
    expect(result.ok, _label).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HOMUN_LAB_INVALID");
  });

  it("each local-tree fail-closed reason names its requirement precisely", () => {
    const withRepos = parseLabConfig({ ...validLocalTree, subject: { ...validLocalTree.subject, repos: ["a/b"] } });
    expect(withRepos.ok).toBe(false);
    if (!withRepos.ok) expect(withRepos.error.message).toContain("subject.repos");

    const withClone = parseLabConfig({ ...validLocalTree, subject: { ...validLocalTree.subject, clone: { depth: 1 } } });
    expect(withClone.ok).toBe(false);
    if (!withClone.ok) expect(withClone.error.message).toContain("subject.clone");

    const noServe = parseLabConfig({ ...validLocalTree, subject: { source: "local-tree" } });
    expect(noServe.ok).toBe(false);
    if (!noServe.ok) expect(noServe.error.message).toContain("subject.serve");

    const noTarget = parseLabConfig({ ...validLocalTree, execution: undefined });
    expect(noTarget.ok).toBe(false);
    if (!noTarget.ok) expect(noTarget.error.message).toContain("execution.target: e2b-desktop");

    const badActor = parseLabConfig({ ...validLocalTree, actors: [{ type: "codex-app-server" }] });
    expect(badActor.ok).toBe(false);
    if (!badActor.ok) expect(badActor.error.message).toContain("computer-use actor");

    const localTreeOnClone = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "clone-with-localtree",
      subject: { source: "clone", repos: ["example-org/example-app"], localTree: { keep: true } },
      actors: [{ type: "codex-app-server" }]
    });
    expect(localTreeOnClone.ok).toBe(false);
    if (!localTreeOnClone.ok) expect(localTreeOnClone.error.message).toContain("subject.localTree");

    // The existing requires-clone shared-world reason must stay TRUTHFUL for local-tree too: it
    // still names clone as the requirement, never local-tree (shared-world + local-tree is an
    // explicit follow-up non-goal, not a supported combination).
    const sharedWorldOnLocalTree = parseLabConfig({ ...validLocalTree, subject: { ...validLocalTree.subject, topology: "shared-world" } });
    expect(sharedWorldOnLocalTree.ok).toBe(false);
    if (!sharedWorldOnLocalTree.ok) {
      expect(sharedWorldOnLocalTree.error.message).toContain("`subject.source: clone`");
    }

    const badExclude = parseLabConfig({ ...validLocalTree, subject: { ...validLocalTree.subject, localTree: { exclude: [""] } } });
    expect(badExclude.ok).toBe(false);
    if (!badExclude.ok) expect(badExclude.error.message).toContain("subject.localTree.exclude");

    const badMax = parseLabConfig({ ...validLocalTree, subject: { ...validLocalTree.subject, localTree: { maxArchiveBytes: 0 } } });
    expect(badMax.ok).toBe(false);
    if (!badMax.ok) expect(badMax.error.message).toContain("subject.localTree.maxArchiveBytes");
  });

  it("serve/env/state are shared with the clone route (same parsing + semantic validation)", () => {
    const result = parseLabConfig({
      ...validLocalTree,
      subject: {
        ...validLocalTree.subject,
        env: ["DATABASE_URL"],
        state: { seed: [{ name: "fixtures", command: "pnpm prisma db seed" }] }
      }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.subject.env).toEqual(["DATABASE_URL"]);
    expect(result.config.subject.state?.seed).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it("still fails closed on a malformed state block (semantic validation is shared with clone)", () => {
    const result = parseLabConfig({
      ...validLocalTree,
      subject: { ...validLocalTree.subject, state: { external: ["REDIS_URL"] } }
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("subject.env");
  });
});
