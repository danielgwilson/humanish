// A terminal study's sandbox gets an inert CODEX_API_KEY placeholder so Codex starts while the real
// key stays in the host-side egress proxy. doctor, run by the participant in that sandbox, must not
// report the placeholder as a key it can use.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { doctor } from "../../src/cli/doctor.js";
import { probeKeySources } from "../../src/keys/key-resolution.js";
import { OPENAI_EGRESS_PLACEHOLDER } from "../../src/routes/terminal/runtime-auth.js";

const noAgents = { which: async () => undefined };

describe("doctor in a terminal study's sandbox", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-doctor-placeholder-"));
    await writeFile(path.join(cwd, ".gitignore"), ".humanish/\n");
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const sandboxEnv = (): NodeJS.ProcessEnv => ({
    HUMANISH_STRICT_KEYS: "1",
    PATH: "",
    CODEX_API_KEY: OPENAI_EGRESS_PLACEHOLDER,
    XDG_CONFIG_HOME: path.join(cwd, "user-config"),
  });

  it("names the placeholder and reports no usable CODEX_API_KEY", async () => {
    const result = await doctor(cwd, { env: sandboxEnv(), localAgents: noAgents });
    const row = result.checks.find((check) => check.name === "key CODEX_API_KEY");
    expect(row?.message).not.toContain("supplied by");
    expect(row?.message).toContain("placeholder");
    expect(row?.status).toBe("note");
  });

  it("does not count the placeholder as a key, and lets a real source supply one", async () => {
    const env = sandboxEnv();
    const [placeholder] = await probeKeySources(["CODEX_API_KEY"], { cwd, env });
    expect(placeholder).toMatchObject({ source: null, placeholder: true });

    await mkdir(path.join(cwd, ".humanish", "local"), { recursive: true });
    await writeFile(
      path.join(cwd, ".humanish", "local", "provider.env"),
      "CODEX_API_KEY=synthetic-from-overlay\n",
    );
    delete env.HUMANISH_STRICT_KEYS;
    const [overlay] = await probeKeySources(["CODEX_API_KEY"], {
      cwd,
      env,
      deps: { homeDir: cwd, execText: async () => null },
    });
    expect(overlay?.source).toBe(path.join(".humanish", "local", "provider.env"));
    expect(overlay?.placeholder).toBeUndefined();
    expect(env.CODEX_API_KEY).toBe(OPENAI_EGRESS_PLACEHOLDER);
  });
});
