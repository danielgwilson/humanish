// doctor --study reports the Modal token pair for a study whose sandboxes run on Modal, and fails
// when a token is missing; a study on E2B is not asked for them.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { doctor } from "../../src/cli/doctor.js";

const desktopStudy = (target: string) => ({
  schema: "humanish.study.v3",
  id: "hosted",
  route: "computer-use",
  mode: "live",
  subject: { source: "app-url", appUrl: "https://preview.example.test/" },
  actor: { type: "computer-use" },
  execution: { target },
  policies: { allowPublicTargets: true },
  review: { analysis: false },
});

const terminalStudy = {
  schema: "humanish.study.v3",
  id: "hosted",
  route: "terminal",
  mode: "live",
  subject: {
    source: "terminal-product",
    product: { name: "example-cli", publicSurfaces: ["https://example.test"] },
  },
  actor: { type: "codex-exec", mission: "Use the CLI." },
  caps: { maxUsd: 0, maxMinutes: 5 },
  execution: {
    target: "modal-terminal",
    runtimeAuth: "openai-env",
    terminal: { transport: "exec-stream", stdin: "disabled" },
  },
  review: { analysis: false },
};

let cwd: string;
beforeAll(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-doctor-modal-"));
  await mkdir(path.join(cwd, "humanish/studies"), { recursive: true });
  await writeFile(path.join(cwd, "package.json"), "{}");
});
afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function modalRows(study: unknown, env: Record<string, string>) {
  await writeFile(path.join(cwd, "humanish/studies/hosted.yaml"), stringify(study));
  const result = await doctor(cwd, {
    study: "hosted",
    env: { HUMANISH_STRICT_KEYS: "1", PATH: "", HOME: cwd, ...env },
    localAgents: { which: async () => undefined },
  });
  expect(JSON.stringify(result)).not.toMatch(/synthetic-marker/);
  return result.checks
    .filter((check) => check.name.startsWith("key MODAL_TOKEN_"))
    .map(({ name, ok, status }) => ({ name, ok, status }));
}

const modalKeys = {
  MODAL_TOKEN_ID: "synthetic-marker-id",
  MODAL_TOKEN_SECRET: "synthetic-marker-secret",
  OPENAI_API_KEY: "synthetic-marker-model",
};

describe("doctor --study for a study on a Modal desktop", () => {
  it("fails on each missing Modal token", async () => {
    const env = { OPENAI_API_KEY: "synthetic-marker-model" };
    expect(await modalRows(desktopStudy("modal-desktop"), env)).toEqual([
      { name: "key MODAL_TOKEN_ID", ok: false, status: "missing" },
      { name: "key MODAL_TOKEN_SECRET", ok: false, status: "missing" },
    ]);
  });

  it("passes with both tokens present", async () => {
    expect(await modalRows(desktopStudy("modal-desktop"), modalKeys)).toEqual([
      { name: "key MODAL_TOKEN_ID", ok: true, status: "ok" },
      { name: "key MODAL_TOKEN_SECRET", ok: true, status: "ok" },
    ]);
  });
});

describe("doctor --study for a study on a Modal terminal", () => {
  it("fails on each missing Modal token", async () => {
    const env = { OPENAI_API_KEY: "synthetic-marker-model" };
    expect(await modalRows(terminalStudy, env)).toEqual([
      { name: "key MODAL_TOKEN_ID", ok: false, status: "missing" },
      { name: "key MODAL_TOKEN_SECRET", ok: false, status: "missing" },
    ]);
  });
});

describe("doctor --study for a study on an E2B desktop", () => {
  it("shows no Modal token row", async () => {
    const env = { ...modalKeys, E2B_API_KEY: "synthetic-marker-desktop" };
    expect(await modalRows(desktopStudy("e2b-desktop"), env)).toEqual([]);
  });
});
