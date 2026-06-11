import { describe, expect, it } from "vitest";

import { LAB_CONFIG_SCHEMA, parseLabConfig } from "../src/lab-config.js";

describe("parseLabConfig (mimetic.lab.v2)", () => {
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
    ["wrong schema", { schema: "mimetic.lab.v1", id: "x", subject: { source: "this-repo" }, actors: [{ type: "a" }] }],
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
    expect(result.error.code).toBe("MIMETIC_LAB_INVALID");
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

    it("still warns about genuinely inert fields on the cua route (e.g. execution.concurrency)", () => {
      const result = parseLabConfig({ ...validCua, execution: { ...validCua.execution, concurrency: 2 } });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.warnings[0]).toContain("execution.concurrency");
      expect(result.warnings[0]).not.toContain("timeoutMs");
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
      ["registered but not computer-use", { ...validCua, actors: [{ type: "codex-app-server" }] }],
      ["fan-out count", { ...validCua, actors: [{ type: "openai-computer-use", count: 2 }] }]
    ])("fails closed on cua mis-config: %s", (_label, input) => {
      const result = parseLabConfig(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("MIMETIC_LAB_INVALID");
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
        actors: [{ type: "mimetic-setup" }],
        execution: { desktop: { device: "mobile" } }
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.warnings[0]).toContain("execution.desktop.device");
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
      ["scripted actor on a clone subject", { ...validScripted, subject: { source: "clone", repos: ["example-org/example-app"] } }],
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
      expect(result.error.code).toBe("MIMETIC_LAB_INVALID");
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

    it("warns clone.fanout as inert on the cua route (single lane) but NOT clone.keep (honored on failure)", () => {
      const result = parseLabConfig({
        ...validCloneCua,
        subject: { ...validCloneCua.subject, clone: { depth: 1, keep: true, fanout: 1 } }
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.warnings[0]).toContain("subject.clone.fanout");
      // clone.keep IS consumed (honored on failure) — must NOT be warned inert, or the parser
      // contradicts the engine.
      expect(result.warnings[0]).not.toContain("subject.clone.keep");
      expect(result.warnings[0]).not.toContain("subject.clone.depth");
    });

    it("warns serve/env/depth as inert on clone routes that do NOT serve (smoke/meta)", () => {
      const smoke = parseLabConfig({
        ...validCloneCua,
        actors: [{ type: "mimetic-setup" }],
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
      ["fan-out count", { ...validCloneCua, actors: [{ type: "openai-computer-use", count: 2 }] }]
    ])("fails closed on clone+serve mis-config: %s", (_label, input) => {
      const result = parseLabConfig(input);
      expect(result.ok, _label).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("MIMETIC_LAB_INVALID");
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
      expect(result.error.code).toBe("MIMETIC_LAB_INVALID");
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
        actors: [{ type: "mimetic-setup" }],
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
