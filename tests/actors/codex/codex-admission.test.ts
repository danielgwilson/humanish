import { describe, expect, it } from "vitest";
import {
  REFUSED_CODEX_CLI_VERSIONS,
  TESTED_CODEX_CLI_VERSIONS,
  admitsCodexCliVersion,
  classifyCodexInstallation,
  codexCliRefusal,
  codexInstallAdvice,
  codexVersionRecovery,
  defaultCodexCliVersion,
  describeCodexCliAdmission,
  parseCodexCliVersion,
  supportsIsolatedCodex,
  untestedOperatorReleaseWarning,
} from "../../../src/actors/codex/codex-admission.js";
import { isRecordedCodexCliVersion } from "../../../src/actors/contract.js";

const numeric = (version: string): number[] => version.split(".").map(Number);
const ascending = (a: string, b: string): number => {
  const [x, y] = [numeric(a), numeric(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
};

describe("Codex CLI launch admission", () => {
  it("starts every stable release from 0.154.0 and refuses prereleases, older and unrecognized ones", () => {
    for (const version of ["0.154.0", "0.155.0", "0.158.0", "0.160.0", "0.161.0", "1.0.0"])
      expect(codexCliRefusal(version), version).toBeUndefined();
    expect(codexCliRefusal("0.150.0")).toEqual({ reason: "below_floor", version: "0.150.0" });
    expect(codexCliRefusal("0.162.0-alpha.4")).toEqual({
      reason: "prerelease",
      version: "0.162.0-alpha.4",
    });
    expect(codexCliRefusal("1.0.0-alpha+build.5")).toMatchObject({ reason: "prerelease" });
    // Build metadata alone, leading zeros and anything past parseCodexCliVersion's 64 characters
    // are not plain releases; none is a prerelease or below the floor.
    for (const version of [
      undefined,
      "",
      "0.154",
      "latest",
      "v0.160.0",
      "0.161.0+build.1",
      "00.161.0",
      "0.161.00",
      `1.${"9".repeat(64)}.0`,
    ])
      expect(codexCliRefusal(version), String(version)).toEqual({ reason: "unrecognized" });
  });

  it("launches only releases that saved bundles can read", () => {
    for (const version of ["0.154.0", "0.161.0", "0.150.0", "0.162.0-alpha.4"])
      if (admitsCodexCliVersion(version)) expect(isRecordedCodexCliVersion(version)).toBe(true);
    expect(REFUSED_CODEX_CLI_VERSIONS).toEqual([]);
  });

  it("keeps the tested list ordered, recordable and the source of the default", () => {
    expect([...TESTED_CODEX_CLI_VERSIONS].sort(ascending)).toEqual([...TESTED_CODEX_CLI_VERSIONS]);
    for (const version of TESTED_CODEX_CLI_VERSIONS)
      expect(admitsCodexCliVersion(version)).toBe(true);
    expect(defaultCodexCliVersion()).toBe(TESTED_CODEX_CLI_VERSIONS.at(-1));
    expect(describeCodexCliAdmission()).toBe(
      `humanish runs stable Codex CLI releases from 0.154.0 (last tested: ${defaultCodexCliVersion()})`,
    );
  });

  it("runs isolated launches on Linux x64 and Apple Silicon only", () => {
    expect(supportsIsolatedCodex("linux", "x64")).toBe(true);
    expect(supportsIsolatedCodex("darwin", "arm64")).toBe(true);
    for (const [platform, arch] of [
      ["linux", "arm64"],
      ["darwin", "x64"],
      ["win32", "x64"],
    ] as const)
      expect(supportsIsolatedCodex(platform, arch), `${platform}-${arch}`).toBe(false);
  });

  it("warns about a hosted participant on an untested release, and nothing else", () => {
    expect(untestedOperatorReleaseWarning("0.161.0", true)).toBe(
      "Codex CLI 0.161.0 has not been tested with humanish; this hosted participant's evidence rests on the checks each launch makes.",
    );
    expect(untestedOperatorReleaseWarning(defaultCodexCliVersion(), true)).toBeUndefined();
    expect(untestedOperatorReleaseWarning("0.161.0", false)).toBeUndefined();
    expect(untestedOperatorReleaseWarning(undefined, true)).toBeUndefined();
  });

  it("reads only the exact `codex-cli <version>` shape", () => {
    expect(parseCodexCliVersion("codex-cli 0.157.1\n")).toBe("0.157.1");
    for (const text of ["codex-cli 0.157.1 extra", "codex 0.157.1", "codex-cli ", "0.157.1", ""])
      expect(parseCodexCliVersion(text), text).toBeUndefined();
  });

  it("says why the found release is refused, and the command that installs the last tested one", () => {
    const install = `npm install -g @openai/codex@${defaultCodexCliVersion()}`;
    expect(codexVersionRecovery("0.150.0")).toBe(
      `Found Codex CLI 0.150.0; it is older than 0.154.0, the oldest release humanish supports. Install the last tested release with \`${install}\`. Then sign in with a ChatGPT account (\`codex login\`).`,
    );
    expect(codexVersionRecovery("0.162.0-alpha.4")).toContain(
      "it is a prerelease, and humanish runs stable releases",
    );
    expect(codexVersionRecovery(undefined)).toContain("did not report a recognizable version");
    expect(codexVersionRecovery("0.161.0+build.1")).toContain(
      "Found Codex CLI 0.161.0+build.1; it is not a plain MAJOR.MINOR.PATCH release",
    );
    // An admitted release refused for another reason (a mismatch with the recorded identity).
    expect(codexVersionRecovery("0.160.0")).toContain(describeCodexCliAdmission());
  });
});

describe("the command that replaces the Codex CLI humanish found", () => {
  const latest = defaultCodexCliVersion();
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
    expect(codexInstallAdvice(undefined)).toBe(
      `Install the last tested release with \`npm install -g @openai/codex@${latest}\`.`,
    );
    expect(codexInstallAdvice(classifyCodexInstallation(globalCodex, "/usr/local"))).toBe(
      `Replace it with \`npm install -g @openai/codex@${latest}\`.`,
    );
    expect(codexInstallAdvice(classifyCodexInstallation(projectCodex, undefined))).toBe(
      `It is installed in this project: run \`npm install -D @openai/codex@${latest}\` in \`/work/app\`, or \`npm uninstall @openai/codex\` there to use the global Codex.`,
    );
    expect(codexInstallAdvice({ kind: "other", path: "/opt/homebrew/bin/codex" })).toBe(
      `Update it with the tool that installed it, or put Codex ${latest} first on PATH.`,
    );
  });
});
