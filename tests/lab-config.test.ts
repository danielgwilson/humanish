import { describe, expect, it } from "vitest";

import { LAB_CONFIG_SCHEMA, parseLabConfig } from "../src/lab-config.js";

describe("parseLabConfig (mimetic.lab.v2)", () => {
  it("parses an oss-meta-shaped lab (clone + e2b-desktop + codex actor + mission + review)", () => {
    const result = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "oss",
      title: "OSS meta-lab",
      subject: { source: "clone", repos: ["CorentinTh/it-tools"], clone: { depth: 1, fanout: 4 } },
      actors: [
        {
          type: "codex-app-server",
          count: 1,
          persona: "skeptical-power-user",
          mission: "clone, set up Mimetic, run nested Observer",
          laneFocus: { id: "code", label: "Nested setup", instruction: "do the setup" }
        }
      ],
      execution: { target: "e2b-desktop", desktop: { resolution: [1440, 960], codexAppServer: true } },
      review: { scoring: "oss-meta-meaningful-use" }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.subject).toEqual({ source: "clone", repos: ["CorentinTh/it-tools"], clone: { depth: 1, fanout: 4 } });
    expect(result.config.actors[0]?.type).toBe("codex-app-server");
    expect(result.config.actors[0]?.mission).toContain("set up Mimetic");
    expect(result.config.execution?.target).toBe("e2b-desktop");
    expect(result.config.execution?.desktop?.resolution).toEqual([1440, 960]);
    expect(result.config.review?.scoring).toBe("oss-meta-meaningful-use");
  });

  it("parses a synthetic-shaped lab (this-repo + browser-persona, dry-run)", () => {
    const result = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "first-run",
      subject: { source: "this-repo" },
      actors: [{ type: "browser-persona", count: 4 }],
      scenario: { ref: "first-run-smoke", mode: "dry-run" },
      defaults: { open: true }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.subject.source).toBe("this-repo");
    expect(result.config.actors[0]).toEqual({ type: "browser-persona", count: 4 });
    expect(result.config.scenario).toEqual({ ref: "first-run-smoke", mode: "dry-run" });
    expect(result.config.defaults).toEqual({ open: true });
  });

  it("parses an app-url subject with an approval allowlist policy", () => {
    const result = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "migration",
      subject: { source: "app-url", url: "http://127.0.0.1:3000" },
      actors: [{ type: "computer-use", persona: "synthetic-new-user" }],
      policies: { redactRepos: true, noPush: true, approval: { mode: "pre-grant-allowlist", allow: ["pnpm install"] } }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.subject.url).toBe("http://127.0.0.1:3000");
    expect(result.config.policies?.approval).toEqual({ mode: "pre-grant-allowlist", allow: ["pnpm install"] });
    expect(result.config.policies?.noPush).toBe(true);
  });

  it("does not enumerate actor types — unknown types parse (resolved at dispatch, not here)", () => {
    const result = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "future",
      subject: { source: "this-repo" },
      actors: [{ type: "some-future-actor-not-yet-registered" }]
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    ["wrong schema", { schema: "mimetic.lab.v1", id: "x", subject: { source: "this-repo" }, actors: [{ type: "a" }] }],
    ["missing id", { schema: LAB_CONFIG_SCHEMA, subject: { source: "this-repo" }, actors: [{ type: "a" }] }],
    ["bad id", { schema: LAB_CONFIG_SCHEMA, id: "has space", subject: { source: "this-repo" }, actors: [{ type: "a" }] }],
    ["no subject", { schema: LAB_CONFIG_SCHEMA, id: "x", actors: [{ type: "a" }] }],
    ["bad subject source", { schema: LAB_CONFIG_SCHEMA, id: "x", subject: { source: "nope" }, actors: [{ type: "a" }] }],
    ["clone without repos", { schema: LAB_CONFIG_SCHEMA, id: "x", subject: { source: "clone" }, actors: [{ type: "a" }] }],
    ["app-url without url", { schema: LAB_CONFIG_SCHEMA, id: "x", subject: { source: "app-url" }, actors: [{ type: "a" }] }],
    ["empty actors", { schema: LAB_CONFIG_SCHEMA, id: "x", subject: { source: "this-repo" }, actors: [] }],
    ["actor without type", { schema: LAB_CONFIG_SCHEMA, id: "x", subject: { source: "this-repo" }, actors: [{ count: 1 }] }],
    ["bad execution target", { schema: LAB_CONFIG_SCHEMA, id: "x", subject: { source: "this-repo" }, actors: [{ type: "a" }], execution: { target: "vm" } }]
  ])("rejects invalid config: %s", (_label, input) => {
    const result = parseLabConfig(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MIMETIC_LAB_INVALID");
  });
});
