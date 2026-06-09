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

  it("accepts a free-form actor.type today (it is NOT yet resolved against the registry)", () => {
    // HONEST CONTRACT: actor.type is a free-form label; routing ignores it. A type that is not a
    // registered actor still parses and runs. Registry resolution is a later slice; this test
    // pins the current truth rather than implying validation that does not exist.
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
    ["bad subject source", { schema: LAB_CONFIG_SCHEMA, id: "x", subject: { source: "app-url" }, actors: [{ type: "a" }] }],
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
});
