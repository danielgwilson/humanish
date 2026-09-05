import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildRuntimeExecPrefix, buildRuntimeVersionCommand, declaredRuntimeProvenance, isExactRuntimeVersion, parseTerminalRuntimeVersion } from "../src/terminal-runtime.js";

describe("terminal Codex runtime selection", () => {
  it("reads the captured local CLI version shape", () => {
    const captured = readFileSync(new URL("./fixtures/terminal-runtime/codex-cli-0.153.3.txt", import.meta.url), "utf8");
    expect(parseTerminalRuntimeVersion(captured)).toBe("0.153.3");
    for (const output of ["", "0.153.3", "codex-cli latest", "codex-cli 0.153.3\nextra", "codex-cli 01.2.3"]) {
      expect(parseTerminalRuntimeVersion(output)).toBeUndefined();
    }
  });

  it.each(["latest", "^0.153.3", "~0.153.3", "0.153", "v0.153.3", "https://example.com/codex.tgz", "0.153.3; echo no", "0.153.3\n", "0.153.3-01"])("refuses non-exact selector %j", (selector) => {
    expect(isExactRuntimeVersion(selector)).toBe(false);
    expect(() => buildRuntimeVersionCommand(selector)).toThrow();
  });

  it("permits exact prerelease versions and resolves latest only in the unkeyed probe", () => {
    expect(isExactRuntimeVersion("0.154.0-alpha.2+build.1")).toBe(true);
    expect(buildRuntimeVersionCommand()).toContain("@openai/codex@latest --version");
    expect(buildRuntimeExecPrefix("0.153.3")).toBe("npm_config_update_notifier=false npx -y @openai/codex@0.153.3 exec");
  });

  it("passes model and effort as literal arguments without shell evaluation", () => {
    const model = "model' $(printf INJECTED) `printf INJECTED`";
    const command = buildRuntimeExecPrefix("0.153.3", model, "low");
    const shell = `npx() { printf '%s\\n' "$@"; }; ${command}`;
    const args = execFileSync("bash", ["--noprofile", "--norc", "-c", shell], { encoding: "utf8", env: { PATH: process.env.PATH } }).trim().split("\n");
    expect(args).toEqual(["-y", "@openai/codex@0.153.3", "exec", "--model", model, "-c", 'model_reasoning_effort="low"']);
  });

  it("does not invent a model or per-request usage provenance", () => {
    expect(declaredRuntimeProvenance({})).toEqual({
      schema: "humanish.actor-runtime.v1", package: "@openai/codex", requestedVersion: "latest",
      versionStatus: "unobserved", modelStatus: "runtime_default_unobserved", usageGranularity: "runtime_turn"
    });
  });
});
