import { describe, expect, it } from "vitest";
import {
  PREEXISTING_CODEX_CLI_ADMISSIONS,
  QUALIFIED_CODEX_CLI_VERSIONS,
  admittedCodexCliVersions,
  classifyCodexInstallation,
  codexHost,
  codexInstallAdvice,
  codexVersionRecovery,
  defaultCodexCliVersion,
  describeQualifiedCodexCliVersions,
  parseCodexCliVersion,
  qualifiedCodexCliVersions,
} from "../../../src/actors/codex/qualified-versions.js";
import { RECORDED_CODEX_CLI_VERSIONS } from "../../../src/actors/contract.js";

const numeric = (version: string): number[] => version.split(".").map(Number);
const ascending = (a: string, b: string): number => {
  const [x, y] = [numeric(a), numeric(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
};
const lists = { ...QUALIFIED_CODEX_CLI_VERSIONS, ...PREEXISTING_CODEX_CLI_ADMISSIONS };

describe("per-host Codex CLI admission", () => {
  it("launches only releases that saved bundles can read, listed oldest first", () => {
    for (const [host, versions] of Object.entries(lists)) {
      expect(new Set(versions).size, host).toBe(versions.length);
      expect([...versions].sort(ascending), host).toEqual([...versions]);
      for (const version of versions)
        expect(RECORDED_CODEX_CLI_VERSIONS as readonly string[], `${host} ${version}`).toContain(
          version,
        );
    }
  });

  it("keeps 0.154.0 wherever it was admitted before per-host lists", () => {
    for (const [host, versions] of Object.entries(lists))
      expect(versions as readonly string[], host).toContain("0.154.0");
  });

  it("keeps the pre-existing admission apart from qualification", () => {
    expect(Object.keys(QUALIFIED_CODEX_CLI_VERSIONS)).toEqual(["linux-x64", "darwin-arm64"]);
    expect(qualifiedCodexCliVersions("linux", "arm64")).toEqual([]);
    expect(admittedCodexCliVersions("linux", "arm64")).toEqual(["0.154.0"]);
    expect(admittedCodexCliVersions("darwin", "x64")).toEqual(["0.154.0"]);
    expect(describeQualifiedCodexCliVersions("linux", "arm64")).toBe(
      "Linux arm64 accepts Codex CLI 0.154.0 (pre-existing admission, not qualified)",
    );
  });

  it("resolves hosts, defaults and refusal text from the tables", () => {
    expect(codexHost("linux", "x64")).toBe("linux-x64");
    expect(codexHost("win32", "x64")).toBeUndefined();
    expect(admittedCodexCliVersions("win32", "x64")).toEqual([]);
    expect(defaultCodexCliVersion("darwin", "arm64")).toBe("0.154.0");
    expect(defaultCodexCliVersion("linux", "x64")).toBe(
      QUALIFIED_CODEX_CLI_VERSIONS["linux-x64"].at(-1),
    );
    expect(describeQualifiedCodexCliVersions("darwin", "arm64")).toBe(
      "macOS arm64 accepts Codex CLI 0.154.0",
    );
    expect(describeQualifiedCodexCliVersions("win32", "x64")).toContain("Linux x64: 0.154.0");
  });

  it("reads only the exact `codex-cli <version>` shape", () => {
    expect(parseCodexCliVersion("codex-cli 0.157.1\n")).toBe("0.157.1");
    for (const text of ["codex-cli 0.157.1 extra", "codex 0.157.1", "codex-cli ", "0.157.1", ""])
      expect(parseCodexCliVersion(text), text).toBeUndefined();
  });

  it("names the found release, the host's admitted releases and a pinned install command", () => {
    for (const [platform, arch] of [
      ["linux", "x64"],
      ["darwin", "arm64"],
      ["linux", "arm64"],
    ] as const) {
      const recovery = codexVersionRecovery("0.150.0", undefined, platform, arch);
      expect(recovery).toContain("Found Codex CLI 0.150.0");
      for (const version of admittedCodexCliVersions(platform, arch))
        expect(recovery).toContain(version);
      expect(recovery).toContain(
        `npm install -g @openai/codex@${admittedCodexCliVersions(platform, arch).at(-1)}`,
      );
    }
    expect(codexVersionRecovery(undefined, undefined, "linux", "x64")).toContain(
      "did not report a recognizable version",
    );
  });
});

describe("the command that replaces the Codex CLI humanish found", () => {
  const latest = defaultCodexCliVersion("linux", "x64");
  const projectCodex = {
    path: "/work/app/node_modules/.bin/codex",
    resolved: "/work/app/node_modules/@openai/codex/bin/codex.js",
  };
  const globalCodex = {
    path: "/usr/local/bin/codex",
    resolved: "/usr/local/lib/node_modules/@openai/codex/bin/codex.js",
  };

  it("classifies a project's, npm's global and any other codex by the file it resolves to", () => {
    expect(classifyCodexInstallation(projectCodex, "/usr/local")).toEqual({
      kind: "project",
      path: projectCodex.path,
      project: "/work/app",
    });
    expect(classifyCodexInstallation(globalCodex, "/usr/local")).toEqual({
      kind: "global",
      path: globalCodex.path,
    });
    // A .bin/codex that resolves outside the project's @openai/codex is not its npm install.
    const linked = { path: projectCodex.path, resolved: "/opt/codex/bin/codex" };
    expect(classifyCodexInstallation(linked, "/usr/local").kind).toBe("other");
    // Without npm's prefix, nothing is known to be its global install.
    expect(classifyCodexInstallation(globalCodex, undefined).kind).toBe("other");
  });

  it("gives each a sentence with the command that replaces that binary", () => {
    expect(codexInstallAdvice(undefined, "linux", "x64")).toBe(
      `Install the newest with \`npm install -g @openai/codex@${latest}\`.`,
    );
    expect(
      codexInstallAdvice(classifyCodexInstallation(globalCodex, "/usr/local"), "linux", "x64"),
    ).toBe(`Replace it with \`npm install -g @openai/codex@${latest}\`.`);
    expect(
      codexInstallAdvice(classifyCodexInstallation(projectCodex, undefined), "linux", "x64"),
    ).toBe(
      `It is installed in this project: run \`npm install -D @openai/codex@${latest}\` in \`/work/app\`, or \`npm uninstall @openai/codex\` there to use the global Codex.`,
    );
    expect(
      codexInstallAdvice({ kind: "other", path: "/opt/homebrew/bin/codex" }, "linux", "x64"),
    ).toBe(`Update it with the tool that installed it, or put Codex ${latest} first on PATH.`);
  });
});
