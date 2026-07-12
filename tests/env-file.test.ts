import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadEnvFile } from "../src/env-file.js";

describe("env-file loader", () => {
  it("loads env var names without exposing values or overriding existing env", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-env-file-"));
    const envPath = path.join(cwd, ".humanish", "local", ".env");
    const env: NodeJS.ProcessEnv = {
      OPENAI_API_KEY: "existing-value"
    };
    await mkdir(path.dirname(envPath), { recursive: true });
    await writeFile(envPath, [
      "# local only",
      "OPENAI_API_KEY=should-not-override",
      "E2B_API_KEY='loaded-e2b-value'",
      "export HUMANISH_OSS_META_ACTOR_FIRST=1",
      "HUMANISH_QUOTED=\"two words\""
    ].join("\n"), "utf8");

    const result = await loadEnvFile(cwd, ".humanish/local/.env", env);

    expect(result.ok).toBe(true);
    expect(result.loaded).toEqual([
      "E2B_API_KEY",
      "HUMANISH_OSS_META_ACTOR_FIRST",
      "HUMANISH_QUOTED"
    ]);
    expect(result.skipped).toEqual(["OPENAI_API_KEY"]);
    expect(JSON.stringify(result)).not.toContain("loaded-e2b-value");
    expect(env.OPENAI_API_KEY).toBe("existing-value");
    expect(env.E2B_API_KEY).toBe("loaded-e2b-value");
    expect(env.HUMANISH_QUOTED).toBe("two words");
  });

  it("fails closed for invalid env assignments", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-env-file-invalid-"));
    const envPath = path.join(cwd, ".env.local");
    await writeFile(envPath, "1_BAD=value\n", "utf8");

    const result = await loadEnvFile(cwd, ".env.local", {});

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_ENV_FILE_INVALID");
  });
});
