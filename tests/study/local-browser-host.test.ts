import { describe, expect, it } from "vitest";

import {
  probeLocalBrowserHost,
  type LocalBrowserHostProbe,
} from "../../src/study/local-browser-host.js";

function probe(overrides: Partial<LocalBrowserHostProbe>): LocalBrowserHostProbe {
  return {
    platform: "linux",
    arch: "x64",
    env: { PATH: "/usr/bin" },
    access: async () => {},
    macChip: async () => "",
    ...overrides,
  };
}

describe("init's quick read of a host for a local browser study", () => {
  it("passes a Linux x64 host with KVM, a tun device and Docker on the search path", async () => {
    expect(await probeLocalBrowserHost(probe({}))).toEqual({ ok: true });
  });

  it("fails a Linux x64 host without KVM, or without Docker on the search path", async () => {
    const noKvm = probe({
      access: async (file) => {
        if (file === "/dev/kvm") throw new Error("ENOENT");
      },
    });
    expect(await probeLocalBrowserHost(noKvm)).toMatchObject({ ok: false });
    const noDocker = probe({
      access: async (file) => {
        if (file.endsWith("docker")) throw new Error("ENOENT");
      },
    });
    expect(await probeLocalBrowserHost(noDocker)).toMatchObject({ ok: false });
  });

  it("fails M1 and M2 Macs, which lack the nested virtualization the route needs, and passes M3 and later", async () => {
    const mac = (chip: string) =>
      probeLocalBrowserHost(
        probe({ platform: "darwin", arch: "arm64", macChip: async () => chip }),
      );
    expect(await mac("Apple M1 Pro\n")).toMatchObject({ ok: false });
    expect(await mac("Apple M2")).toMatchObject({ ok: false });
    expect(await mac("Apple M3 Max\n")).toEqual({ ok: true });
    expect(await mac("Apple M4")).toEqual({ ok: true });
    const unreadable = probe({
      platform: "darwin",
      arch: "arm64",
      macChip: async () => {
        throw new Error("sysctl failed");
      },
    });
    expect(await probeLocalBrowserHost(unreadable)).toMatchObject({ ok: false });
  });

  it("fails every other host shape", async () => {
    for (const [platform, arch] of [
      ["darwin", "x64"],
      ["linux", "arm64"],
      ["win32", "x64"],
    ] as const)
      expect(await probeLocalBrowserHost(probe({ platform, arch }))).toMatchObject({ ok: false });
  });
});
