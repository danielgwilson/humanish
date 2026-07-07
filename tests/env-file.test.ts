import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadEnvFile } from "../src/env-file.js";

describe("env-file loader", () => {
  it("loads env var names without exposing values or overriding existing env", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "homun-env-file-"));
    const envPath = path.join(cwd, ".homun", "local", ".env");
    const env: NodeJS.ProcessEnv = {
      OPENAI_API_KEY: "existing-value"
    };
    await mkdir(path.dirname(envPath), { recursive: true });
    await writeFile(envPath, [
      "# local only",
      "OPENAI_API_KEY=should-not-override",
      "E2B_API_KEY='loaded-e2b-value'",
      "export HOMUN_OSS_META_ACTOR_FIRST=1",
      "HOMUN_QUOTED=\"two words\""
    ].join("\n"), "utf8");

    const result = await loadEnvFile(cwd, ".homun/local/.env", env);

    expect(result.ok).toBe(true);
    expect(result.loaded).toEqual([
      "E2B_API_KEY",
      "HOMUN_OSS_META_ACTOR_FIRST",
      "HOMUN_QUOTED"
    ]);
    expect(result.skipped).toEqual(["OPENAI_API_KEY"]);
    expect(JSON.stringify(result)).not.toContain("loaded-e2b-value");
    expect(env.OPENAI_API_KEY).toBe("existing-value");
    expect(env.E2B_API_KEY).toBe("loaded-e2b-value");
    expect(env.HOMUN_QUOTED).toBe("two words");
  });

  it("fails closed for invalid env assignments", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "homun-env-file-invalid-"));
    const envPath = path.join(cwd, ".env.local");
    await writeFile(envPath, "1_BAD=value\n", "utf8");

    const result = await loadEnvFile(cwd, ".env.local", {});

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HOMUN_ENV_FILE_INVALID");
  });
});
