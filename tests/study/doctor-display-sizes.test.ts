import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { studySetupChecks } from "../../src/study/doctor.js";

const keyless = { HUMANISH_STRICT_KEYS: "1", PATH: "" };

/** A local Codex study, with a device per participant when `devices` is set. */
const localStudy = (devices: string[] | undefined) =>
  [
    "schema: humanish.study.v3",
    "id: preview",
    "route: computer-use",
    "mode: live",
    "subject:",
    "  source: app-url",
    "  appUrl: http://localhost:3000/",
    "actor:",
    "  type: local-agent",
    "  localAgent: codex",
    "execution:",
    "  target: local",
    ...(devices === undefined
      ? ["participants: 2"]
      : ["participants:", ...devices.map((device, i) => `  - { id: p-0${i}, device: ${device} }`)]),
    "review:",
    "  analysis: false",
  ].join("\n");

async function runtimeRow(devices: string[] | undefined, displaySizes: boolean) {
  const cwd = await mkdtemp(path.join(tmpdir(), "humanish-doctor-display-"));
  try {
    await mkdir(path.join(cwd, "humanish/studies"), { recursive: true });
    await writeFile(path.join(cwd, "humanish/studies/preview.yaml"), localStudy(devices));
    const result = await studySetupChecks({
      cwd,
      study: "preview",
      env: keyless,
      agents: [],
      keyPresent: () => false,
      localRuntimeReadiness: async () => ({
        ok: true,
        installed: true,
        message: "Ready",
        assets: {
          image: "sha256:synthetic",
          runtimeRevision: "guest-api1-synthetic",
          ...(displaySizes ? { displaySizes: true } : {}),
        },
      }),
      codexAnalysisReadiness: async () => ({ ready: true, errorCode: null }),
    });
    return result.checks.find((item) => item.name === "local browser runtime");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("doctor's local runtime row for participant screens", () => {
  it("fails a study with device sizes on a runtime that starts every participant at 960×720", async () => {
    expect(await runtimeRow(["mobile", "desktop"], false)).toEqual({
      name: "local browser runtime",
      ok: false,
      message:
        "The installed local runtime starts every participant at 960×720, and this study sets other screen sizes. Omit device and resolution, use a hosted desktop, or set HUMANISH_LOCAL_RUNTIME_IMAGE to a runtime built from current source.",
    });
  });
  it("passes the same study on a runtime that sizes screens, and a default study on either", async () => {
    expect(await runtimeRow(["mobile", "desktop"], true)).toMatchObject({ ok: true });
    expect(await runtimeRow(undefined, false)).toMatchObject({ ok: true });
  });
});
