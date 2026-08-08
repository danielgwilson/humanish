// #371: the clone/local-tree route must provide the runtime a serve pipeline needs.
//
// The stock E2B desktop template ships python3 and curl but no Node, so `serve.install: pnpm
// install` died with exit 127 AFTER a sandbox had been created and paid for — and said only
// "subject install failed". These pin the detection, because being wrong in the strict direction
// costs a paid sandbox and a cryptic exit code.
import { describe, expect, it } from "vitest";

import {
  BOOTSTRAP_NODE_MAJOR,
  corepackCommandFor,
  needsNodeRuntime,
  nodeBootstrapCommand
} from "../src/subject-runtime.js";

describe("needsNodeRuntime", () => {
  it("detects the package managers and runtimes a Node app's pipeline actually uses", () => {
    expect(needsNodeRuntime(["npm ci"])).toBe(true);
    expect(needsNodeRuntime(["pnpm install --frozen-lockfile"])).toBe(true);
    expect(needsNodeRuntime(["yarn install"])).toBe(true);
    expect(needsNodeRuntime([undefined, "npm run build", undefined])).toBe(true);
    expect(needsNodeRuntime([undefined, undefined, "npx vite preview --port 3000"])).toBe(true);
    // Compound commands are the common real shape.
    expect(needsNodeRuntime(["apt-get install -y git && npm ci"])).toBe(true);
    expect(needsNodeRuntime(["cd app; pnpm i"])).toBe(true);
  });

  it("does not fire on a pipeline that needs no Node at all", () => {
    expect(needsNodeRuntime(["pip install -r requirements.txt", "python3 -m build", "python3 app.py"])).toBe(false);
    expect(needsNodeRuntime(["bundle install", "rails server"])).toBe(false);
    expect(needsNodeRuntime([undefined, undefined, undefined])).toBe(false);
    expect(needsNodeRuntime([])).toBe(false);
  });

  it("matches whole command words, not substrings", () => {
    // A binary that merely contains a runtime's name is not that runtime.
    expect(needsNodeRuntime(["./my-npm-wrapper.sh"])).toBe(false);
    expect(needsNodeRuntime(["/opt/nodelike/bin/start"])).toBe(false);
    expect(needsNodeRuntime(["echo nodes"])).toBe(false);
  });
});

describe("nodeBootstrapCommand", () => {
  it("probes before installing, so a template that already ships Node pays nothing", () => {
    const command = nodeBootstrapCommand();
    expect(command).toContain("command -v node");
    expect(command).toContain("skipping bootstrap");
    expect(command).toContain(`setup_${BOOTSTRAP_NODE_MAJOR}.x`);
  });

  it("never waits on a password prompt nobody can answer", () => {
    // The desktop user has passwordless sudo; failing fast beats hanging until the step times out.
    expect(nodeBootstrapCommand()).toContain("sudo -n");
    expect(nodeBootstrapCommand()).not.toMatch(/sudo\s+(?!-n)/);
  });
});

describe("corepackCommandFor", () => {
  it("installs only the package manager the pipeline actually asked for", () => {
    expect(corepackCommandFor(["pnpm install"])).toContain("pnpm");
    expect(corepackCommandFor(["yarn install"])).toContain("yarn");
  });

  it("is unnecessary for npm and npx, which arrive with Node", () => {
    expect(corepackCommandFor(["npm ci", "npm run build"])).toBeUndefined();
    expect(corepackCommandFor(["npx vite preview"])).toBeUndefined();
    expect(corepackCommandFor([])).toBeUndefined();
  });

  it("probes first and falls back when corepack is unavailable", () => {
    const command = corepackCommandFor(["pnpm i"]) ?? "";
    expect(command).toContain("command -v pnpm");
    expect(command).toContain("npm install -g pnpm"); // the fallback when corepack is not there
  });
});
