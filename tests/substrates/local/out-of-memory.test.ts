import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ events: "", fails: false, calls: [] as string[][] }));
vi.mock("../../../src/substrates/local/runtime-host.js", () => ({
  usesLima: () => false,
  runtimeExec: async () => ({ stdout: "" }),
  runtimeDocker: async (args: string[]) => {
    state.calls.push(args);
    if (state.fails) throw new Error("Docker unavailable");
    return { stdout: state.events, stderr: "" };
  },
}));

import { desktopKilledForMemory } from "../../../src/substrates/local/firecracker-desktop.js";

const container = "e".repeat(12);

describe("a local desktop killed for memory", () => {
  beforeEach(() => Object.assign(state, { events: "", fails: false, calls: [] }));

  it("reads Docker's oom event for the container, which outlives the removed container", async () => {
    state.events = "oom\n";
    expect(await desktopKilledForMemory(container, Date.now() - 90_000)).toBe(true);
    const [args] = state.calls;
    expect(args).toEqual(expect.arrayContaining([`container=${container}`, "event=oom"]));
    expect(args?.[0]).toBe("events");
  });
  it("reports no kill when Docker recorded none", async () => {
    expect(await desktopKilledForMemory(container, Date.now())).toBe(false);
  });
  it("reports unknown when Docker cannot be asked", async () => {
    state.fails = true;
    expect(await desktopKilledForMemory(container, Date.now())).toBeUndefined();
  });
});
