import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { studySetupChecks } from "../../src/study/doctor.js";
import { localCapacity } from "../../src/substrates/local/capacity.js";

const keyless = { HUMANISH_STRICT_KEYS: "1", PATH: "" };
const GiB = 1024 ** 3;

/** A local Codex study of `participants` participants, all at once. */
const localStudy = (participants: number) =>
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
    `participants: ${participants}`,
    "review:",
    "  analysis: false",
  ].join("\n");

async function capacityRow(participants: number, capacity: ReturnType<typeof localCapacity>) {
  const cwd = await mkdtemp(path.join(tmpdir(), "humanish-doctor-capacity-"));
  try {
    await mkdir(path.join(cwd, "humanish/studies"), { recursive: true });
    await writeFile(path.join(cwd, "humanish/studies/preview.yaml"), localStudy(participants));
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
        capacity,
      }),
      codexAnalysisReadiness: async () => ({ ready: true, errorCode: null }),
    });
    return result.checks.find((item) => item.name === "local desktop capacity");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("doctor's local desktop capacity", () => {
  it("says how many desktops the Lima VM holds and whether the study fits", async () => {
    const vm = localCapacity("lima-vm", { memoryBytes: 8 * GiB, cpus: 6 });
    for (const [participants, fits] of [
      [2, true],
      [3, false],
    ] as const) {
      const check = await capacityRow(participants, vm);
      expect(check?.ok, `${participants} participants`).toBe(fits);
      expect(check?.message).toMatch(/8 GiB/);
      expect(check?.message).toContain("reserves 3 GiB");
      expect(check?.message).toContain(fits ? "fits" : "holds 2");
    }
  });
  it("notes a Linux host that holds fewer desktops than the study runs without failing", async () => {
    const host = localCapacity("linux-host", { memoryBytes: 7 * GiB, cpus: 8 });
    expect(await capacityRow(3, host)).toMatchObject({ ok: true, status: "note" });
  });
});
