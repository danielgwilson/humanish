import { describe, expect, it } from "vitest";
import { defaultVmSize, localCapacity } from "../../../src/substrates/local/capacity.js";

const GiB = 1024 ** 3;

describe("local desktop capacity", () => {
  it("holds two desktops in an 8 GiB, 6 CPU Lima VM", () => {
    expect(localCapacity("lima-vm", { memoryBytes: 8 * GiB, cpus: 6 }).desktops).toBe(2);
  });
  it("holds four desktops in a 13 GiB, 8 CPU Lima VM", () => {
    expect(localCapacity("lima-vm", { memoryBytes: 13 * GiB, cpus: 8 }).desktops).toBe(4);
  });
  it("counts CPUs as well as memory on a Linux host", () => {
    expect(localCapacity("linux-host", { memoryBytes: 31 * GiB, cpus: 4 }).desktops).toBe(2);
  });
  it("holds no desktop when the memory left after the host's own share is under one desktop", () => {
    expect(localCapacity("lima-vm", { memoryBytes: 3.5 * GiB, cpus: 4 }).desktops).toBe(0);
  });
});

describe("default Lima VM size", () => {
  it("sizes a new VM for four desktops on a large Mac", () => {
    expect(defaultVmSize({ memoryBytes: 64 * GiB, cpus: 16 })).toEqual({ memoryGiB: 13, cpus: 8 });
  });
  it("caps a new VM at half the Mac's memory and CPUs", () => {
    expect(defaultVmSize({ memoryBytes: 16 * GiB, cpus: 8 })).toEqual({ memoryGiB: 8, cpus: 4 });
    expect(defaultVmSize({ memoryBytes: 36 * GiB, cpus: 11 })).toEqual({ memoryGiB: 13, cpus: 5 });
  });
});
