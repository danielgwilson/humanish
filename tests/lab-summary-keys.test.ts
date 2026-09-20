import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { LAB_CONFIG_SCHEMA } from "../src/lab-config.js";
import { readLabSummary } from "../src/lab-summary.js";

const base = {
  schema: LAB_CONFIG_SCHEMA, id: "key-check",
  subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
  actors: [{ type: "openai-computer-use", mission: "Use the app." }],
  execution: { target: "e2b-desktop" }, scenario: { mode: "live" }
};

async function summary(config: unknown, env: NodeJS.ProcessEnv) {
  const cwd = await mkdtemp(path.join(tmpdir(), "humanish-summary-keys-"));
  try {
    await mkdir(path.join(cwd, "humanish/labs"), { recursive: true });
    await writeFile(path.join(cwd, "humanish/labs/key-check.yaml"), stringify(config));
    const result = await readLabSummary(cwd, "key-check", { checkKeys: true, env: { HUMANISH_STRICT_KEYS: "1", ...env } });
    expect(result).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain("synthetic-credential");
    return result!;
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

describe("TUI key summary follows the configured route", () => {
  it("allows a keyless dry-run", async () => {
    expect(await summary({ ...base, scenario: { mode: "dry-run" } }, {})).toMatchObject({ keysReady: true });
  });

  it("requires desktop plus model for API computer use", async () => {
    expect(await summary(base, { E2B_API_KEY: "synthetic-credential-desktop" })).toMatchObject({ keysReady: false, missingKeys: ["OPENAI_API_KEY"] });
    expect(await summary(base, { E2B_API_KEY: "synthetic-credential-desktop", OPENAI_API_KEY: "synthetic-credential-model" })).toMatchObject({ keysReady: true });
  });

  it("does not block local-agent participants on the optional analysis key", async () => {
    const result = await summary({ ...base, actors: [{ type: "local-agent", localAgent: "codex", mission: "Use the app." }] }, { E2B_API_KEY: "synthetic-credential-desktop" });
    expect(result.keysReady).toBe(true);
    expect(result.missingKeys).toBeUndefined();
  });

  it("accepts terminal CODEX_API_KEY without requiring a second model key", async () => {
    const config = { ...base,
      subject: { source: "terminal-product", product: { name: "example-cli", publicSurfaces: ["https://example.test"] } },
      actors: [{ type: "codex-exec", mission: "Use the CLI." }],
      execution: { target: "e2b-terminal", runtimeAuth: "openai-env", terminal: { transport: "exec-stream", stdin: "disabled" } }
    };
    expect(await summary(config, { E2B_API_KEY: "synthetic-credential-desktop", CODEX_API_KEY: "synthetic-credential-model" })).toMatchObject({ keysReady: true });
    expect(await summary(config, { E2B_API_KEY: "synthetic-credential-desktop" })).toMatchObject({ keysReady: false, missingKeys: ["OPENAI_API_KEY"] });
  });

  it("requires no provider keys for a local scripted browser", async () => {
    expect(await summary({ ...base, actors: [{ type: "scripted-browser", mission: "Use the app." }], execution: { target: "local" },
      scenario: { mode: "live", ref: "humanish/scenarios/entry.yaml" }
    }, {})).toMatchObject({ keysReady: true });
  });
});
