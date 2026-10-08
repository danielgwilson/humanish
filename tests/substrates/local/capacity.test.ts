import { describe, expect, it } from "vitest";
import { limaCapacity, limaVmSize, localCapacity } from "../../../src/substrates/local/capacity.js";

const GiB = 1024 ** 3;

describe("local desktop capacity", () => {
  it("holds two desktops in an 8 GiB, 6 CPU Lima VM", () => {
    expect(localCapacity("lima-vm", { memoryBytes: 8 * GiB, cpus: 6 }).desktops).toBe(2);
  });
  it("holds four desktops in a 13 GiB, 8 CPU Lima VM", () => {
    expect(localCapacity("lima-vm", { memoryBytes: 13 * GiB, cpus: 8 }).desktops).toBe(4);
  });
  it("counts memory only, and notes when desktops will share CPUs", () => {
    // A CPU quota throttles a desktop; running out of memory kills it.
    const capacity = localCapacity("linux-host", { memoryBytes: 31 * GiB, cpus: 4 });
    expect(capacity.desktops).toBe(10);
    expect(capacity.sharesCpus).toBe(true);
    expect(
      localCapacity("linux-host", { memoryBytes: 7 * GiB, cpus: 8 }).sharesCpus,
    ).toBeUndefined();
  });
  it("holds no desktop when the memory left after the host's own share is under one desktop", () => {
    expect(localCapacity("lima-vm", { memoryBytes: 3.5 * GiB, cpus: 4 }).desktops).toBe(0);
  });
});

describe("Lima VM size", () => {
  const noVm = { exists: false };
  it("sizes a VM that does not exist yet for four desktops on a large Mac", () => {
    expect(limaVmSize(noVm, { memoryBytes: 64 * GiB, cpus: 16 })).toEqual({
      memoryGiB: 13,
      cpus: 8,
    });
  });
  it("caps a VM that does not exist yet at half the Mac's memory and CPUs", () => {
    expect(limaVmSize(noVm, { memoryBytes: 16 * GiB, cpus: 8 })).toEqual({ memoryGiB: 8, cpus: 4 });
    expect(limaVmSize(noVm, { memoryBytes: 36 * GiB, cpus: 11 })).toEqual({
      memoryGiB: 13,
      cpus: 5,
    });
  });
  it("reads an existing VM's size from what Lima lists, whatever the Mac's size", () => {
    const listed = { exists: true, size: { memoryBytes: 6.5 * GiB, cpus: 6 } };
    expect(limaVmSize(listed, { memoryBytes: 64 * GiB, cpus: 16 })).toEqual({
      memoryGiB: 6.5,
      cpus: 6,
    });
  });
  it("has no size for an existing VM that lists none, where a default would be a guess", () => {
    expect(limaVmSize({ exists: true }, { memoryBytes: 64 * GiB, cpus: 16 })).toBeUndefined();
    expect(limaCapacity({ exists: true }, { memoryBytes: 64 * GiB, cpus: 16 })).toBeUndefined();
  });
  it("counts the desktops of the VM setup would create, and says it is planned", () => {
    expect(limaCapacity(noVm, { memoryBytes: 16 * GiB, cpus: 8 })).toEqual({
      host: "lima-vm",
      memoryGiB: 8,
      cpus: 4,
      reservedMemoryGiB: 1,
      perDesktop: { memoryGiB: 3, cpus: 2 },
      desktops: 2,
      planned: true,
      machine: { memoryGiB: 16, cpus: 8 },
    });
  });
});
