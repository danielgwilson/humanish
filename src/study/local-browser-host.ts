// init's quick read of whether this host can run a local browser study, so its next steps never
// send someone to a route the host cannot run. It reads devices, `PATH` and the Mac chip name only;
// it starts no container and no VM. `doctor --study local-browser` runs the full check, including
// whether Docker is rootful and local.

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { LocalBrowserHost } from "../cli/first-run-path.js";

const exec = promisify(execFile);

export interface LocalBrowserHostProbe {
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  /** Resolves when `file` can be opened with `mode`; rejects otherwise. */
  access: (file: string, mode: number) => Promise<void>;
  /** The Mac's chip name, as `sysctl -n machdep.cpu.brand_string` prints it. */
  macChip: () => Promise<string>;
}

const defaultProbe = (): LocalBrowserHostProbe => ({
  platform: process.platform,
  arch: process.arch,
  env: process.env,
  access,
  macChip: async () =>
    (await exec("sysctl", ["-n", "machdep.cpu.brand_string"], { timeout: 5_000 })).stdout,
});

export async function probeLocalBrowserHost(
  probe: LocalBrowserHostProbe = defaultProbe(),
): Promise<LocalBrowserHost> {
  const can = async (file: string, mode: number) =>
    probe.access(file, mode).then(
      () => true,
      () => false,
    );
  if (probe.platform === "linux" && probe.arch === "x64") {
    // The same device checks doctor makes; the rootful Docker daemon opens them, not this user.
    if (!(await can("/dev/kvm", constants.F_OK)))
      return { ok: false, reason: "/dev/kvm is missing" };
    if (!(await can("/dev/net/tun", constants.F_OK)))
      return { ok: false, reason: "/dev/net/tun is missing" };
    const dirs = (probe.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    for (const dir of dirs)
      if (await can(path.join(dir, "docker"), constants.X_OK)) return { ok: true };
    return { ok: false, reason: "the docker command is not on the search path" };
  }
  if (probe.platform === "darwin" && probe.arch === "arm64") {
    // The local route needs nested virtualization, which Apple added with the M3.
    const chip = await probe.macChip().catch(() => "");
    const generation = /^Apple M(\d+)/.exec(chip.trim());
    if (generation !== null && Number(generation[1]) >= 3) return { ok: true };
    return { ok: false, reason: "they need an M3 or newer Mac" };
  }
  return { ok: false, reason: "they need Linux x64 or an M3-or-newer Mac" };
}
