import { describe, expect, it } from "vitest";

import {
  classifyHumanishInstall,
  desktopPeerAdvice,
  type HumanishInstall,
} from "../../../src/substrates/e2b/peer-install.js";

// Node resolves the optional @e2b/desktop peer from humanish's own directory. Each install place
// needs its own command, advice for the wrong place installs a copy Node never reads, and `npm i`
// where no manifest declares the installed packages prunes them.

const FILE = "node_modules/humanish/dist/substrates/e2b/peer-install.js";
// Directories whose package.json declares humanish, and ones with node_modules but no manifest.
const DECLARING = new Set(["/work/app", "/work/tools", "/mono/packages/web"]);
const UNMANAGED = new Set(["/opt/tools/lib"]);
const classify = (modulePath: string, cwd: string, npmGlobalRoot = "/usr/local/lib") =>
  classifyHumanishInstall(modulePath, {
    cwd,
    npmGlobalRoot,
    declaresHumanish: (directory) => DECLARING.has(directory),
    unmanaged: (directory) => UNMANAGED.has(directory),
  });

describe("where the running humanish is installed", () => {
  it.each<[string, string, string, HumanishInstall]>([
    ["this project", `/work/app/${FILE}`, "/work/app", { kind: "project", up: 0, manager: "npm" }],
    [
      "a subdirectory, or a nested package that does not declare humanish",
      `/work/app/${FILE}`,
      "/work/app/packages/site",
      { kind: "project", up: 2, manager: "npm" },
    ],
    [
      "this project, through pnpm's store",
      `/work/app/node_modules/.pnpm/humanish@0.110.0/${FILE}`,
      "/work/app",
      { kind: "project", up: 0, manager: "pnpm" },
    ],
    [
      "a pnpm workspace member that declares humanish when the root does not",
      `/mono/node_modules/.pnpm/humanish@0.110.0/${FILE}`,
      "/mono/packages/web",
      { kind: "project", up: 0, manager: "pnpm" },
    ],
    [
      "npm's npx cache",
      `/srv/u/.npm/_npx/4f1c2a/${FILE}`,
      "/work/app",
      { kind: "one-shot", unmanagedCwd: false },
    ],
    [
      "an npx cache under another node_modules",
      `/outer/node_modules/inner/.npm/_npx/4f1c2a/${FILE}`,
      "/work/app",
      { kind: "one-shot", unmanagedCwd: false },
    ],
    [
      "pnpm's dlx cache",
      `/srv/u/.cache/pnpm/dlx/9b2e/1a2b/${FILE}`,
      "/work/app",
      { kind: "one-shot", unmanagedCwd: false },
    ],
    [
      "npm's global root",
      `/usr/local/lib/${FILE}`,
      "/work/app",
      { kind: "global", manager: "npm" },
    ],
    [
      "pnpm's global directory",
      `/srv/u/.local/share/pnpm/global/5/${FILE}`,
      "/work/app",
      { kind: "global", manager: "pnpm" },
    ],
    [
      "a source checkout",
      "/src/humanish/dist/substrates/e2b/peer-install.js",
      "/work/app",
      { kind: "checkout" },
    ],
    ["another project", `/work/tools/${FILE}`, "/work/app", { kind: "other", unmanagedCwd: false }],
    [
      "a sibling whose name starts with the project's",
      `/work/app-tools/${FILE}`,
      "/work/app",
      { kind: "other", unmanagedCwd: false },
    ],
    // A global prefix set only in .npmrc, run from inside it: nothing declares what its
    // node_modules holds, so an `npm i` there would prune every global tool.
    [
      "a global prefix npm is not configured for, from inside it",
      `/opt/tools/lib/${FILE}`,
      "/opt/tools/lib",
      { kind: "other", unmanagedCwd: true },
    ],
  ])("reads %s", (_label, modulePath, cwd, expected) => {
    expect(classify(modulePath, cwd)).toEqual(expected);
  });

  it("reads a global root npm no longer installs to, after a prefix change, as other", () => {
    expect(classify(`/usr/local/lib/${FILE}`, "/work/app", "/opt/npm/lib")).toEqual({
      kind: "other",
      unmanagedCwd: false,
    });
  });
});

describe("the command that adds the peer where it resolves", () => {
  it.each<[HumanishInstall, string]>([
    [{ kind: "project", up: 0, manager: "npm" }, "npm i -D @e2b/desktop"],
    [{ kind: "project", up: 2, manager: "npm" }, "npm i -D --prefix ../.. @e2b/desktop"],
    [{ kind: "project", up: 0, manager: "pnpm" }, "pnpm add -D @e2b/desktop"],
    [{ kind: "project", up: 1, manager: "pnpm" }, "pnpm add -D --dir .. @e2b/desktop"],
    [{ kind: "one-shot", unmanagedCwd: false }, "npm i -D humanish @e2b/desktop"],
    [{ kind: "global", manager: "npm" }, "npm i -g @e2b/desktop"],
    [{ kind: "global", manager: "pnpm" }, "pnpm add -g @e2b/desktop"],
    [{ kind: "checkout" }, "pnpm install"],
    [{ kind: "other", unmanagedCwd: false }, "npm i -D humanish @e2b/desktop"],
  ])("for %j: %s", (install, command) => {
    const advice = desktopPeerAdvice(install);
    expect(advice.command).toBe(command);
    expect(advice.advice).toContain(`\`${command}\``);
  });

  it("does not tell a directory with node_modules and no package.json to install there", () => {
    for (const kind of ["one-shot", "other"] as const) {
      const { advice } = desktopPeerAdvice({ kind, unmanagedCwd: true });
      expect(advice).not.toMatch(/into this project|installed here/);
      expect(advice).toContain("In your project's directory");
    }
  });

  it("names no directory, so the advice survives path redaction and needs no shell quoting", () => {
    const kinds: HumanishInstall[] = [
      { kind: "project", up: 3, manager: "npm" },
      { kind: "one-shot", unmanagedCwd: true },
      { kind: "global", manager: "npm" },
      { kind: "checkout" },
      { kind: "other", unmanagedCwd: false },
    ];
    for (const install of kinds) {
      const { where, advice } = desktopPeerAdvice(install);
      // Parent steps (`--prefix ../..`) are the only path a command may hold.
      expect(`${where} ${advice}`.replaceAll("../", "")).not.toMatch(/\/[\w.-]+\/[\w.-]/);
    }
  });

  it("carries a version spec into the command", () => {
    expect(
      desktopPeerAdvice({ kind: "global", manager: "npm" }, "@e2b/desktop@latest").command,
    ).toBe("npm i -g @e2b/desktop@latest");
  });
});
